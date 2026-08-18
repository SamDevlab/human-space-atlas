import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  Ellipsoid,
  ImageryLayer,
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
 * Explore-only presentation controller for NASA VIIRS plus a tiny forward
 * imagery prefetcher. The prefetcher asks the active base provider for a 3x3
 * neighborhood near the camera's forward ground intersection. Browser/provider
 * caches then satisfy Cesium when that region enters the visible frustum.
 */
export class NightSideSystem {
  private readonly viewer: Viewer
  private layer: TunableLayer | null = null
  private snapshot: NightLayerSnapshot | null = null
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
    this.resolveLayer(performance.now(), true)
  }

  update(shipPosition: Cartesian3, now = performance.now()): void {
    if (!this.running || this.viewer.isDestroyed()) return
    this.resolveLayer(now, false)
    this.prefetchAhead(now)
    if (!this.layer) return

    const canvas = this.viewer.scene.canvas
    this.screenCenter.x = (canvas.clientWidth || canvas.width) * 0.5
    this.screenCenter.y = (canvas.clientHeight || canvas.height) * 0.5
    const lookPoint = this.viewer.camera.pickEllipsoid(this.screenCenter, Ellipsoid.WGS84) ?? shipPosition
    const sunlight = computeOrbitalLighting(this.viewer.clock.currentTime, lookPoint).sunlight
    const visual = nightLightsVisual(sunlight)

    if (this.viewer.scene.globe.tilesLoaded) this.stableFrames = Math.min(8, this.stableFrames + 1)
    else this.stableFrames = Math.max(0, this.stableFrames - 2)

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
  }

  destroy(): void {
    this.stop()
    this.layer = null
    this.snapshot = null
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
