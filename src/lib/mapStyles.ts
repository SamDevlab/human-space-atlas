import * as Cesium from 'cesium'
import type { ImageryProvider, ProviderViewModel } from 'cesium'

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

/**
 * Keep warm-up conservative on limited devices/data-saver connections, while
 * desktop machines can afford one extra ancestor level before a style swap.
 *
 * This module intentionally does not patch Cesium prototypes. A previous
 * crossfade experiment intercepted ImageryLayerCollection.add/remove globally;
 * concurrent tile refinement could then observe a collection in a transient
 * inconsistent state and occasionally stop rendering with an Invalid array
 * length RangeError. Base-layer swaps are now left to Cesium's own collection
 * semantics, while warm-up still prevents most visible blank tiles.
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
 * Requests are explicitly bounded to avoid large coordinate arrays or request
 * bursts on providers with unusual tiling schemes.
 */
export async function warmImageryProvider(provider: ImageryProvider, maxLevel = imageryWarmupMaxLevel()): Promise<ImageryProvider> {
  const tasks: Promise<unknown>[] = []
  const tilingScheme = provider.tilingScheme
  let budget = WARMUP_REQUEST_BUDGET

  for (let level = 0; level <= maxLevel && budget > 0; level += 1) {
    const columns = tilingScheme.getNumberOfXTilesAtLevel(level)
    const rows = tilingScheme.getNumberOfYTilesAtLevel(level)
    if (!Number.isFinite(columns) || !Number.isFinite(rows) || columns <= 0 || rows <= 0) break

    const centerX = Math.floor(columns / 2)
    const centerY = Math.floor(rows / 2)
    const radius = Math.max(1, Math.ceil(Math.sqrt(WARMUP_REQUEST_BUDGET)))
    const coordinates: Array<[number, number]> = []

    for (let dy = -radius; dy <= radius && coordinates.length < WARMUP_REQUEST_BUDGET * 2; dy += 1) {
      for (let dx = -radius; dx <= radius && coordinates.length < WARMUP_REQUEST_BUDGET * 2; dx += 1) {
        const x = centerX + dx
        const y = centerY + dy
        if (x < 0 || y < 0 || x >= columns || y >= rows) continue
        coordinates.push([x, y])
      }
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
        // Provider throttling is expected under load; Cesium will retry after
        // the provider is attached to the globe.
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
