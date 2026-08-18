import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  Ellipsoid,
  ImageryLayer,
  Tonemapper,
  Viewer,
} from 'cesium'
import { computeOrbitalLighting } from './OrbitalLighting'

export type NightLightsVisual = {
  alpha: number
  brightness: number
  contrast: number
  saturation: number
  gamma: number
}

type NightLayerSnapshot = NightLightsVisual & {
  show: boolean
  dayAlpha: number
  nightAlpha: number
}

type TunableLayer = ImageryLayer & {
  alpha: number
  dayAlpha: number
  nightAlpha: number
  brightness: number
  contrast: number
  saturation: number
  gamma: number
  show: boolean
  imageryProvider: unknown
}

type PrefetchProvider = {
  requestImage: (x: number, y: number, level: number) => Promise<unknown> | unknown | undefined
  tilingScheme: {
    positionToTileXY: (position: Cartographic, level: number, result?: Cartesian2) => Cartesian2 | undefined
    getNumberOfXTilesAtLevel: (level: number) => number
    getNumberOfYTilesAtLevel: (level: number) => number
  }
}

type BloomUniforms = {
  contrast?: number
  brightness?: number
  glowOnly?: boolean
  delta?: number
  sigma?: number
  stepSize?: number
}

type GraphicsSnapshot = {
  highDynamicRange: boolean
  exposure: number
  tonemapper: string
  bloomEnabled: boolean
  bloom: BloomUniforms
  fog: {
    enabled: boolean
    renderable: boolean
    density: number
    visualDensityScalar: number
    minimumBrightness: number
    maxHeight: number
    heightFalloff: number
    screenSpaceErrorFactor: number
  }
  waterEffect: boolean
  globeHue: number
  skyHue: number | null
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function smoothstep01(value: number): number {
  const clamped = clamp(value, 0, 1)
  return clamped * clamped * (3 - 2 * clamped)
}

export function imageryPrefetchLevel(cameraHeightMeters: number): number {
  if (cameraHeightMeters > 1_500_000) return 3
  if (cameraHeightMeters > 650_000) return 4
  if (cameraHeightMeters > 300_000) return 5
  if (cameraHeightMeters > 140_000) return 6
  return 7
}

/**
 * Converts direct sunlight at the center of the current Earth view into a
 * night-light grade. Daylight is truly transparent so an overlay can never
 * reveal a provider placeholder over the lit hemisphere.
 */
export function nightLightsVisual(sunlight: number): NightLightsVisual {
  const darkness = smoothstep01((0.68 - clamp(sunlight, 0, 1)) / 0.68)
  return {
    alpha: Math.pow(darkness, 1.28) * 0.96,
    brightness: 1.02 + darkness * 1.72,
    contrast: 1.02 + darkness * 0.46,
    saturation: 0.86 + darkness * 0.24,
    gamma: 0.94 + darkness * 0.06,
  }
}

function isNasaNightLightsLayer(layer: TunableLayer): boolean {
  const provider = layer.imageryProvider as {
    layers?: string
    _layers?: string
    url?: string
    _resource?: { url?: string }
  } | null
  if (!provider) return false
  const layers = String(provider.layers ?? provider._layers ?? '')
  const url = String(provider.url ?? provider._resource?.url ?? '')
  return layers.includes('VIIRS_SNPP_DayNightBand_ENCC')
    || layers.includes('VIIRS_Night_Lights')
    || ((layers.toLowerCase().includes('daynightband') || layers.toLowerCase().includes('night_lights')) && url.includes('gibs.earthdata.nasa.gov'))
}

/**
 * Explore-only presentation controller for NASA VIIRS, forward imagery
 * prefetch and the restrained Graphics V2 grade. The visual grade intentionally
 * stays subtle: HDR/exposure, limb atmosphere, horizon haze, ocean water effect
 * and bloom all respond to the same sunlight value instead of acting as
 * independent game-like effects.
 */
export class NightSideSystem {
  private readonly viewer: Viewer
  private layer: TunableLayer | null = null
  private snapshot: NightLayerSnapshot | null = null
  private graphicsSnapshot: GraphicsSnapshot | null = null
  private running = false
  private lastSearchAt = -Infinity
  private lastPrefetchAt = -Infinity
  private stableFrames = 0
  private readonly screenCenter = new Cartesian2()
  private readonly prefetchPoint = new Cartesian2()
  private readonly tileCoordinate = new Cartesian2()

  constructor(viewer: Viewer) {
    this.viewer = viewer
  }

  start(): void {
    if (this.running || this.viewer.isDestroyed()) return
    this.running = true
    this.stableFrames = 0
    this.lastPrefetchAt = -Infinity
    this.captureAndEnableGraphics()
    this.resolveLayer(performance.now(), true)
  }

  update(shipPosition: Cartesian3, now = performance.now()): void {
    if (!this.running || this.viewer.isDestroyed()) return
    this.resolveLayer(now, false)
    this.prefetchAhead(now)

    const canvas = this.viewer.scene.canvas
    this.screenCenter.x = (canvas.clientWidth || canvas.width) * 0.5
    this.screenCenter.y = (canvas.clientHeight || canvas.height) * 0.5
    const lookPoint = this.viewer.camera.pickEllipsoid(this.screenCenter, Ellipsoid.WGS84) ?? shipPosition
    const sunlight = computeOrbitalLighting(this.viewer.clock.currentTime, lookPoint).sunlight
    const visual = nightLightsVisual(sunlight)
    this.updateGraphicsGrade(sunlight)

    if (this.viewer.scene.globe.tilesLoaded) this.stableFrames = Math.min(8, this.stableFrames + 1)
    else this.stableFrames = Math.max(0, this.stableFrames - 2)

    if (!this.layer) return
    const readiness = smoothstep01(this.stableFrames / 5)
    const alpha = visual.alpha * readiness

    this.layer.show = alpha > 0.015
    this.layer.alpha = alpha
    this.layer.dayAlpha = 0
    this.layer.nightAlpha = alpha
    this.layer.brightness = visual.brightness
    this.layer.contrast = visual.contrast
    this.layer.saturation = visual.saturation
    this.layer.gamma = visual.gamma
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    this.stableFrames = 0
    this.restore()
    this.restoreGraphics()
  }

  destroy(): void {
    this.stop()
    this.layer = null
    this.snapshot = null
    this.graphicsSnapshot = null
  }

  private captureAndEnableGraphics(): void {
    const scene = this.viewer.scene
    const post = scene.postProcessStages
    const bloom = post.bloom
    const bloomUniforms = bloom.uniforms as BloomUniforms
    const fog = scene.fog
    const globe = scene.globe
    const sky = scene.skyAtmosphere

    this.graphicsSnapshot = {
      highDynamicRange: scene.highDynamicRange,
      exposure: post.exposure,
      tonemapper: post.tonemapper,
      bloomEnabled: bloom.enabled,
      bloom: {
        contrast: bloomUniforms.contrast,
        brightness: bloomUniforms.brightness,
        glowOnly: bloomUniforms.glowOnly,
        delta: bloomUniforms.delta,
        sigma: bloomUniforms.sigma,
        stepSize: bloomUniforms.stepSize,
      },
      fog: {
        enabled: fog.enabled,
        renderable: fog.renderable,
        density: fog.density,
        visualDensityScalar: fog.visualDensityScalar,
        minimumBrightness: fog.minimumBrightness,
        maxHeight: fog.maxHeight,
        heightFalloff: fog.heightFalloff,
        screenSpaceErrorFactor: fog.screenSpaceErrorFactor,
      },
      waterEffect: globe.showWaterEffect,
      globeHue: globe.atmosphereHueShift,
      skyHue: sky ? sky.hueShift : null,
    }

    if (scene.highDynamicRangeSupported) scene.highDynamicRange = true
    post.tonemapper = Tonemapper.PBR_NEUTRAL
    bloom.enabled = true
    bloomUniforms.glowOnly = false
    bloomUniforms.delta = 1
    bloomUniforms.sigma = 2.2
    bloomUniforms.stepSize = 1
    post.fxaa.enabled = true
    globe.showWaterEffect = true
    fog.enabled = true
    fog.renderable = true
    fog.maxHeight = 650_000
    fog.heightFalloff = 0.52
    fog.screenSpaceErrorFactor = 1.2
  }

  private updateGraphicsGrade(sunlight: number): void {
    const scene = this.viewer.scene
    const post = scene.postProcessStages
    const bloomUniforms = post.bloom.uniforms as BloomUniforms
    const globe = scene.globe
    const sky = scene.skyAtmosphere
    const fog = scene.fog
    const clampedSun = clamp(sunlight, 0, 1)
    const darkness = 1 - clampedSun
    const twilight = Math.exp(-Math.pow((clampedSun - 0.5) / 0.19, 2))
    const height = Math.max(0, scene.camera.positionCartographic.height)
    const lowOrbit = 1 - smoothstep01((height - 140_000) / 440_000)

    // Automatic exposure protects the bright limb at sunrise/sunset and then
    // opens slowly in eclipse so cities/aurora can breathe without flattening
    // daylight imagery.
    post.exposure = clamp(0.94 - twilight * 0.09 + darkness * 0.14, 0.82, 1.08)
    bloomUniforms.contrast = 148 + twilight * 18 + darkness * 6
    bloomUniforms.brightness = -0.31 + darkness * 0.045 + twilight * 0.025

    // A low-density, altitude-bounded horizon haze provides perspective depth;
    // it is not a global fog layer and fades away above the low-orbit envelope.
    fog.density = 0.00014
    fog.visualDensityScalar = clamp(0.14 + lowOrbit * 0.18 + twilight * 0.055, 0.12, 0.38)
    fog.minimumBrightness = 0.035 + clampedSun * 0.1 + twilight * 0.025

    // Limb/airglow grade. Night gets a small cool/green bias while twilight
    // gets the brightest rim. All values stay deliberately close to neutral.
    globe.atmosphereHueShift = -0.012 - darkness * 0.012 + twilight * 0.008
    globe.atmosphereLightIntensity = 18 + twilight * 18 - darkness * 4
    globe.atmosphereBrightnessShift = 0.02 + twilight * 0.11 + darkness * 0.012
    globe.atmosphereSaturationShift = 0.08 + twilight * 0.17 + darkness * 0.035
    globe.lambertDiffuseMultiplier = 1.08 - darkness * 0.24 + twilight * 0.08
    if (sky) {
      sky.hueShift = -0.015 - darkness * 0.014 + twilight * 0.009
      sky.atmosphereLightIntensity = 68 + twilight * 66 - darkness * 18
      sky.brightnessShift = 0.018 + twilight * 0.145 + darkness * 0.016
      sky.saturationShift = 0.08 + twilight * 0.22 + darkness * 0.045
    }
    if (scene.sun) scene.sun.glowFactor = 1.2 + twilight * 2.55 + darkness * 0.08
    if (this.viewer.shadowMap) this.viewer.shadowMap.darkness = 0.27 + darkness * 0.2
    scene.requestRender()
  }

  private restoreGraphics(): void {
    const snapshot = this.graphicsSnapshot
    if (!snapshot || this.viewer.isDestroyed()) return
    const scene = this.viewer.scene
    const post = scene.postProcessStages
    const bloomUniforms = post.bloom.uniforms as BloomUniforms
    const fog = scene.fog
    const globe = scene.globe
    const sky = scene.skyAtmosphere

    scene.highDynamicRange = snapshot.highDynamicRange
    post.exposure = snapshot.exposure
    post.tonemapper = snapshot.tonemapper as typeof post.tonemapper
    post.bloom.enabled = snapshot.bloomEnabled
    Object.assign(bloomUniforms, snapshot.bloom)
    fog.enabled = snapshot.fog.enabled
    fog.renderable = snapshot.fog.renderable
    fog.density = snapshot.fog.density
    fog.visualDensityScalar = snapshot.fog.visualDensityScalar
    fog.minimumBrightness = snapshot.fog.minimumBrightness
    fog.maxHeight = snapshot.fog.maxHeight
    fog.heightFalloff = snapshot.fog.heightFalloff
    fog.screenSpaceErrorFactor = snapshot.fog.screenSpaceErrorFactor
    globe.showWaterEffect = snapshot.waterEffect
    globe.atmosphereHueShift = snapshot.globeHue
    if (sky && snapshot.skyHue !== null) sky.hueShift = snapshot.skyHue
    this.graphicsSnapshot = null
  }

  private prefetchAhead(now: number): void {
    if (now - this.lastPrefetchAt < 1_350 || this.viewer.imageryLayers.length === 0) return
    this.lastPrefetchAt = now

    const baseLayer = this.viewer.imageryLayers.get(0) as ImageryLayer & { imageryProvider: PrefetchProvider }
    const provider = baseLayer?.imageryProvider
    if (!provider?.requestImage || !provider?.tilingScheme?.positionToTileXY) return

    const canvas = this.viewer.scene.canvas
    const width = canvas.clientWidth || canvas.width
    const height = canvas.clientHeight || canvas.height
    this.prefetchPoint.x = width * 0.5
    this.prefetchPoint.y = height * 0.34

    const aheadCartesian = this.viewer.camera.pickEllipsoid(this.prefetchPoint, Ellipsoid.WGS84)
    const cartographic = aheadCartesian
      ? Cartographic.fromCartesian(aheadCartesian)
      : this.viewer.camera.positionCartographic
    if (!cartographic) return

    const level = imageryPrefetchLevel(Math.max(0, this.viewer.camera.positionCartographic.height))
    const tile = provider.tilingScheme.positionToTileXY(cartographic, level, this.tileCoordinate)
    if (!tile) return
    const columns = provider.tilingScheme.getNumberOfXTilesAtLevel(level)
    const rows = provider.tilingScheme.getNumberOfYTilesAtLevel(level)
    if (!Number.isFinite(columns) || !Number.isFinite(rows) || columns <= 0 || rows <= 0) return

    for (let dy = -1; dy <= 1; dy += 1) {
      const y = Math.floor(tile.y) + dy
      if (y < 0 || y >= rows) continue
      for (let dx = -1; dx <= 1; dx += 1) {
        const x = ((Math.floor(tile.x) + dx) % columns + columns) % columns
        try {
          const request = provider.requestImage(x, y, level)
          if (request) void Promise.resolve(request).catch(() => undefined)
        } catch {
          // RequestScheduler/provider throttling is normal while the camera is
          // moving quickly. A future pass will try the neighborhood again.
        }
      }
    }
  }

  private resolveLayer(now: number, force: boolean): void {
    if (this.layer || (!force && now - this.lastSearchAt < 2_000)) return
    this.lastSearchAt = now
    const layers = this.viewer.imageryLayers
    for (let index = 0; index < layers.length; index += 1) {
      const candidate = layers.get(index) as TunableLayer
      if (!isNasaNightLightsLayer(candidate)) continue
      this.layer = candidate
      this.snapshot = {
        show: candidate.show,
        alpha: candidate.alpha,
        dayAlpha: candidate.dayAlpha,
        nightAlpha: candidate.nightAlpha,
        brightness: candidate.brightness,
        contrast: candidate.contrast,
        saturation: candidate.saturation,
        gamma: candidate.gamma,
      }
      candidate.show = false
      candidate.alpha = 0
      candidate.dayAlpha = 0
      candidate.nightAlpha = 0
      return
    }
  }

  private restore(): void {
    if (!this.layer || !this.snapshot || this.viewer.isDestroyed()) return
    this.layer.show = this.snapshot.show
    this.layer.alpha = this.snapshot.alpha
    this.layer.dayAlpha = this.snapshot.dayAlpha
    this.layer.nightAlpha = this.snapshot.nightAlpha
    this.layer.brightness = this.snapshot.brightness
    this.layer.contrast = this.snapshot.contrast
    this.layer.saturation = this.snapshot.saturation
    this.layer.gamma = this.snapshot.gamma
  }
}
