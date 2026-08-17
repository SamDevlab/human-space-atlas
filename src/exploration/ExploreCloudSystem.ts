import * as Cesium from 'cesium'
import {
  Cartesian2,
  Cartesian3,
  Color,
  ImageryLayer,
  Viewer,
} from 'cesium'
import {
  createNasaCloudProvider,
  NASA_GIBS_CLOUD_OBSERVATION_DATE,
  preloadNasaCloudTexture,
} from '../lib/earthLayers'

const CLOUD_COLLECTION_NOISE_DETAIL = 20
const CLOUD_REGION_STEP_DEGREES = 2.4
const CLOUD_REGION_REBUILD_DEGREES = 3.2
const CLOUD_REGION_MAX_RADIUS_DEGREES = 16
const CLOUD_REGION_MIN_RADIUS_DEGREES = 7
const CLOUD_MAX_COUNT = 240
const CLOUD_ALPHA_REFERENCE = 0.48
const CLOUD_VOLUME_FULL_BELOW_METERS = 180_000
const CLOUD_VOLUME_OFF_ABOVE_METERS = 300_000
const CLOUD_FAR_FIELD_MAX_ALPHA = 1

export const EXPLORE_CLOUD_DISCLOSURE = 'NASA observed cloud field · cinematic 3D reconstruction'

export type ExploreCloudSeed = {
  longitudeDeg: number
  latitudeDeg: number
  altitudeMeters: number
  scaleX: number
  scaleY: number
  depthMeters: number
  slice: number
  brightness: number
  alpha: number
}

export type CloudAlphaSampler = (longitudeDeg: number, latitudeDeg: number) => number

type CloudCollectionLike = {
  show: boolean
  add: (options: {
    position: Cartesian3
    scale: Cartesian2
    maximumSize: Cartesian3
    slice: number
    brightness: number
    color: Color
  }) => unknown
  removeAll: () => void
}

type CloudCollectionConstructor = new (options?: {
  noiseDetail?: number
  noiseOffset?: Cartesian3
}) => CloudCollectionLike

// CloudCollection is part of the public Cesium runtime API. Access it through
// the namespace here so this module remains compatible with the package's
// generated declaration layout across Cesium minor releases.
const CloudCollectionCtor = (Cesium as unknown as { CloudCollection: CloudCollectionConstructor }).CloudCollection

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function smoothstep01(value: number): number {
  const clamped = clamp(value, 0, 1)
  return clamped * clamped * (3 - 2 * clamped)
}

function hash01(x: number, y: number): number {
  const value = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123
  return value - Math.floor(value)
}

export function wrapCloudLongitude(longitudeDeg: number): number {
  return ((longitudeDeg + 180) % 360 + 360) % 360 - 180
}

/**
 * Cinematic volumes are a low-orbit detail layer, not the global cloud map.
 * They stay fully visible below 180 km and fade out by 300 km. This prevents
 * the isolated "snowball" look that appears when individual CumulusCloud
 * volumes are viewed from hundreds of kilometres away.
 */
export function exploreCloudVolumeFade(cameraHeightMeters: number): number {
  const range = CLOUD_VOLUME_OFF_ABOVE_METERS - CLOUD_VOLUME_FULL_BELOW_METERS
  return 1 - smoothstep01((cameraHeightMeters - CLOUD_VOLUME_FULL_BELOW_METERS) / range)
}

/**
 * The NASA-derived 2D field is the far-orbit representation. It crossfades
 * inversely with the local 3D reconstruction so the Explore camera sees one
 * continuous weather system instead of either a flat decal or floating dots.
 */
export function exploreCloudMapFade(cameraHeightMeters: number): number {
  const range = CLOUD_VOLUME_OFF_ABOVE_METERS - CLOUD_VOLUME_FULL_BELOW_METERS
  return smoothstep01((cameraHeightMeters - CLOUD_VOLUME_FULL_BELOW_METERS) / range)
}

export function exploreCloudRadiusDegrees(cameraHeightMeters: number): number {
  return clamp(7 + cameraHeightMeters / 80_000, CLOUD_REGION_MIN_RADIUS_DEGREES, CLOUD_REGION_MAX_RADIUS_DEGREES)
}

export function createCanvasCloudAlphaSampler(texture: HTMLCanvasElement): CloudAlphaSampler {
  const context = texture.getContext('2d', { willReadFrequently: true })
  if (!context || texture.width <= 0 || texture.height <= 0) return () => 0
  const pixels = context.getImageData(0, 0, texture.width, texture.height).data
  return (longitudeDeg, latitudeDeg) => {
    const longitude = wrapCloudLongitude(longitudeDeg)
    const latitude = clamp(latitudeDeg, -89.999, 89.999)
    const x = Math.min(texture.width - 1, Math.max(0, Math.floor((longitude + 180) / 360 * texture.width)))
    const y = Math.min(texture.height - 1, Math.max(0, Math.floor((90 - latitude) / 180 * texture.height)))
    return pixels[(y * texture.width + x) * 4 + 3] / 255
  }
}

function localCloudCoverage(sampleAlpha: CloudAlphaSampler, longitudeDeg: number, latitudeDeg: number): number {
  let coverage = 0
  const offsets = [
    [0, 0],
    [-0.7, 0],
    [0.7, 0],
    [0, -0.7],
    [0, 0.7],
    [-0.48, -0.48],
    [0.48, 0.48],
    [-0.48, 0.48],
    [0.48, -0.48],
  ] as const
  for (const [longitudeOffset, latitudeOffset] of offsets) {
    coverage = Math.max(coverage, sampleAlpha(longitudeDeg + longitudeOffset, latitudeDeg + latitudeOffset))
  }
  return clamp(coverage / CLOUD_ALPHA_REFERENCE, 0, 1)
}

/**
 * Convert the observed NASA mask into broad, overlapping cloud banks.
 * A coarser geographic grid plus several overlapping lobes per strong cell
 * reads as fronts/systems from low orbit instead of hundreds of tiny dots.
 */
export function createExploreCloudSeeds(
  centerLongitudeDeg: number,
  centerLatitudeDeg: number,
  radiusDegrees: number,
  sampleAlpha: CloudAlphaSampler,
  maxClouds = CLOUD_MAX_COUNT,
): ExploreCloudSeed[] {
  const seeds: ExploreCloudSeed[] = []
  const minLatitude = clamp(centerLatitudeDeg - radiusDegrees, -82, 82)
  const maxLatitude = clamp(centerLatitudeDeg + radiusDegrees, -82, 82)
  const startLatitude = Math.floor(minLatitude / CLOUD_REGION_STEP_DEGREES) * CLOUD_REGION_STEP_DEGREES
  const endLatitude = Math.ceil(maxLatitude / CLOUD_REGION_STEP_DEGREES) * CLOUD_REGION_STEP_DEGREES
  const startLongitude = Math.floor((centerLongitudeDeg - radiusDegrees) / CLOUD_REGION_STEP_DEGREES) * CLOUD_REGION_STEP_DEGREES
  const endLongitude = Math.ceil((centerLongitudeDeg + radiusDegrees) / CLOUD_REGION_STEP_DEGREES) * CLOUD_REGION_STEP_DEGREES

  for (let latitude = startLatitude; latitude <= endLatitude && seeds.length < maxClouds; latitude += CLOUD_REGION_STEP_DEGREES) {
    if (latitude < -82 || latitude > 82) continue
    for (let longitude = startLongitude; longitude <= endLongitude && seeds.length < maxClouds; longitude += CLOUD_REGION_STEP_DEGREES) {
      const wrappedLongitude = wrapCloudLongitude(longitude)
      const coverage = localCloudCoverage(sampleAlpha, wrappedLongitude, latitude)
      if (coverage < 0.12) continue

      const cellX = Math.round(wrappedLongitude / CLOUD_REGION_STEP_DEGREES)
      const cellY = Math.round(latitude / CLOUD_REGION_STEP_DEGREES)
      const keepChance = clamp(0.12 + coverage * 0.82, 0, 0.9)
      if (hash01(cellX + 17, cellY + 29) > keepChance) continue

      const clusterCount = coverage > 0.74 ? 4 : coverage > 0.42 ? 3 : 2
      const latitudeCosine = Math.max(0.28, Math.cos(latitude * Math.PI / 180))
      for (let clusterIndex = 0; clusterIndex < clusterCount && seeds.length < maxClouds; clusterIndex += 1) {
        const jitterX = hash01(cellX * 13 + clusterIndex * 7 + 3, cellY * 11 + 5) - 0.5
        const jitterY = hash01(cellX * 17 + 9, cellY * 19 + clusterIndex * 13 + 7) - 0.5
        // Keep lobes close enough to overlap. This makes each observed cell a
        // cloud bank rather than a collection of unrelated points.
        const longitudeJitter = jitterX * CLOUD_REGION_STEP_DEGREES * 0.42 / latitudeCosine
        const latitudeJitter = jitterY * CLOUD_REGION_STEP_DEGREES * 0.36
        const shapeNoise = hash01(cellX * 23 + clusterIndex * 31 + 11, cellY * 29 + 17)
        const heightNoise = hash01(cellX * 37 + 19, cellY * 41 + clusterIndex * 43 + 23)
        const aspectNoise = hash01(cellX * 47 + clusterIndex * 53 + 29, cellY * 59 + 31)

        // Broad macro-scale lobes are intentional: at 120–250 km the camera
        // reads them as continuous weather systems with parallax, while the
        // NASA mask still determines where those systems may exist.
        const horizontalBase = 72_000 + coverage * 155_000
        const scaleX = horizontalBase * (0.82 + shapeNoise * 0.38)
        const scaleY = scaleX * (0.58 + aspectNoise * 0.3)
        const baseAltitude = 1_600 + heightNoise * 4_200
        const depthMeters = 5_000 + coverage * 9_500 + shapeNoise * 3_500
        const altitudeMeters = baseAltitude + depthMeters * 0.5

        seeds.push({
          longitudeDeg: wrapCloudLongitude(wrappedLongitude + longitudeJitter),
          latitudeDeg: clamp(latitude + latitudeJitter, -82, 82),
          altitudeMeters,
          scaleX,
          scaleY,
          depthMeters,
          slice: 0.42 + hash01(cellX * 61 + clusterIndex * 67 + 37, cellY * 71 + 41) * 0.18,
          brightness: 0.78 + coverage * 0.2 + heightNoise * 0.06,
          alpha: clamp(0.42 + coverage * 0.52, 0.42, 0.96),
        })
      }
    }
  }

  return seeds
}

function angularDistanceDegrees(left: number, right: number): number {
  return Math.abs(wrapCloudLongitude(left - right))
}

export class ExploreCloudSystem {
  private readonly viewer: Viewer
  private collection: CloudCollectionLike | null = null
  private farFieldLayer: ImageryLayer | null = null
  private sampleAlpha: CloudAlphaSampler | null = null
  private running = false
  private destroyed = false
  private loadGeneration = 0
  private opacity = 0.72
  private lastLongitudeDeg: number | null = null
  private lastLatitudeDeg: number | null = null
  private lastAltitudeBucket = -1
  private lastVolumeFade = -1
  private readonly onPreRender = () => this.update()

  constructor(viewer: Viewer) {
    this.viewer = viewer
  }

  async start(opacity = 0.72): Promise<void> {
    this.opacity = clamp(opacity, 0, 1)
    if (this.destroyed || this.viewer.isDestroyed()) return
    const generation = ++this.loadGeneration

    if (!this.collection) {
      this.collection = this.viewer.scene.primitives.add(new CloudCollectionCtor({
        noiseDetail: CLOUD_COLLECTION_NOISE_DETAIL,
        noiseOffset: new Cartesian3(13.7, 4.2, 27.4),
      })) as CloudCollectionLike
      this.collection.show = false
    }

    if (!this.sampleAlpha || !this.farFieldLayer) {
      const texture = await preloadNasaCloudTexture()
      if (this.destroyed || generation !== this.loadGeneration || this.viewer.isDestroyed()) return
      this.sampleAlpha = createCanvasCloudAlphaSampler(texture)

      if (!this.farFieldLayer) {
        const provider = await createNasaCloudProvider(NASA_GIBS_CLOUD_OBSERVATION_DATE, texture)
        if (this.destroyed || generation !== this.loadGeneration || this.viewer.isDestroyed()) return
        const layer = this.viewer.imageryLayers.addImageryProvider(provider)
        layer.alpha = 0
        layer.brightness = 1.12
        layer.contrast = 1.18
        layer.saturation = 0.88
        layer.show = false
        this.viewer.imageryLayers.raiseToTop(layer)
        this.farFieldLayer = layer
      }
    }

    if (!this.running) {
      this.running = true
      this.viewer.scene.preRender.addEventListener(this.onPreRender)
    }
    this.rebuild(true)
    this.viewer.scene.requestRender()
  }

  setOpacity(opacity: number): void {
    const nextOpacity = clamp(opacity, 0, 1)
    if (Math.abs(nextOpacity - this.opacity) < 0.01) return
    this.opacity = nextOpacity
    this.rebuild(true)
  }

  stop(): void {
    this.loadGeneration += 1
    if (this.running && !this.viewer.isDestroyed()) this.viewer.scene.preRender.removeEventListener(this.onPreRender)
    this.running = false
    if (this.collection) {
      this.collection.show = false
      this.collection.removeAll()
    }
    if (this.farFieldLayer && !this.viewer.isDestroyed()) {
      this.viewer.imageryLayers.remove(this.farFieldLayer, false)
    }
    this.farFieldLayer = null
    this.lastLongitudeDeg = null
    this.lastLatitudeDeg = null
    this.lastAltitudeBucket = -1
    this.lastVolumeFade = -1
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.stop()
    if (this.collection && !this.viewer.isDestroyed()) this.viewer.scene.primitives.remove(this.collection)
    this.collection = null
    this.sampleAlpha = null
  }

  private update(): void {
    if (!this.running || !this.collection || !this.sampleAlpha || this.viewer.isDestroyed()) return
    const cartographic = this.viewer.camera.positionCartographic
    const longitudeDeg = cartographic.longitude * 180 / Math.PI
    const latitudeDeg = cartographic.latitude * 180 / Math.PI
    const altitudeMeters = Math.max(0, cartographic.height)
    const volumeFade = exploreCloudVolumeFade(altitudeMeters)
    const mapFade = exploreCloudMapFade(altitudeMeters)

    if (this.farFieldLayer) {
      this.farFieldLayer.alpha = clamp(this.opacity * 1.12 * mapFade * CLOUD_FAR_FIELD_MAX_ALPHA, 0, CLOUD_FAR_FIELD_MAX_ALPHA)
      this.farFieldLayer.show = mapFade > 0.01 && this.farFieldLayer.alpha > 0.005
    }

    this.collection.show = volumeFade > 0.015
    if (!this.collection.show) return

    const altitudeBucket = Math.floor(altitudeMeters / 60_000)
    const movedFarEnough = this.lastLongitudeDeg === null
      || this.lastLatitudeDeg === null
      || angularDistanceDegrees(longitudeDeg, this.lastLongitudeDeg) >= CLOUD_REGION_REBUILD_DEGREES
      || Math.abs(latitudeDeg - this.lastLatitudeDeg) >= CLOUD_REGION_REBUILD_DEGREES
    const fadeChanged = this.lastVolumeFade < 0 || Math.abs(volumeFade - this.lastVolumeFade) >= 0.1
    if (movedFarEnough || altitudeBucket !== this.lastAltitudeBucket || fadeChanged) this.rebuild(false)
  }

  private rebuild(force: boolean): void {
    if (!this.collection || !this.sampleAlpha || this.viewer.isDestroyed()) return
    const cartographic = this.viewer.camera.positionCartographic
    const longitudeDeg = cartographic.longitude * 180 / Math.PI
    const latitudeDeg = cartographic.latitude * 180 / Math.PI
    const altitudeMeters = Math.max(0, cartographic.height)
    const volumeFade = exploreCloudVolumeFade(altitudeMeters)
    const mapFade = exploreCloudMapFade(altitudeMeters)

    if (this.farFieldLayer) {
      this.farFieldLayer.alpha = clamp(this.opacity * 1.12 * mapFade * CLOUD_FAR_FIELD_MAX_ALPHA, 0, CLOUD_FAR_FIELD_MAX_ALPHA)
      this.farFieldLayer.show = mapFade > 0.01 && this.farFieldLayer.alpha > 0.005
    }

    if (volumeFade <= 0.015) {
      this.collection.show = false
      this.collection.removeAll()
      this.lastLongitudeDeg = longitudeDeg
      this.lastLatitudeDeg = latitudeDeg
      this.lastAltitudeBucket = Math.floor(altitudeMeters / 60_000)
      this.lastVolumeFade = volumeFade
      this.viewer.scene.requestRender()
      return
    }

    const radiusDegrees = exploreCloudRadiusDegrees(altitudeMeters)
    const seeds = createExploreCloudSeeds(longitudeDeg, latitudeDeg, radiusDegrees, this.sampleAlpha)
    this.collection.removeAll()

    const renderedAlpha = clamp(this.opacity * 1.18 * volumeFade, 0, 1)
    for (const seed of seeds) {
      this.collection.add({
        position: Cartesian3.fromDegrees(seed.longitudeDeg, seed.latitudeDeg, seed.altitudeMeters),
        scale: new Cartesian2(seed.scaleX, seed.scaleY),
        maximumSize: new Cartesian3(seed.scaleX, seed.scaleY, seed.depthMeters),
        slice: seed.slice,
        brightness: seed.brightness,
        color: Color.fromCssColorString('#f7fbff').withAlpha(clamp(seed.alpha * renderedAlpha, 0, 0.96)),
      })
    }

    this.collection.show = seeds.length > 0 && volumeFade > 0.015
    this.lastLongitudeDeg = longitudeDeg
    this.lastLatitudeDeg = latitudeDeg
    this.lastAltitudeBucket = Math.floor(altitudeMeters / 60_000)
    this.lastVolumeFade = volumeFade
    this.viewer.scene.requestRender()
  }
}
