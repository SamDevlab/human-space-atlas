import * as Cesium from 'cesium'
import {
  Cartesian2,
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  EllipseGeometry,
  Ellipsoid,
  GeometryInstance,
  ImageryLayer,
  PerInstanceColorAppearance,
  Primitive,
  Viewer,
} from 'cesium'
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

const CLOUD_COLLECTION_NOISE_DETAIL = 24
const CLOUD_REGION_STEP_DEGREES = 1.8
const CLOUD_REGION_REBUILD_DEGREES = 2.4
const CLOUD_REGION_MAX_RADIUS_DEGREES = 15
const CLOUD_REGION_MIN_RADIUS_DEGREES = 7
const CLOUD_MAX_SEEDS = 170
const CLOUD_MAX_PARTS = 420
const CLOUD_MAX_SHADOW_COUNT = 90
const CLOUD_ALPHA_REFERENCE = 0.48
const CLOUD_VOLUME_FULL_BELOW_METERS = 180_000
const CLOUD_VOLUME_OFF_ABOVE_METERS = 500_000
const CLOUD_MAP_START_METERS = 220_000
const CLOUD_MAP_FULL_ABOVE_METERS = 360_000
const CLOUD_FAR_FIELD_MAX_ALPHA = 1
const CLOUD_SHADOW_MAX_OFFSET_METERS = 180_000

export const EXPLORE_CLOUD_DISCLOSURE = 'NASA observed cloud field + cloud-top height + optical thickness · cinematic layered 3D reconstruction'

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

function hash01(x: number, y: number): number {
  const value = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123
  return value - Math.floor(value)
}

export function wrapCloudLongitude(longitudeDeg: number): number {
  return ((longitudeDeg + 180) % 360 + 360) % 360 - 180
}

export function exploreCloudVolumeFade(cameraHeightMeters: number): number {
  const range = CLOUD_VOLUME_OFF_ABOVE_METERS - CLOUD_VOLUME_FULL_BELOW_METERS
  return 1 - smoothstep01((cameraHeightMeters - CLOUD_VOLUME_FULL_BELOW_METERS) / range)
}

export function exploreCloudMapFade(cameraHeightMeters: number): number {
  const range = CLOUD_MAP_FULL_ABOVE_METERS - CLOUD_MAP_START_METERS
  return smoothstep01((cameraHeightMeters - CLOUD_MAP_START_METERS) / range)
}

export function exploreCloudRadiusDegrees(cameraHeightMeters: number): number {
  return clamp(7 + cameraHeightMeters / 100_000, CLOUD_REGION_MIN_RADIUS_DEGREES, CLOUD_REGION_MAX_RADIUS_DEGREES)
}

/** Shadow fades out at night, with thin clouds and during the 2D/3D handoff. */
export function cloudShadowOpacity(density: number, sunlight: number, opacity: number, volumeFade: number): number {
  const lit = smoothstep01((clamp(sunlight, 0, 1) - 0.08) / 0.72)
  const dense = smoothstep01((clamp(density, 0, 1) - 0.12) / 0.78)
  return clamp(opacity, 0, 1) * clamp(volumeFade, 0, 1) * lit * dense * 0.1
}

/** Approximate horizontal displacement of a cloud shadow from solar elevation. */
export function cloudShadowOffsetMeters(cloudAltitudeMeters: number, sunElevationSin: number): number {
  const elevationSin = clamp(sunElevationSin, 0, 1)
  if (elevationSin <= 0.055) return CLOUD_SHADOW_MAX_OFFSET_METERS
  const horizontal = Math.sqrt(Math.max(0, 1 - elevationSin * elevationSin))
  return clamp(Math.max(0, cloudAltitudeMeters) * horizontal / elevationSin, 0, CLOUD_SHADOW_MAX_OFFSET_METERS)
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
    [0, 0], [-0.55, 0], [0.55, 0], [0, -0.55], [0, 0.55],
    [-0.38, -0.38], [0.38, 0.38], [-0.38, 0.38], [0.38, -0.38],
  ] as const
  for (const [longitudeOffset, latitudeOffset] of offsets) {
    coverage = Math.max(coverage, sampleAlpha(longitudeDeg + longitudeOffset, latitudeDeg + latitudeOffset))
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
      if (coverage < 0.11) continue

      const cellX = Math.round(wrappedLongitude / CLOUD_REGION_STEP_DEGREES)
      const cellY = Math.round(latitude / CLOUD_REGION_STEP_DEGREES)
      const keepChance = clamp(0.18 + coverage * 0.76, 0, 0.93)
      if (hash01(cellX + 17, cellY + 29) > keepChance) continue

      const clusterCount = coverage > 0.72 ? 2 : 1
      const latitudeCosine = Math.max(0.28, Math.cos(latitude * Math.PI / 180))
      for (let clusterIndex = 0; clusterIndex < clusterCount && seeds.length < maxClouds; clusterIndex += 1) {
        const jitterX = hash01(cellX * 13 + clusterIndex * 7 + 3, cellY * 11 + 5) - 0.5
        const jitterY = hash01(cellX * 17 + 9, cellY * 19 + clusterIndex * 13 + 7) - 0.5
        const longitudeJitter = jitterX * CLOUD_REGION_STEP_DEGREES * 0.48 / latitudeCosine
        const latitudeJitter = jitterY * CLOUD_REGION_STEP_DEGREES * 0.42
        const shapeNoise = hash01(cellX * 23 + clusterIndex * 31 + 11, cellY * 29 + 17)
        const heightNoise = hash01(cellX * 37 + 19, cellY * 41 + clusterIndex * 43 + 23)
        const aspectNoise = hash01(cellX * 47 + clusterIndex * 53 + 29, cellY * 59 + 31)

        const seedLongitude = wrapCloudLongitude(wrappedLongitude + longitudeJitter)
        const seedLatitude = clamp(latitude + latitudeJitter, -82, 82)
        const opticalThickness = sampleOpticalThickness?.(seedLongitude, seedLatitude) ?? null
        const observedDensity = opticalThicknessDensity(opticalThickness)
        const density = opticalThickness === null ? clamp(0.28 + coverage * 0.62, 0, 1) : observedDensity
        const horizontalBase = (46_000 + coverage * 112_000) * (0.92 + density * 0.12)
        const scaleX = horizontalBase * (0.86 + shapeNoise * 0.32)
        const scaleY = scaleX * (0.58 + aspectNoise * 0.28)
        const observedTopMeters = sampleCloudTopMeters?.(seedLongitude, seedLatitude) ?? null

        let depthMeters: number
        let altitudeMeters: number
        if (observedTopMeters !== null && observedTopMeters >= 300 && observedTopMeters <= 20_000) {
          const desiredDepth = (1_500 + coverage * 3_400 + shapeNoise * 1_600) * (0.72 + density * 0.9)
          depthMeters = clamp(desiredDepth, 1_300, Math.max(1_800, observedTopMeters * 0.86))
          const baseMeters = Math.max(180, observedTopMeters - depthMeters)
          altitudeMeters = baseMeters + depthMeters * 0.5
        } else {
          const baseAltitude = 1_100 + heightNoise * 3_500
          depthMeters = (2_800 + coverage * 5_800 + shapeNoise * 2_400) * (0.72 + density * 0.82)
          altitudeMeters = baseAltitude + depthMeters * 0.5
        }

        seeds.push({
          longitudeDeg: seedLongitude,
          latitudeDeg: seedLatitude,
          altitudeMeters,
          scaleX,
          scaleY,
          depthMeters,
          slice: clamp(0.34 + density * 0.2 + hash01(cellX * 61 + clusterIndex * 67 + 37, cellY * 71 + 41) * 0.14, 0.32, 0.7),
          brightness: clamp(0.82 + coverage * 0.12 + (1 - density) * 0.07 + heightNoise * 0.05, 0.8, 1.08),
          alpha: clamp(0.34 + coverage * 0.32 + density * 0.42, 0.34, 1),
          opticalThickness,
          density,
        })
      }
    }
  }

  return seeds
}

/**
 * Split one observed macro cloud bank into stacked native Cesium cloud volumes.
 * The horizontal footprint still comes from NASA coverage; the vertical stack
 * creates real parallax when the Explore camera moves through low orbit.
 */
export function createCloudVolumeParts(seed: ExploreCloudSeed): ExploreCloudVolumePart[] {
  const latitudeCosine = Math.max(0.3, Math.cos(seed.latitudeDeg * Math.PI / 180))
  const keyX = Math.round(seed.longitudeDeg * 10)
  const keyY = Math.round(seed.latitudeDeg * 10)
  const offsetAngle = hash01(keyX + 73, keyY + 19) * Math.PI * 2
  const offsetMeters = (8_000 + seed.scaleX * 0.09) * (0.55 + seed.density * 0.45)
  const latitudeOffset = Math.sin(offsetAngle) * offsetMeters / 111_320
  const longitudeOffset = Math.cos(offsetAngle) * offsetMeters / (111_320 * latitudeCosine)
  const baseAltitude = Math.max(180, seed.altitudeMeters - seed.depthMeters * 0.22)

  const parts: ExploreCloudVolumePart[] = [
    {
      longitudeDeg: seed.longitudeDeg,
      latitudeDeg: seed.latitudeDeg,
      altitudeMeters: baseAltitude,
      scaleX: seed.scaleX * 1.12,
      scaleY: seed.scaleY * 1.08,
      depthMeters: Math.max(1_000, seed.depthMeters * 0.46),
      slice: clamp(seed.slice - 0.08, 0.28, 0.62),
      alphaScale: 0.56,
      brightnessScale: 0.96,
    },
    {
      longitudeDeg: wrapCloudLongitude(seed.longitudeDeg + longitudeOffset * 0.35),
      latitudeDeg: clamp(seed.latitudeDeg + latitudeOffset * 0.35, -82, 82),
      altitudeMeters: seed.altitudeMeters,
      scaleX: seed.scaleX * 0.78,
      scaleY: seed.scaleY * 0.76,
      depthMeters: Math.max(1_200, seed.depthMeters * 0.9),
      slice: seed.slice,
      alphaScale: 0.9,
      brightnessScale: 1,
    },
  ]

  if (seed.density > 0.46) {
    parts.push({
      longitudeDeg: wrapCloudLongitude(seed.longitudeDeg + longitudeOffset),
      latitudeDeg: clamp(seed.latitudeDeg + latitudeOffset, -82, 82),
      altitudeMeters: seed.altitudeMeters + seed.depthMeters * 0.24,
      scaleX: seed.scaleX * (0.42 + seed.density * 0.14),
      scaleY: seed.scaleY * (0.4 + seed.density * 0.12),
      depthMeters: Math.max(1_200, seed.depthMeters * (0.5 + seed.density * 0.18)),
      slice: clamp(seed.slice + 0.07, 0.38, 0.76),
      alphaScale: 0.72,
      brightnessScale: 1.035,
    })
  }

  return parts
}

function angularDistanceDegrees(left: number, right: number): number {
  return Math.abs(wrapCloudLongitude(left - right))
}

export class ExploreCloudSystem {
  private readonly viewer: Viewer
  private collection: CloudCollectionLike | null = null
  private farFieldLayer: ImageryLayer | null = null
  private shadowPrimitive: Primitive | null = null
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
        noiseOffset: new Cartesian3(13.7, 4.2, 27.4),
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

      if (!this.farFieldLayer) {
        const provider = await createNasaCloudProvider(NASA_GIBS_CLOUD_OBSERVATION_DATE, texture)
        if (this.destroyed || generation !== this.loadGeneration || this.viewer.isDestroyed()) return
        const layer = this.viewer.imageryLayers.addImageryProvider(provider)
        layer.alpha = 0
        layer.brightness = 1.1
        layer.contrast = 1.16
        layer.saturation = 0.9
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

  setShadowsEnabled(enabled: boolean): void {
    if (enabled === this.shadowsEnabled) return
    this.shadowsEnabled = enabled
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
    this.clearShadowPrimitive()
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
    const altitudeMeters = Math.max(0, cartographic.height)
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
    const fadeChanged = this.lastVolumeFade < 0 || Math.abs(volumeFade - this.lastVolumeFade) >= 0.08
    if (movedFarEnough || altitudeBucket !== this.lastAltitudeBucket || fadeChanged) this.rebuild(false)
  }

  private rebuild(force: boolean): void {
    if (!this.collection || !this.sampleAlpha || this.viewer.isDestroyed()) return
    void force
    const cartographic = this.viewer.camera.positionCartographic
    const longitudeDeg = cartographic.longitude * 180 / Math.PI
    const latitudeDeg = cartographic.latitude * 180 / Math.PI
    const altitudeMeters = Math.max(0, cartographic.height)
    const volumeFade = exploreCloudVolumeFade(altitudeMeters)
    const mapFade = exploreCloudMapFade(altitudeMeters)

    if (this.farFieldLayer) {
      this.farFieldLayer.alpha = clamp(this.opacity * 1.08 * mapFade * CLOUD_FAR_FIELD_MAX_ALPHA, 0, CLOUD_FAR_FIELD_MAX_ALPHA)
      this.farFieldLayer.show = mapFade > 0.01 && this.farFieldLayer.alpha > 0.005
    }

    if (volumeFade <= 0.012) {
      this.collection.show = false
      this.collection.removeAll()
      this.clearShadowPrimitive()
      this.lastLongitudeDeg = longitudeDeg
      this.lastLatitudeDeg = latitudeDeg
      this.lastAltitudeBucket = Math.floor(altitudeMeters / 55_000)
      this.lastVolumeFade = volumeFade
      this.viewer.scene.requestRender()
      return
    }

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
    this.clearShadowPrimitive()

    const renderedAlpha = clamp(this.opacity * (1.08 + volumeFade * 0.12) * volumeFade, 0, 1)
    const dayColor = Color.fromCssColorString('#f8fbff')
    const nightColor = Color.fromCssColorString('#67849e')
    const shadowInstances: GeometryInstance[] = []
    let shadowCount = 0
    let partCount = 0

    for (const seed of seeds) {
      const centerPosition = Cartesian3.fromDegrees(seed.longitudeDeg, seed.latitudeDeg, seed.altitudeMeters)
      const lighting = computeOrbitalLighting(this.viewer.clock.currentTime, centerPosition)
      const sunlight = lighting.sunlight
      const twilight = 1 - Math.abs(sunlight - 0.5) * 2
      const denseTint = 1 - seed.density * 0.075
      const baseColor = Color.lerp(nightColor, dayColor, sunlight, new Color())
      baseColor.red *= denseTint
      baseColor.green *= denseTint
      baseColor.blue *= denseTint

      for (const part of createCloudVolumeParts(seed)) {
        if (partCount >= CLOUD_MAX_PARTS) break
        const litColor = Color.clone(baseColor, new Color())
        litColor.alpha = clamp(seed.alpha * renderedAlpha * part.alphaScale * (0.82 + sunlight * 0.18), 0, 1)
        const litBrightness = clamp(
          seed.brightness * part.brightnessScale * (0.27 + sunlight * 0.73) + Math.max(0, twilight) * 0.07,
          0.2,
          1.12,
        )
        this.collection.add({
          position: Cartesian3.fromDegrees(part.longitudeDeg, part.latitudeDeg, part.altitudeMeters),
          scale: new Cartesian2(part.scaleX, part.scaleY),
          maximumSize: new Cartesian3(part.scaleX, part.scaleY, part.depthMeters),
          slice: part.slice,
          brightness: litBrightness,
          color: litColor,
        })
        partCount += 1
      }

      if (!this.shadowsEnabled || shadowCount >= CLOUD_MAX_SHADOW_COUNT || !lighting.sunPositionFixed) continue
      const shadowAlpha = cloudShadowOpacity(seed.density, sunlight, this.opacity, volumeFade)
      if (shadowAlpha <= 0.004) continue

      const up = Ellipsoid.WGS84.geodeticSurfaceNormal(centerPosition, new Cartesian3())
      const toSun = Cartesian3.subtract(lighting.sunPositionFixed, centerPosition, new Cartesian3())
      if (Cartesian3.magnitude(toSun) <= 1) continue
      Cartesian3.normalize(toSun, toSun)
      const sunElevationSin = Cartesian3.dot(toSun, up)
      if (sunElevationSin <= 0.035) continue

      const radialSun = Cartesian3.multiplyByScalar(up, sunElevationSin, new Cartesian3())
      const tangentSun = Cartesian3.subtract(toSun, radialSun, new Cartesian3())
      const offsetMeters = cloudShadowOffsetMeters(seed.altitudeMeters, sunElevationSin)
      const surface = Ellipsoid.WGS84.scaleToGeodeticSurface(centerPosition, new Cartesian3())
      if (!surface) continue
      let shadowSurface = surface
      if (offsetMeters > 1 && Cartesian3.magnitude(tangentSun) > 0.0001) {
        Cartesian3.normalize(tangentSun, tangentSun)
        const displaced = Cartesian3.subtract(surface, Cartesian3.multiplyByScalar(tangentSun, offsetMeters, new Cartesian3()), new Cartesian3())
        shadowSurface = Ellipsoid.WGS84.scaleToGeodeticSurface(displaced, new Cartesian3()) ?? surface
      }

      const rotation = ((seed.longitudeDeg * 0.013 + seed.latitudeDeg * 0.021) % Math.PI + Math.PI) % Math.PI
      shadowInstances.push(
        new GeometryInstance({
          geometry: new EllipseGeometry({
            center: shadowSurface,
            semiMajorAxis: Math.max(2_000, seed.scaleX * 0.44),
            semiMinorAxis: Math.max(2_000, seed.scaleY * 0.44),
            height: 800,
            rotation,
            vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT,
          }),
          attributes: { color: ColorGeometryInstanceAttribute.fromColor(new Color(0.018, 0.03, 0.045, shadowAlpha * 0.3)) },
        }),
        new GeometryInstance({
          geometry: new EllipseGeometry({
            center: shadowSurface,
            semiMajorAxis: Math.max(1_500, seed.scaleX * 0.3),
            semiMinorAxis: Math.max(1_500, seed.scaleY * 0.3),
            height: 820,
            rotation,
            vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT,
          }),
          attributes: { color: ColorGeometryInstanceAttribute.fromColor(new Color(0.012, 0.024, 0.036, shadowAlpha * 0.5)) },
        }),
      )
      shadowCount += 1
    }

    if (shadowInstances.length > 0) {
      this.shadowPrimitive = this.viewer.scene.primitives.add(new Primitive({
        geometryInstances: shadowInstances,
        appearance: new PerInstanceColorAppearance({ flat: true, translucent: true, closed: false }),
        asynchronous: false,
        allowPicking: false,
      })) as Primitive
    }

    this.collection.show = partCount > 0 && volumeFade > 0.012
    this.lastLongitudeDeg = longitudeDeg
    this.lastLatitudeDeg = latitudeDeg
    this.lastAltitudeBucket = Math.floor(altitudeMeters / 55_000)
    this.lastVolumeFade = volumeFade
    this.viewer.scene.requestRender()
  }

  private clearShadowPrimitive(): void {
    if (!this.shadowPrimitive) return
    if (!this.viewer.isDestroyed()) this.viewer.scene.primitives.remove(this.shadowPrimitive)
    this.shadowPrimitive = null
  }
}
