import type { CatalogGroup, CatalogResponse } from './types'
import type { RawEarthEvent } from './earthEvents'
import type { AircraftResponse } from './airTraffic'
import { normalizeAuroraForecast, type AuroraForecast } from './aurora'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL
  ?? (typeof window !== 'undefined' && window.location.hostname !== 'localhost' ? '' : 'http://localhost:8787')

export async function fetchCatalog(group: CatalogGroup, signal?: AbortSignal): Promise<CatalogResponse> {
  const response = await fetch(`${API_BASE_URL}/api/catalog?group=${encodeURIComponent(group)}`, { signal })
  if (!response.ok) {
    const message = await response.text().catch(() => '')
    throw new Error(`Falha ao carregar catálogo (${response.status}). ${message}`.trim())
  }
  return response.json() as Promise<CatalogResponse>
}

export async function fetchEarthEvents(signal?: AbortSignal): Promise<{ events: RawEarthEvent[]; fetchedAt: string; cache: 'hit' | 'miss' }> {
  const response = await fetch(`${API_BASE_URL}/api/earth/events?status=open&days=30&limit=500`, { signal })
  if (!response.ok) {
    const message = await response.text().catch(() => '')
    throw new Error(`Falha ao carregar eventos da Terra (${response.status}). ${message}`.trim())
  }
  const payload = await response.json() as { events?: RawEarthEvent[]; fetchedAt?: string; cache?: 'hit' | 'miss' }
  return { events: Array.isArray(payload.events) ? payload.events : [], fetchedAt: payload.fetchedAt ?? new Date().toISOString(), cache: payload.cache === 'hit' ? 'hit' : 'miss' }
}

export async function fetchAircraftStates(limit = 180, signal?: AbortSignal): Promise<AircraftResponse> {
  const response = await fetch(`${API_BASE_URL}/api/aircraft/states?limit=${encodeURIComponent(limit)}`, { signal })
  if (!response.ok) {
    const message = await response.text().catch(() => '')
    throw new Error(`Falha ao carregar tráfego aéreo (${response.status}). ${message}`.trim())
  }
  const payload = await response.json() as { states?: AircraftResponse['states']; fetchedAt?: string; cache?: 'hit' | 'miss' }
  return {
    source: 'opensky',
    fetchedAt: payload.fetchedAt ?? new Date().toISOString(),
    cache: payload.cache === 'hit' ? 'hit' : 'miss',
    states: Array.isArray(payload.states) ? payload.states.slice(0, Math.max(1, Math.min(500, Math.floor(limit)))) : [],
  }
}

export async function fetchAuroraForecast(signal?: AbortSignal): Promise<AuroraForecast> {
  const response = await fetch(`${API_BASE_URL}/api/space-weather/aurora`, { signal })
  if (!response.ok) {
    const message = await response.text().catch(() => '')
    throw new Error(`Falha ao carregar previsão de aurora NOAA (${response.status}). ${message}`.trim())
  }
  return normalizeAuroraForecast(await response.json())
}
