import type { OmmRecord } from './types'

export interface OrbitalCatalogEntry {
  id: string
  noradId: string
  noradNumericId: number
  name: string
  objectType: string
  omm: OmmRecord
}

export interface CatalogStats {
  received: number
  valid: number
  deduplicated: number
  rejected: number
}

export function normalizeCatalog(records: OmmRecord[]): { entries: OrbitalCatalogEntry[]; stats: CatalogStats } {
  const entries: OrbitalCatalogEntry[] = []
  const seen = new Set<string>()
  let rejected = 0
  for (const omm of records) {
    const numericId = Number(omm.NORAD_CAT_ID)
    if (!Number.isSafeInteger(numericId) || numericId < 0 || !omm.OBJECT_NAME || !omm.EPOCH) {
      rejected += 1
      continue
    }
    const noradId = String(numericId)
    if (seen.has(noradId)) continue
    seen.add(noradId)
    entries.push({
      id: `norad:${noradId}`,
      noradId,
      noradNumericId: numericId,
      name: omm.OBJECT_NAME,
      objectType: omm.OBJECT_TYPE ?? 'UNKNOWN',
      omm,
    })
  }
  return { entries, stats: { received: records.length, valid: entries.length, deduplicated: records.length - rejected - entries.length, rejected } }
}

export function filterCatalog(entries: OrbitalCatalogEntry[], kind: string, query = ''): OrbitalCatalogEntry[] {
  const normalizedQuery = query.trim().toLowerCase()
  return entries.filter((entry) => {
    const type = entry.objectType.toUpperCase()
    const matchesKind = kind === 'ALL' || (kind === 'PAYLOAD' && type === 'PAYLOAD') || (kind === 'ROCKET BODY' && type === 'ROCKET BODY') || (kind === 'DEBRIS' && type === 'DEBRIS')
    const matchesQuery = !normalizedQuery || entry.name.toLowerCase().includes(normalizedQuery) || entry.noradId.includes(normalizedQuery)
    return matchesKind && matchesQuery
  })
}
