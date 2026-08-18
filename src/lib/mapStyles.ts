import * as Cesium from 'cesium'
import type { ImageryLayer, ImageryLayerCollection, ImageryProvider, ProviderViewModel } from 'cesium'

export interface MapStyleDefinition {
  id: string
  name: string
  tooltip: string
  iconUrl?: string
  isDefault: boolean
  create?: () => ImageryProvider | ImageryProvider[] | Promise<ImageryProvider | ImageryProvider[]>
}

const USABLE_CESIUM_NAMES = new Set([
  'ArcGIS World Imagery',
  'ArcGIS World Hillshade',
  'Esri World Ocean',
  'Open\u00adStreet\u00adMap',
  'Natural Earth\u00a0II',
])

const WARMUP_REQUEST_BUDGET = 28
const providerPromiseCache = new Map<string, Promise<ImageryProvider | ImageryProvider[]>>()
const stableId = (name: string) => name.toLowerCase().replace(/[\u00ad\u00a0]/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const transitionMarker = Symbol.for('human-space-atlas.imagery-crossfade-v2')

type TransitionState = {
  oldLayer: ImageryLayer
  oldAlpha: number
  newLayers: ImageryLayer[]
  insertIndex: number
  fallbackTimer: number | null
  frame: number | null
  startedAt: number | null
}

type StreamingCollection = ImageryLayerCollection & {
  __hsaBaseTransition?: TransitionState | null
}

function providerLooksLikeOverlay(layer: ImageryLayer): boolean {
  const provider = layer.imageryProvider as {
    layers?: string
    _layers?: string
    url?: string
    _resource?: { url?: string }
  } | null
  const layers = String(provider?.layers ?? provider?._layers ?? '').toLowerCase()
  const url = String(provider?.url ?? provider?._resource?.url ?? '').toLowerCase()
  return layers.includes('cloud')
    || layers.includes('daynight')
    || layers.includes('night_lights')
    || url.includes('gibs.earthdata.nasa.gov')
}

/**
 * Legacy Globe code swaps the layer at index 0 synchronously. Intercept only
 * that base-layer remove/add pair and turn it into an actual crossfade. NASA
 * overlays and other higher layers are explicitly excluded from this hook.
 */
function installBaseLayerCrossfade(): void {
  if (typeof window === 'undefined' || typeof requestAnimationFrame === 'undefined') return
  const prototype = Cesium.ImageryLayerCollection.prototype as typeof Cesium.ImageryLayerCollection.prototype & { [transitionMarker]?: boolean }
  if (prototype[transitionMarker]) return
  prototype[transitionMarker] = true

  const originalRemove = prototype.remove
  const originalAddImageryProvider = prototype.addImageryProvider
  const finishTransition = (collection: StreamingCollection) => {
    const transition = collection.__hsaBaseTransition
    if (!transition) return
    if (transition.fallbackTimer !== null) window.clearTimeout(transition.fallbackTimer)
    if (transition.frame !== null) cancelAnimationFrame(transition.frame)
    for (const layer of transition.newLayers) layer.alpha = 1
    if (collection.contains(transition.oldLayer)) originalRemove.call(collection, transition.oldLayer, false)
    collection.__hsaBaseTransition = null
  }

  prototype.remove = function removeWithCrossfade(this: StreamingCollection, layer: ImageryLayer, destroy = true): boolean {
    const index = this.indexOf(layer)
    const eligible = destroy === false && index === 0 && !providerLooksLikeOverlay(layer)
    if (!eligible) return originalRemove.call(this, layer, destroy)

    finishTransition(this)
    const transition: TransitionState = {
      oldLayer: layer,
      oldAlpha: layer.alpha,
      newLayers: [],
      insertIndex: 0,
      fallbackTimer: null,
      frame: null,
      startedAt: null,
    }
    transition.fallbackTimer = window.setTimeout(() => {
      if (this.__hsaBaseTransition !== transition) return
      originalRemove.call(this, layer, false)
      this.__hsaBaseTransition = null
    }, 500)
    this.__hsaBaseTransition = transition
    return true
  }

  prototype.addImageryProvider = function addWithCrossfade(this: StreamingCollection, provider: ImageryProvider, index?: number): ImageryLayer {
    const transition = this.__hsaBaseTransition
    if (!transition || index !== undefined) return originalAddImageryProvider.call(this, provider, index)

    const layer = originalAddImageryProvider.call(this, provider, transition.insertIndex)
    transition.insertIndex += 1
    transition.newLayers.push(layer)
    layer.alpha = 0
    if (transition.fallbackTimer !== null) {
      window.clearTimeout(transition.fallbackTimer)
      transition.fallbackTimer = null
    }

    if (transition.frame === null) {
      transition.frame = requestAnimationFrame((startedAt) => {
        if (this.__hsaBaseTransition !== transition) return
        transition.startedAt = startedAt
        const duration = 420
        const animate = (now: number) => {
          if (this.__hsaBaseTransition !== transition) return
          const raw = Math.min(1, Math.max(0, (now - (transition.startedAt ?? now)) / duration))
          const eased = raw * raw * (3 - 2 * raw)
          transition.oldLayer.alpha = transition.oldAlpha * (1 - eased)
          for (const next of transition.newLayers) next.alpha = eased
          if (raw < 1) {
            transition.frame = requestAnimationFrame(animate)
            return
          }
          transition.frame = null
          if (this.contains(transition.oldLayer)) originalRemove.call(this, transition.oldLayer, false)
          transition.oldLayer.alpha = transition.oldAlpha
          this.__hsaBaseTransition = null
        }
        transition.frame = requestAnimationFrame(animate)
      })
    }
    return layer
  }
}

installBaseLayerCrossfade()

/**
 * Keep warm-up conservative on limited devices/data-saver connections, while
 * desktop machines can afford one extra ancestor level before a style swap.
 */
export function imageryWarmupMaxLevel(): number {
  if (typeof navigator === 'undefined') return 1
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection
  if (connection?.saveData || connection?.effectiveType === '2g' || connection?.effectiveType === 'slow-2g') return 0
  const deviceMemory = Number((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4)
  const cores = Number(navigator.hardwareConcurrency ?? 4)
  return deviceMemory >= 8 && cores >= 8 ? 2 : 1
}

/**
 * Preload coarse imagery ancestors before a provider is handed to the globe.
 * This gives Cesium complete low-resolution coverage to display while the
 * visible high-resolution descendants stream in, preventing tile-sized holes.
 */
export async function warmImageryProvider(provider: ImageryProvider, maxLevel = imageryWarmupMaxLevel()): Promise<ImageryProvider> {
  const tasks: Promise<unknown>[] = []
  const tilingScheme = provider.tilingScheme
  let budget = WARMUP_REQUEST_BUDGET

  for (let level = 0; level <= maxLevel && budget > 0; level += 1) {
    const columns = tilingScheme.getNumberOfXTilesAtLevel(level)
    const rows = tilingScheme.getNumberOfYTilesAtLevel(level)
    const centerX = Math.floor(columns / 2)
    const centerY = Math.floor(rows / 2)
    const coordinates: Array<[number, number]> = []
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < columns; x += 1) coordinates.push([x, y])
    }
    coordinates.sort((left, right) => {
      const leftDistance = Math.abs(left[0] - centerX) + Math.abs(left[1] - centerY)
      const rightDistance = Math.abs(right[0] - centerX) + Math.abs(right[1] - centerY)
      return leftDistance - rightDistance
    })

    for (const [x, y] of coordinates) {
      if (budget <= 0) break
      try {
        const request = provider.requestImage(x, y, level)
        if (request) {
          tasks.push(Promise.resolve(request).catch(() => undefined))
          budget -= 1
        }
      } catch {
        // Provider throttling is expected under load; Cesium will request the
        // tile again after the layer is attached.
      }
    }
  }

  if (tasks.length > 0) await Promise.allSettled(tasks)
  return provider
}

async function warmCreatedProviders(
  created: ImageryProvider | ImageryProvider[] | Promise<ImageryProvider | ImageryProvider[]>,
): Promise<ImageryProvider | ImageryProvider[]> {
  const resolved = await created
  if (Array.isArray(resolved)) {
    await Promise.all(resolved.map((provider) => warmImageryProvider(provider)))
    return resolved
  }
  return warmImageryProvider(resolved)
}

function cachedWarmedCreation(
  id: string,
  command: (() => ImageryProvider | ImageryProvider[] | Promise<ImageryProvider | ImageryProvider[]>) | undefined,
): (() => Promise<ImageryProvider | ImageryProvider[]>) | undefined {
  if (!command) return undefined
  return () => {
    const existing = providerPromiseCache.get(id)
    if (existing) return existing
    const pending = warmCreatedProviders(command())
    providerPromiseCache.set(id, pending)
    pending.catch(() => providerPromiseCache.delete(id))
    return pending
  }
}

export function clearImageryProviderCacheForTests(): void {
  providerPromiseCache.clear()
}

export function discoverMapStyles(): MapStyleDefinition[] {
  const discover = (Cesium as typeof Cesium & { createDefaultImageryProviderViewModels?: () => ProviderViewModel[] }).createDefaultImageryProviderViewModels
  if (!discover) return [{ id: 'satellite', name: 'Satellite', tooltip: 'Human Space Atlas default satellite imagery', isDefault: true }]
  const models = discover()
  const satelliteModel = models.find((model) => model.name === 'ArcGIS World Imagery')
  const satelliteCommand = satelliteModel?.creationCommand as unknown as (() => ImageryProvider | ImageryProvider[] | Promise<ImageryProvider | ImageryProvider[]>) | undefined
  return [
    { id: 'satellite', name: 'Satellite', tooltip: 'Human Space Atlas default satellite imagery', isDefault: true, create: cachedWarmedCreation('satellite', satelliteCommand) },
    ...models.filter((model) => USABLE_CESIUM_NAMES.has(model.name)).map((model) => {
      const id = stableId(model.name)
      const command = model.creationCommand as unknown as () => ImageryProvider | ImageryProvider[] | Promise<ImageryProvider | ImageryProvider[]>
      return {
        id,
        name: model.name.replace(/[\u00ad\u00a0]/g, ' '),
        tooltip: model.tooltip,
        iconUrl: model.iconUrl,
        isDefault: false,
        create: cachedWarmedCreation(id, command),
      }
    }),
  ]
}
