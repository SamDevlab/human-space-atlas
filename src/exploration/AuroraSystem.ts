import {
  Cartesian3,
  Color,
  Material,
  PolylineCollection,
  Viewer,
} from 'cesium'
import { fetchAuroraForecast } from '../lib/api'
import { createAuroraCurtainSeeds, type AuroraForecast } from '../lib/aurora'
import { computeOrbitalLighting } from './OrbitalLighting'

const REFRESH_MS = 5 * 60 * 1000
const MAX_CURTAIN_SEEDS = 420

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function auroraColor(strength: number, darkness: number): Color {
  const blue = Color.fromCssColorString('#62dfff')
  const green = Color.fromCssColorString('#74ffb1')
  const strong = Color.fromCssColorString('#c6ffd7')
  const base = Color.lerp(blue, green, clamp(strength * 1.25, 0, 1), new Color())
  const mixed = strength > 0.78 ? Color.lerp(base, strong, (strength - 0.78) / 0.22, new Color()) : base
  return mixed.withAlpha(clamp((0.16 + strength * 0.68) * (0.2 + darkness * 0.8), 0.04, 0.88))
}

/**
 * NOAA OVATION supplies the geospatial auroral oval. This renderer turns that
 * field into vertical, glowing curtains while preserving the forecast shape.
 * The curtain geometry is intentionally cinematic; NOAA does not provide a 3D
 * volume for the emitted light.
 */
export class AuroraSystem {
  private readonly viewer: Viewer
  private readonly curtains: PolylineCollection
  private running = false
  private destroyed = false
  private refreshTimer: number | null = null
  private loadGeneration = 0
  private forecast: AuroraForecast | null = null

  constructor(viewer: Viewer) {
    this.viewer = viewer
    this.curtains = viewer.scene.primitives.add(new PolylineCollection())
    this.curtains.show = false
  }

  start(): void {
    if (this.destroyed || this.running) return
    this.running = true
    this.curtains.show = true
    void this.refresh()
    this.refreshTimer = window.setInterval(() => void this.refresh(), REFRESH_MS)
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    this.loadGeneration += 1
    if (this.refreshTimer !== null) window.clearInterval(this.refreshTimer)
    this.refreshTimer = null
    this.curtains.show = false
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.stop()
    this.curtains.removeAll()
    if (!this.viewer.isDestroyed()) this.viewer.scene.primitives.remove(this.curtains)
  }

  private async refresh(): Promise<void> {
    const generation = ++this.loadGeneration
    const controller = new AbortController()
    try {
      const forecast = await fetchAuroraForecast(controller.signal)
      if (!this.running || this.destroyed || generation !== this.loadGeneration || this.viewer.isDestroyed()) return
      this.forecast = forecast
      this.rebuild()
    } catch (error) {
      if (this.destroyed || !this.running) return
      console.warn('[Human Space Atlas] NOAA OVATION aurora unavailable', error)
      if (!this.forecast) this.curtains.show = false
    }
  }

  private rebuild(): void {
    if (!this.forecast || this.viewer.isDestroyed()) return
    const seeds = createAuroraCurtainSeeds(this.forecast, MAX_CURTAIN_SEEDS)
    this.curtains.removeAll()

    for (const seed of seeds) {
      const bottom = Cartesian3.fromDegrees(seed.longitudeDeg, seed.latitudeDeg, seed.bottomMeters)
      const middle = Cartesian3.fromDegrees(seed.longitudeDeg, seed.latitudeDeg, seed.bottomMeters + (seed.topMeters - seed.bottomMeters) * 0.52)
      const top = Cartesian3.fromDegrees(seed.longitudeDeg, seed.latitudeDeg, seed.topMeters)
      const sunlight = computeOrbitalLighting(this.viewer.clock.currentTime, bottom).sunlight
      const darkness = 1 - sunlight
      const color = auroraColor(seed.strength, darkness)

      this.curtains.add({
        positions: [bottom, middle, top],
        width: seed.width,
        material: Material.fromType('PolylineGlow', {
          color,
          glowPower: 0.28 + seed.strength * 0.24,
          taperPower: 0.7,
        }),
        show: true,
      })

      // A shallow ribbon joins nearby curtain filaments visually. It is not a
      // second data product; it is a cinematic reconstruction around the NOAA
      // grid anchor that makes the oval read as a continuous auroral sheet.
      const ribbonLatitude = seed.latitudeDeg + (seed.latitudeDeg >= 0 ? 0.12 : -0.12)
      const left = Cartesian3.fromDegrees(seed.longitudeDeg - seed.spanDegrees, ribbonLatitude, seed.bottomMeters + 18_000)
      const center = Cartesian3.fromDegrees(seed.longitudeDeg, ribbonLatitude, seed.bottomMeters + 26_000 + seed.strength * 34_000)
      const right = Cartesian3.fromDegrees(seed.longitudeDeg + seed.spanDegrees, ribbonLatitude, seed.bottomMeters + 18_000)
      this.curtains.add({
        positions: [left, center, right],
        width: Math.max(1, seed.width * 0.72),
        material: Material.fromType('PolylineGlow', {
          color: color.withAlpha(color.alpha * 0.58),
          glowPower: 0.4,
          taperPower: 0.9,
        }),
        show: true,
      })
    }

    this.curtains.show = this.running && seeds.length > 0
    this.viewer.scene.requestRender()
  }
}
