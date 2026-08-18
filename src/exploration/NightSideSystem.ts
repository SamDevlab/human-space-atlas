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
}

type TunableLayer = ImageryLayer & {
  alpha: number
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
 * night-light grade. The VIIRS radiance layer nearly disappears in daylight,
 * ramps through civil/twilight conditions, and becomes bright/contrasty over
 * the dark hemisphere.
 */
export function nightLightsVisual(sunlight: number): NightLightsVisual {
  const darkness = smoothstep01((0.72 - clamp(sunlight, 0, 1)) / 0.72)
  return {
    alpha: 0.025 + Math.pow(darkness, 1.25) * 0.955,
    brightness: 1.05 + darkness * 2.15,
    contrast: 1.04 + darkness * 0.58,
    saturation: 0.82 + darkness * 0.34,
    gamma: 0.92 + darkness * 0.08,
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
    || (layers.toLowerCase().includes('daynightband') && url.includes('gibs.earthdata.nasa.gov'))
}

/**
 * Explore-only presentation controller for the existing NASA VIIRS night-light
 * imagery layer. It does not replace the source imagery; it only changes how
 * strongly that real radiance product is presented as the camera crosses the
 * terminator.
 */
export class NightSideSystem {
  private readonly viewer: Viewer
  private layer: TunableLayer | null = null
  private snapshot: NightLayerSnapshot | null = null
  private running = false
  private lastSearchAt = -Infinity
  private readonly screenCenter = new Cartesian2()

  constructor(viewer: Viewer) {
    this.viewer = viewer
  }

  start(): void {
    if (this.running || this.viewer.isDestroyed()) return
    this.running = true
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

    this.layer.show = visual.alpha > 0.03
    this.layer.alpha = visual.alpha
    this.layer.brightness = visual.brightness
    this.layer.contrast = visual.contrast
    this.layer.saturation = visual.saturation
    this.layer.gamma = visual.gamma
  }

  stop(): void {
    if (!this.running) return
    this.running = false
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
        brightness: candidate.brightness,
        contrast: candidate.contrast,
        saturation: candidate.saturation,
        gamma: candidate.gamma,
      }
      return
    }
  }

  private restore(): void {
    if (!this.layer || !this.snapshot || this.viewer.isDestroyed()) return
    this.layer.show = this.snapshot.show
    this.layer.alpha = this.snapshot.alpha
    this.layer.brightness = this.snapshot.brightness
    this.layer.contrast = this.snapshot.contrast
    this.layer.saturation = this.snapshot.saturation
    this.layer.gamma = this.snapshot.gamma
  }
}
