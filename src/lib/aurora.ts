export interface AuroraForecastPoint {
  longitudeDeg: number
  latitudeDeg: number
  intensity: number
}

export interface AuroraForecast {
  source: 'noaa-swpc-ovation'
  fetchedAt: string
  cache: 'hit' | 'miss'
  observationTime: string | null
  forecastTime: string | null
  peak: number
  points: AuroraForecastPoint[]
}

export interface AuroraCurtainSeed extends AuroraForecastPoint {
  strength: number
  bottomMeters: number
  topMeters: number
  spanDegrees: number
  alpha: number
  width: number
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

export function normalizeAuroraForecast(payload: unknown): AuroraForecast {
  const raw = (payload ?? {}) as Record<string, unknown>
  const rawPoints = Array.isArray(raw.points) ? raw.points : []
  const points: AuroraForecastPoint[] = []
  let computedPeak = 0

  for (const point of rawPoints) {
    if (!Array.isArray(point) || point.length < 3) continue
    const longitudeDeg = Number(point[0])
    const latitudeDeg = Number(point[1])
    const intensity = Number(point[2])
    if (!Number.isFinite(longitudeDeg) || !Number.isFinite(latitudeDeg) || !Number.isFinite(intensity)) continue
    if (Math.abs(latitudeDeg) < 45 || intensity <= 0) continue
    computedPeak = Math.max(computedPeak, intensity)
    points.push({ longitudeDeg, latitudeDeg, intensity })
  }

  const declaredPeak = Number(raw.peak)
  return {
    source: 'noaa-swpc-ovation',
    fetchedAt: typeof raw.fetchedAt === 'string' ? raw.fetchedAt : new Date().toISOString(),
    cache: raw.cache === 'hit' ? 'hit' : 'miss',
    observationTime: typeof raw.observationTime === 'string' ? raw.observationTime : null,
    forecastTime: typeof raw.forecastTime === 'string' ? raw.forecastTime : null,
    peak: Number.isFinite(declaredPeak) ? Math.max(declaredPeak, computedPeak) : computedPeak,
    points,
  }
}

/**
 * Convert NOAA OVATION grid values into a bounded cinematic strength. Relative
 * activity keeps a quiet oval visible, while the absolute term prevents a weak
 * forecast from looking as intense as a major event.
 */
export function auroraVisualStrength(intensity: number, peak: number): number {
  if (!Number.isFinite(intensity) || intensity <= 0 || !Number.isFinite(peak) || peak <= 0) return 0
  const relative = Math.sqrt(clamp(intensity / peak, 0, 1))
  const absolute = Math.sqrt(clamp(intensity / 100, 0, 1))
  return clamp(relative * (0.52 + absolute * 0.48), 0, 1)
}

/**
 * Downsample the already-thinned NOAA field into broad curtain anchors. Each
 * geographic cell keeps only its strongest observation so the renderer gets a
 * coherent oval instead of tens of thousands of one-degree spikes.
 */
export function createAuroraCurtainSeeds(forecast: AuroraForecast, maxSeeds = 420): AuroraCurtainSeed[] {
  if (forecast.points.length === 0 || forecast.peak <= 0 || maxSeeds <= 0) return []
  const threshold = Math.max(1, forecast.peak * 0.12)
  const strongestByCell = new Map<string, AuroraForecastPoint>()

  for (const point of forecast.points) {
    if (point.intensity < threshold || Math.abs(point.latitudeDeg) < 48) continue
    const longitudeCell = Math.round(point.longitudeDeg / 4)
    const latitudeCell = Math.round(point.latitudeDeg / 2)
    const key = `${longitudeCell}:${latitudeCell}`
    const current = strongestByCell.get(key)
    if (!current || point.intensity > current.intensity) strongestByCell.set(key, point)
  }

  return [...strongestByCell.values()]
    .sort((left, right) => right.intensity - left.intensity)
    .slice(0, maxSeeds)
    .map((point) => {
      const strength = auroraVisualStrength(point.intensity, forecast.peak)
      return {
        ...point,
        strength,
        bottomMeters: 96_000,
        topMeters: 145_000 + strength * 155_000,
        spanDegrees: 0.8 + strength * 2.4,
        alpha: clamp(0.12 + strength * 0.72, 0.12, 0.84),
        width: 1.2 + strength * 2.8,
      }
    })
}
