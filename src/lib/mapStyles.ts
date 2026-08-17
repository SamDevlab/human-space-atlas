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

export function discoverMapStyles(): MapStyleDefinition[] {
  const discover = (Cesium as typeof Cesium & { createDefaultImageryProviderViewModels?: () => ProviderViewModel[] }).createDefaultImageryProviderViewModels
  if (!discover) return [{ id: 'satellite', name: 'Satellite', tooltip: 'Human Space Atlas default satellite imagery', isDefault: true }]
  const models = discover()
  const satelliteModel = models.find((model) => model.name === 'ArcGIS World Imagery')
  const satelliteCreate = satelliteModel?.creationCommand as unknown as (() => ImageryProvider | ImageryProvider[] | Promise<ImageryProvider | ImageryProvider[]>) | undefined
  return [
    { id: 'satellite', name: 'Satellite', tooltip: 'Human Space Atlas default satellite imagery', isDefault: true, create: satelliteCreate },
    ...models.filter((model) => USABLE_CESIUM_NAMES.has(model.name)).map((model) => ({
      id: stableId(model.name),
      name: model.name.replace(/[\u00ad\u00a0]/g, ' '),
      tooltip: model.tooltip,
      iconUrl: model.iconUrl,
      isDefault: false,
      create: () => (model.creationCommand as unknown as () => ImageryProvider | ImageryProvider[] | Promise<ImageryProvider | ImageryProvider[]>)(),
    })),
  ]
}
