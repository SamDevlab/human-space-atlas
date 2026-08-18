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

const stableId = (name: string) => name.toLowerCase().replace(/[\u00ad\u00a0]/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/**
 * Preload the two coarsest imagery levels before a provider is handed to the
 * globe. Cesium can then keep a complete low-resolution ancestor underneath
 * finer requests instead of exposing temporary tile-sized gaps while the
 * camera is moving or a map style is being replaced.
 */
async function warmImageryProvider(provider: ImageryProvider): Promise<ImageryProvider> {
  const tasks: Promise<unknown>[] = []
  const tilingScheme = provider.tilingScheme

  for (let level = 0; level <= 1; level += 1) {
    const columns = tilingScheme.getNumberOfXTilesAtLevel(level)
    const rows = tilingScheme.getNumberOfYTilesAtLevel(level)
    for (let x = 0; x < columns; x += 1) {
      for (let y = 0; y < rows; y += 1) {
        try {
          const request = provider.requestImage(x, y, level)
          if (request) tasks.push(Promise.resolve(request).catch(() => undefined))
        } catch {
          // A provider can throttle individual requests. Cesium will retry the
          // tile normally after the layer is attached to the globe.
        }
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

function warmedCreation(
  command: (() => ImageryProvider | ImageryProvider[] | Promise<ImageryProvider | ImageryProvider[]>) | undefined,
): (() => Promise<ImageryProvider | ImageryProvider[]>) | undefined {
  return command ? () => warmCreatedProviders(command()) : undefined
}

export function discoverMapStyles(): MapStyleDefinition[] {
  const discover = (Cesium as typeof Cesium & { createDefaultImageryProviderViewModels?: () => ProviderViewModel[] }).createDefaultImageryProviderViewModels
  if (!discover) return [{ id: 'satellite', name: 'Satellite', tooltip: 'Human Space Atlas default satellite imagery', isDefault: true }]
  const models = discover()
  const satelliteModel = models.find((model) => model.name === 'ArcGIS World Imagery')
  const satelliteCommand = satelliteModel?.creationCommand as unknown as (() => ImageryProvider | ImageryProvider[] | Promise<ImageryProvider | ImageryProvider[]>) | undefined
  return [
    { id: 'satellite', name: 'Satellite', tooltip: 'Human Space Atlas default satellite imagery', isDefault: true, create: warmedCreation(satelliteCommand) },
    ...models.filter((model) => USABLE_CESIUM_NAMES.has(model.name)).map((model) => {
      const command = model.creationCommand as unknown as () => ImageryProvider | ImageryProvider[] | Promise<ImageryProvider | ImageryProvider[]>
      return {
        id: stableId(model.name),
        name: model.name.replace(/[\u00ad\u00a0]/g, ' '),
        tooltip: model.tooltip,
        iconUrl: model.iconUrl,
        isDefault: false,
        create: warmedCreation(command),
      }
    }),
  ]
}
