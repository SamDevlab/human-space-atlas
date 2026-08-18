import {
  Cartesian2,
  Cartesian3,
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

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function smoothstep01(value: number): number {
  const clamped = clamp(value, 0, 1)
  return clamped * clamped * (3 - 2 * clamped)
}

/**
 * Converts direct sunlight at the center of the current Earth view into a
 * night-light grade. Daylight is now truly transparent instead of leaving a
 * low-alpha tiled overlay that can reveal provider placeholders while loading.
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
 * Explore-only presentation controller for the existing NASA VIIRS night-light
 * imagery layer. The overlay is kept nearly invisible while Cesium still has
 * terrain/imagery requests in flight, which prevents bright rectangular tile
 * placeholders from flashing over the surface during fast low-orbit motion.
 */
export class NightSideSystem {
  private readonly viewer: Viewer
  private layer: TunableLayer | null = null
  private snapshot: NightLayerSnapshot | null = null
  private running = false
  private lastSearchAt = -Infinity
  private stableFrames = 0
  private readonly screenCenter = new Cartesian2()

  constructor(viewer: Viewer) {
    this.viewer = viewer
  }

  start(): void {
    if (this.running || this.viewer.isDestroyed()) return
    this.running = true
    this.stableFrames = 0
    this.resolveLayer(performance.now(), true)
  }

  update(shipPosition: Cartesian3, now = performance.now()): void {
    if (!this.running || this.viewer.isDestroyed()) return
    this.resolveLayer(now, false)
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
    // Cesium can blend imagery separately on the lit and dark hemispheres.
    // Keeping dayAlpha at zero also prevents a night-light tile from flashing
    // white on the sunlit side before its transparency is fully established.
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
      // Suppress the provider's default presentation immediately. update()
      // will fade it back only after the current globe view is tile-complete.
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
