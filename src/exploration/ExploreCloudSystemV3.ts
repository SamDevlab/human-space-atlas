import * as Cesium from 'cesium'
import { Cartesian2, Cartesian3, Color, ImageryLayer, Viewer } from 'cesium'
import {
  createNasaCloudProvider,
  NASA_GIBS_CLOUD_OBSERVATION_DATE,
  preloadNasaCloudTexture,
} from '../lib/earthLayers'
import {
  preloadNasaCloudTopHeightSampler,
  type CloudTopHeightSampler,
} from './NasaCloudTopHeightField'
import {
  opticalThicknessDensity,
  preloadNasaCloudOpticalThicknessSampler,
  type CloudOpticalThicknessSampler,
} from './NasaCloudOpticalThicknessField'
import { computeOrbitalLighting } from './OrbitalLighting'

const CLOUD_COLLECTION_NOISE_DETAIL = 20
const CLOUD_REGION_STEP_DEGREES = 2
const CLOUD_REGION_REBUILD_DEGREES = 2.8
const CLOUD_REGION_MAX_RADIUS_DEGREES = 14
const CLOUD_REGION_MIN_RADIUS_DEGREES = 7
const CLOUD_MAX_SEEDS = 110
const CLOUD_MAX_PARTS = 260
const CLOUD_ALPHA_REFERENCE = 0.48
const CLOUD_VOLUME_FULL_BELOW_METERS = 190_000
const CLOUD_VOLUME_OFF_ABOVE_METERS = 360_000
const CLOUD_MAP_START_METERS = 220_000
const CLOUD_MAP_FULL_ABOVE_METERS = 330_000
const CLOUD_FAR_FIELD_MAX_ALPHA = 1

export const EXPLORE_CLOUD_DISCLOSURE = 'NASA observed cloud field + cloud-top height + optical thickness · cinematic bounded 3D reconstruction'

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
  opticalThickness: number | null
  density: number
}

export type ExploreCloudVolumePart = {
  longitudeDeg: number
  latitudeDeg: number
  altitudeMeters: number
  scaleX: number
  scaleY: number
  depthMeters: number
  slice: number
  alphaScale: number
  brightnessScale: number
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

const CloudCollectionCtor = (Cesium as unknown as { CloudCollection: CloudCollectionConstructor }).CloudCollection

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function smoothstep01(value: number): number {
  const clamped = clamp(value, 0, 1)
  return clamped * clamped * (3 - 2 * clamped)
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

function hash01(x: number, y: number): number {
  const value = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123
  return value - Math.floor(value)
}

export function wrapCloudLongitude(longitudeDeg: number): number {
  if (!Number.isFinite(longitudeDeg)) return 0
  return ((longitudeDeg + 180) % 360 + 360) % 360 - 180
}

export function exploreCloudVolumeFade(cameraHeightMeters: number): number {
  const safeHeight = Math.max(0, finite(cameraHeightMeters, CLOUD_VOLUME_OFF_ABOVE_METERS))
  const range = CLOUD_VOLUME_OFF_ABOVE_METERS - CLOUD_VOLUME_FULL_BELOW_METERS
  return 1 - smoothstep01((safeHeight - CLOUD_VOLUME_FULL_BELOW_METERS) / range)
}

export function exploreCloudMapFade(cameraHeightMeters: number): number {
  const safeHeight = Math.max(0, finite(cameraHeightMeters, CLOUD_MAP_FULL_ABOVE_METERS))
  const range = CLOUD_MAP_FULL_ABOVE_METERS - CLOUD_MAP_START_METERS
  return smoothstep01((safeHeight - CLOUD_MAP_START_METERS) / range)
}

export function exploreCloudRadiusDegrees(cameraHeightMeters: number): number {
  const safeHeight = Math.max(0, finite(cameraHeightMeters, 200_000))
  return clamp(7 + safeHeight / 110_000, CLOUD_REGION_MIN_RADIUS_DEGREES, CLOUD_REGION_MAX_RADIUS_DEGREES)
}

/** Kept for API/test compatibility. Explore V3 shades clouds directly and no longer builds ellipse shadow geometry. */
export function cloudShadowOpacity(density: number, sunlight: number, opacity: number, volumeFade: number): number {
  const lit = smoothstep01((clamp(finite(sunlight, 0), 0, 1) - 0.08) / 0.72)
  const dense = smoothstep01((clamp(finite(density, 0), 0, 1) - 0.12) / 0.78)
  return clamp(finite(opacity, 0), 0, 1) * clamp(finite(volumeFade, 0), 0, 1) * lit * dense * 0.08
}

/** Compatibility helper retained for tests/documentation. */
export function cloudShadowOffsetMeters(cloudAltitudeMeters: number, sunElevationSin: number): number {
  const altitude = Math.max(0, finite(cloudAltitudeMeters, 0))
  const elevationSin = clamp(finite(sunElevationSin, 0), 0, 1)
  if (elevationSin <= 0.055) return 180_000
  const horizontal = Math.sqrt(Math.max(0, 1 - elevationSin * elevationSin))
  return clamp(altitude * horizontal / elevationSin, 0, 180_000)
}

export function createCanvasCloudAlphaSampler(texture: HTMLCanvasElement): CloudAlphaSampler {
  const context = texture.getContext('2d', { willReadFrequently: true })
  if (!context || texture.width <= 0 || texture.height <= 0) return () => 0
  const pixels = context.getImageData(0, 0, texture.width, texture.height).data
  return (longitudeDeg, latitudeDeg) => {
    const longitude = wrapCloudLongitude(longitudeDeg)
    const latitude = clamp(finite(latitudeDeg, 0), -89.999, 89.999)
    const x = Math.min(texture.width - 1, Math.max(0, Math.floor((longitude + 180) / 360 * texture.width)))
    const y = Math.min(texture.height - 1, Math.max(0, Math.floor((90 - latitude) / 180 * texture.height)))
    return pixels[(y * texture.width + x) * 4 + 3] / 255
  }
}

function localCloudCoverage(sampleAlpha: CloudAlphaSampler, longitudeDeg: number, latitudeDeg: number): number {
  let coverage = 0
  const offsets = [
    [0, 0], [-0.55, 0], [0.55, 0], [0, -0.55], [0, 0.55],
    [-0.38, -0.38], [0.38, 0.38], [-0.38, 0.38], [0.38, -0.38],
  ] as const
  for (const [longitudeOffset, latitudeOffset] of offsets) {
    const sample = finite(sampleAlpha(longitudeDeg + longitudeOffset, latitudeDeg + latitudeOffset), 0)
    coverage = Math.max(coverage, clamp(sample, 0, 1))
  }
  return clamp(coverage / CLOUD_ALPHA_REFERENCE, 0, 1)
}

export function createExploreCloudSeeds(
  centerLongitudeDeg: number,
  centerLatitudeDeg: number,
  radiusDegrees: number,
  sampleAlpha: CloudAlphaSampler,
  maxClouds = CLOUD_MAX_SEEDS,
  sampleCloudTopMeters: CloudTopHeightSampler | null = null,
  sampleOpticalThickness: CloudOpticalThicknessSampler | null = null,
): ExploreCloudSeed[] {
  const seeds: ExploreCloudSeed[] = []
  const safeCenterLongitude = wrapCloudLongitude(centerLongitudeDeg)
  const safeCenterLatitude = clamp(finite(centerLatitudeDeg, 0), -82, 82)
  const safeRadius = clamp(finite(radiusDegrees, 8), 1, CLOUD_REGION_MAX_RADIUS_DEGREES)
  const safeMaxClouds = Math.max(0, Math.min(CLOUD_MAX_SEEDS, Math.floor(finite(maxClouds, CLOUD_MAX_SEEDS))))
  if (safeMaxClouds === 0) return seeds

  const minLatitude = clamp(safeCenterLatitude - safeRadius, -82, 82)
  const maxLatitude = clamp(safeCenterLatitude + safeRadius, -82, 82)
  const startLatitude = Math.floor(minLatitude / CLOUD_REGION_STEP_DEGREES) * CLOUD_REGION_STEP_DEGREES
  const endLatitude = Math.ceil(maxLatitude / CLOUD_REGION_STEP_DEGREES) * CLOUD_REGION_STEP_DEGREES
  const startLongitude = Math.floor((safeCenterLongitude - safeRadius) / CLOUD_REGION_STEP_DEGREES) * CLOUD_REGION_STEP_DEGREES
  const endLongitude = Math.ceil((safeCenterLongitude + safeRadius) / CLOUD_REGION_STEP_DEGREES) * CLOUD_REGION_STEP_DEGREES

  for (let latitude = startLatitude; latitude <= endLatitude && seeds.length < safeMaxClouds; latitude += CLOUD_REGION_STEP_DEGREES) {
    if (latitude < -82 || latitude > 82) continue
    for (let longitude = startLongitude; longitude <= endLongitude && seeds.length < safeMaxClouds; longitude += CLOUD_REGION_STEP_DEGREES) {
      const wrappedLongitude = wrapCloudLongitude(longitude)
      const coverage = localCloudCoverage(sampleAlpha, wrappedLongitude, latitude)
      if (coverage < 0.12) continue

      const cellX = Math.round(wrappedLongitude / CLOUD_REGION_STEP_DEGREES)
      const cellY = Math.round(latitude / CLOUD_REGION_STEP_DEGREES)
      const keepChance = clamp(0.16 + coverage * 0.76, 0, 0.9)
      if (hash01(cellX + 17, cellY + 29) > keepChance) continue

      const latitudeCosine = Math.max(0.3, Math.cos(latitude * Math.PI / 180))
      const jitterX = hash01(cellX * 13 + 3, cellY * 11 + 5) - 0.5
      const jitterY = hash01(cellX * 17 + 9, cellY * 19 + 7) - 0.5
      const seedLongitude = wrapCloudLongitude(wrappedLongitude + jitterX * CLOUD_REGION_STEP_DEGREES * 0.5 / latitudeCosine)
      const seedLatitude = clamp(latitude + jitterY * CLOUD_REGION_STEP_DEGREES * 0.44, -82, 82)
      const shapeNoise = hash01(cellX * 23 + 11, cellY * 29 + 17)
      const heightNoise = hash01(cellX * 37 + 19, cellY * 41 + 23)
      const aspectNoise = hash01(cellX * 47 + 29, cellY * 59 + 31)
      const opticalThickness = sampleOpticalThickness?.(seedLongitude, seedLatitude) ?? null
      const observedDensity = opticalThicknessDensity(opticalThickness)
      const density = clamp(opticalThickness === null ? 0.28 + coverage * 0.62 : observedDensity, 0, 1)

      const horizontalBase = (42_000 + coverage * 104_000) * (0.94 + density * 0.1)
      const scaleX = clamp(horizontalBase * (0.86 + shapeNoise * 0.3), 32_000, 180_000)
      const scaleY = clamp(scaleX * (0.6 + aspectNoise * 0.25), 24_000, 150_000)
      const observedTopMeters = sampleCloudTopMeters?.(seedLongitude, seedLatitude) ?? null

      let depthMeters: number
      let altitudeMeters: number
      if (observedTopMeters !== null && Number.isFinite(observedTopMeters) && observedTopMeters >= 300 && observedTopMeters <= 20_000) {
        const desiredDepth = (1_400 + coverage * 3_200 + shapeNoise * 1_500) * (0.74 + density * 0.86)
        depthMeters = clamp(desiredDepth, 1_200, Math.min(12_000, Math.max(1_600, observedTopMeters * 0.84)))
        const baseMeters = Math.max(180, observedTopMeters - depthMeters)
        altitudeMeters = baseMeters + depthMeters * 0.5
      } else {
        const baseAltitude = 1_000 + heightNoise * 3_400
        depthMeters = clamp((2_600 + coverage * 5_200 + shapeNoise * 2_200) * (0.74 + density * 0.8), 1_400, 12_000)
        altitudeMeters = baseAltitude + depthMeters * 0.5
      }

      const seed: ExploreCloudSeed = {
        longitudeDeg: seedLongitude,
        latitudeDeg: seedLatitude,
        altitudeMeters: clamp(finite(altitudeMeters, 4_000), 180, 20_000),
        scaleX,
        scaleY,
        depthMeters: clamp(finite(depthMeters, 3_000), 800, 12_000),
        slice: clamp(0.34 + density * 0.18 + hash01(cellX * 61 + 37, cellY * 71 + 41) * 0.12, 0.32, 0.68),
        brightness: clamp(0.84 + coverage * 0.1 + (1 - density) * 0.06 + heightNoise * 0.04, 0.8, 1.06),
        alpha: clamp(0.36 + coverage * 0.31 + density * 0.38, 0.34, 1),
        opticalThickness,
        density,
      }
      if (Object.values(seed).some((value) => typeof value === 'number' && !Number.isFinite(value))) continue
      seeds.push(seed)
    }
  }

  return seeds
}

/**
 * Creates separated vertical layers from one observed macro field. The layers
 * overlap enough to read as one formation, while their altitude separation
 * creates parallax and an actual sense of thickness when the camera pitches
 * toward the horizon.
 */
export function createCloudVolumeParts(seed: ExploreCloudSeed): ExploreCloudVolumePart[] {
  const latitudeCosine = Math.max(0.3, Math.cos(seed.latitudeDeg * Math.PI / 180))
  const keyX = Math.round(seed.longitudeDeg * 10)
  const keyY = Math.round(seed.latitudeDeg * 10)
  const angle = hash01(keyX + 73, keyY + 19) * Math.PI * 2
  const offsetMeters = clamp(5_000 + seed.scaleX * 0.055, 5_000, 14_000)
  const latitudeOffset = Math.sin(angle) * offsetMeters / 111_320
  const longitudeOffset = Math.cos(angle) * offsetMeters / (111_320 * latitudeCosine)
  const lowerAltitude = Math.max(180, seed.altitudeMeters - seed.depthMeters * 0.26)
  const upperAltitude = Math.min(20_000, seed.altitudeMeters + seed.depthMeters * 0.28)

  const parts: ExploreCloudVolumePart[] = [
    {
      longitudeDeg: seed.longitudeDeg,
      latitudeDeg: seed.latitudeDeg,
      altitudeMeters: lowerAltitude,
      scaleX: clamp(seed.scaleX * 1.08, 24_000, 185_000),
      scaleY: clamp(seed.scaleY * 1.04, 20_000, 155_000),
      depthMeters: clamp(seed.depthMeters * 0.42, 800, 6_000),
      slice: clamp(seed.slice - 0.07, 0.28, 0.6),
      alphaScale: 0.58,
      brightnessScale: 0.95,
    },
    {
      longitudeDeg: wrapCloudLongitude(seed.longitudeDeg + longitudeOffset * 0.32),
      latitudeDeg: clamp(seed.latitudeDeg + latitudeOffset * 0.32, -82, 82),
      altitudeMeters: seed.altitudeMeters,
      scaleX: clamp(seed.scaleX * 0.8, 24_000, 150_000),
      scaleY: clamp(seed.scaleY * 0.8, 20_000, 130_000),
      depthMeters: clamp(seed.depthMeters * 0.78, 1_000, 9_000),
      slice: seed.slice,
      alphaScale: 0.88,
      brightnessScale: 1,
    },
  ]

  if (seed.density > 0.58) {
    parts.push({
      longitudeDeg: wrapCloudLongitude(seed.longitudeDeg + longitudeOffset),
      latitudeDeg: clamp(seed.latitudeDeg + latitudeOffset, -82, 82),
      altitudeMeters: upperAltitude,
      scaleX: clamp(seed.scaleX * (0.42 + seed.density * 0.1), 18_000, 105_000),
      scaleY: clamp(seed.scaleY * (0.42 + seed.density * 0.08), 16_000, 90_000),
      depthMeters: clamp(seed.depthMeters * (0.42 + seed.density * 0.16), 900, 7_000),
      slice: clamp(seed.slice + 0.07, 0.38, 0.72),
      alphaScale: 0.68,
      brightnessScale: 1.03,
    })
  }

  return parts.filter((part) => Object.values(part).every((value) => typeof value !== 'number' || Number.isFinite(value)))
}

function angularDistanceDegrees(left: number, right: number): number {
  return Math.abs(wrapCloudLongitude(left - right))
}

export class ExploreCloudSystem {
  private readonly viewer: Viewer
  private collection: CloudCollectionLike | null = null
  private farFieldLayer: ImageryLayer | null = null
  private sampleAlpha: CloudAlphaSampler | null = null
  private sampleCloudTopMeters: CloudTopHeightSampler | null = null
  private sampleOpticalThickness: CloudOpticalThicknessSampler | null = null
  private running = false
  private destroyed = false
  private loadGeneration = 0
  private opacity = 0.72
  private shadowsEnabled = true
  private lastLongitudeDeg: number | null = null
  private lastLatitudeDeg: number | null = null
  private lastAltitudeBucket = -1
  private lastVolumeFade = -1
  private readonly onPreRender = () => this.update()

  constructor(viewer: Viewer) {
    this.viewer = viewer
  }

  async start(opacity = 0.72, shadowsEnabled = true): Promise<void> {
    this.opacity = clamp(opacity, 0, 1)
    this.shadowsEnabled = shadowsEnabled
    if (this.destroyed || this.viewer.isDestroyed()) return
    const generation = ++this.loadGeneration

    if (!this.collection) {
      this.collection = this.viewer.scene.primitives.add(new CloudCollectionCtor({
        noiseDetail: CLOUD_COLLECTION_NOISE_DETAIL,
        noiseOffset: new Cartesian3(11.3, 5.7, 23.9),
      })) as CloudCollectionLike
      this.collection.show = false
    }

    if (!this.sampleAlpha || !this.farFieldLayer) {
      const [texture, cloudTopSampler, opticalThicknessSampler] = await Promise.all([
        preloadNasaCloudTexture(),
        preloadNasaCloudTopHeightSampler(NASA_GIBS_CLOUD_OBSERVATION_DATE),
        preloadNasaCloudOpticalThicknessSampler(NASA_GIBS_CLOUD_OBSERVATION_DATE),
      ])
      if (this.destroyed || generation !== this.loadGeneration || this.viewer.isDestroyed()) return
      this.sampleAlpha = createCanvasCloudAlphaSampler(texture)
      this.sampleCloudTopMeters = cloudTopSampler
      this.sampleOpticalThickness = opticalThicknessSampler

      const provider = await createNasaCloudProvider(NASA_GIBS_CLOUD_OBSERVATION_DATE, texture)
      if (this.destroyed || generation !== this.loadGeneration || this.viewer.isDestroyed()) return
      const layer = this.viewer.imageryLayers.addImageryProvider(provider)
      layer.alpha = 0
      layer.brightness = 1.1
      layer.contrast = 1.17
      layer.saturation = 0.9
      layer.show = false
      this.viewer.imageryLayers.raiseToTop(layer)
      this.farFieldLayer = layer
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

  setShadowsEnabled(enabled: boolean): void {
    this.shadowsEnabled = enabled
  }

  stop(): void {
    this.loadGeneration += 1
    if (this.running && !this.viewer.isDestroyed()) this.viewer.scene.preRender.removeEventListener(this.onPreRender)
    this.running = false
    if (this.collection) {
      this.collection.show = false
      this.collection.removeAll()
    }
    if (this.farFieldLayer && !this.viewer.isDestroyed()) this.viewer.imageryLayers.remove(this.farFieldLayer, false)
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
    this.sampleCloudTopMeters = null
    this.sampleOpticalThickness = null
  }

  private update(): void {
    if (!this.running || !this.collection || !this.sampleAlpha || this.viewer.isDestroyed()) return
    const cartographic = this.viewer.camera.positionCartographic
    const longitudeDeg = cartographic.longitude * 180 / Math.PI
    const latitudeDeg = cartographic.latitude * 180 / Math.PI
    const altitudeMeters = Math.max(0, finite(cartographic.height, CLOUD_VOLUME_OFF_ABOVE_METERS))
    const volumeFade = exploreCloudVolumeFade(altitudeMeters)
    const mapFade = exploreCloudMapFade(altitudeMeters)

    if (this.farFieldLayer) {
      this.farFieldLayer.alpha = clamp(this.opacity * 1.08 * mapFade * CLOUD_FAR_FIELD_MAX_ALPHA, 0, CLOUD_FAR_FIELD_MAX_ALPHA)
      this.farFieldLayer.show = mapFade > 0.01 && this.farFieldLayer.alpha > 0.005
    }

    this.collection.show = volumeFade > 0.012
    if (!this.collection.show) return

    const altitudeBucket = Math.floor(altitudeMeters / 55_000)
    const movedFarEnough = this.lastLongitudeDeg === null
      || this.lastLatitudeDeg === null
      || angularDistanceDegrees(longitudeDeg, this.lastLongitudeDeg) >= CLOUD_REGION_REBUILD_DEGREES
      || Math.abs(latitudeDeg - this.lastLatitudeDeg) >= CLOUD_REGION_REBUILD_DEGREES
    const fadeChanged = this.lastVolumeFade < 0 || Math.abs(volumeFade - this.lastVolumeFade) >= 0.1
    if (movedFarEnough || altitudeBucket !== this.lastAltitudeBucket || fadeChanged) this.rebuild(false)
  }

  private rebuild(force: boolean): void {
    if (!this.collection || !this.sampleAlpha || this.viewer.isDestroyed()) return
    void force
    const cartographic = this.viewer.camera.positionCartographic
    const longitudeDeg = finite(cartographic.longitude * 180 / Math.PI, 0)
    const latitudeDeg = finite(cartographic.latitude * 180 / Math.PI, 0)
    const altitudeMeters = Math.max(0, finite(cartographic.height, CLOUD_VOLUME_OFF_ABOVE_METERS))
    const volumeFade = exploreCloudVolumeFade(altitudeMeters)
    const mapFade = exploreCloudMapFade(altitudeMeters)

    if (this.farFieldLayer) {
      this.farFieldLayer.alpha = clamp(this.opacity * 1.08 * mapFade * CLOUD_FAR_FIELD_MAX_ALPHA, 0, CLOUD_FAR_FIELD_MAX_ALPHA)
      this.farFieldLayer.show = mapFade > 0.01 && this.farFieldLayer.alpha > 0.005
    }

    if (volumeFade <= 0.012) {
      this.collection.show = false
      this.collection.removeAll()
      this.commitRebuildState(longitudeDeg, latitudeDeg, altitudeMeters, volumeFade)
      this.viewer.scene.requestRender()
      return
    }

    try {
      const radiusDegrees = exploreCloudRadiusDegrees(altitudeMeters)
      const seeds = createExploreCloudSeeds(
        longitudeDeg,
        latitudeDeg,
        radiusDegrees,
        this.sampleAlpha,
        CLOUD_MAX_SEEDS,
        this.sampleCloudTopMeters,
        this.sampleOpticalThickness,
      )
      this.collection.removeAll()

      const renderedAlpha = clamp(this.opacity * (1.06 + volumeFade * 0.14) * volumeFade, 0, 1)
      const dayColor = Color.fromCssColorString('#f8fbff')
      const nightColor = Color.fromCssColorString('#68859e')
      let partCount = 0

      for (const seed of seeds) {
        const centerPosition = Cartesian3.fromDegrees(seed.longitudeDeg, seed.latitudeDeg, seed.altitudeMeters)
        const sunlight = computeOrbitalLighting(this.viewer.clock.currentTime, centerPosition).sunlight
        const twilight = 1 - Math.abs(sunlight - 0.5) * 2
        const denseTint = 1 - seed.density * 0.07
        const baseColor = Color.lerp(nightColor, dayColor, sunlight, new Color())
        baseColor.red *= denseTint
        baseColor.green *= denseTint
        baseColor.blue *= denseTint

        for (const part of createCloudVolumeParts(seed)) {
          if (partCount >= CLOUD_MAX_PARTS) break
          if (part.scaleX <= 0 || part.scaleY <= 0 || part.depthMeters <= 0) continue
          const color = Color.clone(baseColor, new Color())
          color.alpha = clamp(seed.alpha * renderedAlpha * part.alphaScale * (0.82 + sunlight * 0.18), 0, 1)
          const brightness = clamp(
            seed.brightness * part.brightnessScale * (0.28 + sunlight * 0.72) + Math.max(0, twilight) * 0.07,
            0.2,
            1.1,
          )
          this.collection.add({
            position: Cartesian3.fromDegrees(part.longitudeDeg, part.latitudeDeg, part.altitudeMeters),
            scale: new Cartesian2(part.scaleX, part.scaleY),
            maximumSize: new Cartesian3(part.scaleX, part.scaleY, part.depthMeters),
            slice: part.slice,
            brightness,
            color,
          })
          partCount += 1
        }
        if (partCount >= CLOUD_MAX_PARTS) break
      }

      this.collection.show = partCount > 0 && volumeFade > 0.012
      this.commitRebuildState(longitudeDeg, latitudeDeg, altitudeMeters, volumeFade)
      this.viewer.scene.requestRender()
    } catch (error) {
      // A malformed upstream sample or transient Cesium allocation must never
      // kill the whole renderer. Drop the local volume and leave the stable
      // far-field NASA layer visible for this frame/region.
      console.warn('Explore cloud rebuild skipped after recoverable error', error)
      this.collection.removeAll()
      this.collection.show = false
      this.commitRebuildState(longitudeDeg, latitudeDeg, altitudeMeters, 0)
      this.viewer.scene.requestRender()
    }
  }

  private commitRebuildState(longitudeDeg: number, latitudeDeg: number, altitudeMeters: number, volumeFade: number): void {
    this.lastLongitudeDeg = longitudeDeg
    this.lastLatitudeDeg = latitudeDeg
    this.lastAltitudeBucket = Math.floor(altitudeMeters / 55_000)
    this.lastVolumeFade = volumeFade
  }
}
