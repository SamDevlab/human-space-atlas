const API_BASE_URL = import.meta.env.VITE_API_BASE_URL
  ?? (typeof window !== 'undefined' && window.location.hostname !== 'localhost' ? '' : 'http://localhost:8787')

export type DeepSpaceTarget = {
  id: string
  name: string
  command: string
  agency: string
  kind: 'spacecraft' | 'planet'
}

export type HorizonsVector = {
  target: DeepSpaceTarget
  epochLabel: string | null
  positionKm: [number, number, number]
  velocityKmS: [number, number, number]
  distanceFromSunKm: number
  speedKmS: number
  fetchedAt: string
  cache: string
}

export const DEEP_SPACE_TARGETS: DeepSpaceTarget[] = [
  { id: 'voyager-1', name: 'Voyager 1', command: '-31', agency: 'NASA/JPL', kind: 'spacecraft' },
  { id: 'voyager-2', name: 'Voyager 2', command: '-32', agency: 'NASA/JPL', kind: 'spacecraft' },
  { id: 'new-horizons', name: 'New Horizons', command: '-98', agency: 'NASA', kind: 'spacecraft' },
  { id: 'parker', name: 'Parker Solar Probe', command: '-96', agency: 'NASA', kind: 'spacecraft' },
  { id: 'juno', name: 'Juno', command: '-61', agency: 'NASA/JPL', kind: 'spacecraft' },
]

export const SOLAR_ORBIT_RADII_AU = [
  { name: 'Mercúrio', au: 0.387 },
  { name: 'Vênus', au: 0.723 },
  { name: 'Terra', au: 1 },
  { name: 'Marte', au: 1.524 },
  { name: 'Júpiter', au: 5.203 },
  { name: 'Saturno', au: 9.537 },
  { name: 'Urano', au: 19.191 },
  { name: 'Netuno', au: 30.069 },
]

export const ASTRONOMICAL_UNIT_KM = 149_597_870.7

function numberFrom(text: string, label: string): number | null {
  const pattern = new RegExp(`\\b${label}\\s*=\\s*([+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[Ee][+-]?\\d+)?)`, 'i')
  const match = text.match(pattern)
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
}

export function parseHorizonsVector(result: string, target: DeepSpaceTarget, fetchedAt = new Date().toISOString(), cache = 'unknown'): HorizonsVector {
  const start = result.indexOf('$$SOE')
  const end = result.indexOf('$$EOE')
  if (start < 0 || end <= start) throw new Error(`Horizons não retornou vetor utilizável para ${target.name}`)
  const block = result.slice(start + 5, end)
  const x = numberFrom(block, 'X')
  const y = numberFrom(block, 'Y')
  const z = numberFrom(block, 'Z')
  const vx = numberFrom(block, 'VX')
  const vy = numberFrom(block, 'VY')
  const vz = numberFrom(block, 'VZ')
  if ([x, y, z, vx, vy, vz].some((value) => value === null)) throw new Error(`Vetor incompleto do Horizons para ${target.name}`)
  const epochMatch = block.match(/=\s*(A\.D\.[^\n\r]+)/)
  const positionKm: [number, number, number] = [x!, y!, z!]
  const velocityKmS: [number, number, number] = [vx!, vy!, vz!]
  return {
    target,
    epochLabel: epochMatch?.[1]?.trim() ?? null,
    positionKm,
    velocityKmS,
    distanceFromSunKm: Math.hypot(...positionKm),
    speedKmS: Math.hypot(...velocityKmS),
    fetchedAt,
    cache,
  }
}

export async function fetchHorizonsVector(target: DeepSpaceTarget, at = new Date(), signal?: AbortSignal): Promise<HorizonsVector> {
  const start = at.toISOString().slice(0, 10)
  const stop = new Date(at.getTime() + 86_400_000).toISOString().slice(0, 10)
  const params = new URLSearchParams({ command: target.command, start, stop, step: '1 h', center: '500@10' })
  const response = await fetch(`${API_BASE_URL}/api/horizons?${params}`, { signal })
  if (!response.ok) throw new Error(`Horizons indisponível (${response.status})`)
  const payload = await response.json() as { payload?: { result?: string }; fetchedAt?: string; cache?: string }
  const result = payload.payload?.result
  if (typeof result !== 'string') throw new Error('Resposta do Horizons sem campo result')
  return parseHorizonsVector(result, target, payload.fetchedAt, payload.cache)
}

export function distanceBetweenVectorsKm(a: HorizonsVector, b: HorizonsVector): number {
  return Math.hypot(
    a.positionKm[0] - b.positionKm[0],
    a.positionKm[1] - b.positionKm[1],
    a.positionKm[2] - b.positionKm[2],
  )
}

export const EARTH_HORIZONS_TARGET: DeepSpaceTarget = { id: 'earth', name: 'Earth', command: '399', agency: 'NASA/JPL', kind: 'planet' }
