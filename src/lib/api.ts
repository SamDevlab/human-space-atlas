import type { CatalogGroup, CatalogResponse } from './types'
import type { RawEarthEvent } from './earthEvents'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8787'

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
