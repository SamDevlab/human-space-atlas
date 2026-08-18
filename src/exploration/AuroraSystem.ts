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
const MAX_CURTAIN_SEEDS = 280

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function hash01(x: number, y: number): number {
  const value = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123
  return value - Math.floor(value)
}

function auroraColor(strength: number, darkness: number): Color {
  const blue = Color.fromCssColorString('#62dfff')
  const green = Color.fromCssColorString('#74ffb1')
  const strong = Color.fromCssColorString('#d7ffe2')
  const base = Color.lerp(blue, green, clamp(strength * 1.25, 0, 1), new Color())
  const mixed = strength > 0.78 ? Color.lerp(base, strong, (strength - 0.78) / 0.22, new Color()) : base
  return mixed.withAlpha(clamp((0.13 + strength * 0.62) * (0.16 + darkness * 0.84), 0.025, 0.82))
}

function shiftedLongitude(longitude: number, offset: number): number {
  return ((longitude + offset + 180) % 360 + 360) % 360 - 180
}

/**
 * NOAA OVATION supplies the geospatial auroral oval. This renderer turns that
 * field into several separated filaments per seed so the sheet has real depth
 * and parallax from orbit. NOAA still defines the macro footprint/strength;
 * the vertical layering is a cinematic reconstruction, not measured 3D data.
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
      const keyX = Math.round(seed.longitudeDeg * 10)
      const keyY = Math.round(seed.latitudeDeg * 10)
      const sunlightProbe = Cartesian3.fromDegrees(seed.longitudeDeg, seed.latitudeDeg, seed.bottomMeters)
      const sunlight = computeOrbitalLighting(this.viewer.clock.currentTime, sunlightProbe).sunlight
      const darkness = 1 - sunlight
      const color = auroraColor(seed.strength, darkness)
      const hemisphere = seed.latitudeDeg >= 0 ? 1 : -1
      const sway = (hash01(keyX + 17, keyY + 31) - 0.5) * 0.34
      const verticalSpan = Math.max(20_000, seed.topMeters - seed.bottomMeters)

      const filamentOffsets = [
        { lon: -seed.spanDegrees * 0.26, lat: -0.08 * hemisphere, base: 0.04, top: -0.08, alpha: 0.38, width: 0.58 },
        { lon: 0, lat: 0, base: 0, top: 0.04, alpha: 1, width: 1 },
        { lon: seed.spanDegrees * 0.24, lat: 0.09 * hemisphere, base: 0.08, top: 0.12, alpha: 0.48, width: 0.66 },
      ] as const

      for (const [index, filament] of filamentOffsets.entries()) {
        const longitude = shiftedLongitude(seed.longitudeDeg, filament.lon + sway * (index - 1))
        const latitude = clamp(seed.latitudeDeg + filament.lat, -89.5, 89.5)
        const bottomMeters = seed.bottomMeters + verticalSpan * filament.base
        const topMeters = seed.topMeters + verticalSpan * filament.top
        const middleMeters = bottomMeters + (topMeters - bottomMeters) * (0.46 + index * 0.04)
        const lateral = seed.spanDegrees * (0.12 + index * 0.025)
        const bottom = Cartesian3.fromDegrees(longitude - lateral * 0.12, latitude, bottomMeters)
        const middle = Cartesian3.fromDegrees(longitude + sway * 0.16, latitude + hemisphere * 0.035, middleMeters)
        const top = Cartesian3.fromDegrees(longitude + lateral * 0.16, latitude, topMeters)
        const filamentColor = color.withAlpha(clamp(color.alpha * filament.alpha, 0.018, 0.82))

        this.curtains.add({
          positions: [bottom, middle, top],
          width: Math.max(1, seed.width * filament.width),
          material: Material.fromType('PolylineGlow', {
            color: filamentColor,
            glowPower: 0.28 + seed.strength * 0.22 + index * 0.035,
            taperPower: 0.78 + index * 0.08,
          }),
          show: true,
        })
      }

      // A dim connective ribbon makes neighboring NOAA anchors read as one
      // continuous oval without turning the effect into an opaque wall.
      const ribbonLatitude = seed.latitudeDeg + hemisphere * 0.12
      const left = Cartesian3.fromDegrees(shiftedLongitude(seed.longitudeDeg, -seed.spanDegrees), ribbonLatitude, seed.bottomMeters + 16_000)
      const center = Cartesian3.fromDegrees(seed.longitudeDeg, ribbonLatitude + hemisphere * 0.035, seed.bottomMeters + 24_000 + seed.strength * 30_000)
      const right = Cartesian3.fromDegrees(shiftedLongitude(seed.longitudeDeg, seed.spanDegrees), ribbonLatitude, seed.bottomMeters + 17_000)
      this.curtains.add({
        positions: [left, center, right],
        width: Math.max(1, seed.width * 0.58),
        material: Material.fromType('PolylineGlow', {
          color: color.withAlpha(color.alpha * 0.36),
          glowPower: 0.34,
          taperPower: 0.96,
        }),
        show: true,
      })
    }

    this.curtains.show = this.running && seeds.length > 0
    this.viewer.scene.requestRender()
  }
}
