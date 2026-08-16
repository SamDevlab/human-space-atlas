import type { CatalogGroup, CatalogResponse } from './types'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8787'

export async function fetchCatalog(group: CatalogGroup, signal?: AbortSignal): Promise<CatalogResponse> {
  const response = await fetch(`${API_BASE_URL}/api/catalog?group=${encodeURIComponent(group)}`, { signal })
  if (!response.ok) {
    const message = await response.text().catch(() => '')
    throw new Error(`Falha ao carregar catálogo (${response.status}). ${message}`.trim())
  }
  return response.json() as Promise<CatalogResponse>
}
