import type { OrbitalCatalogEntry } from './orbitalCatalog'

export type RenderMode = 'AUTO' | '1000' | '2500' | '5000' | '10000' | '25000' | 'MAXIMUM' | 'CUSTOM'

export const RENDER_LIMITS: Record<Exclude<RenderMode, 'AUTO' | 'CUSTOM'>, number> = {
  '1000': 1_000, '2500': 2_500, '5000': 5_000, '10000': 10_000, '25000': 25_000, MAXIMUM: 50_000,
}

export interface PerformanceSignal { workerMs: number; applyMs: number; frameP95Ms?: number }

export function resolveRenderLimit(mode: RenderMode, catalogSize: number, autoLimit: number, customLimit: number): number {
  const limit = mode === 'AUTO' ? autoLimit : mode === 'CUSTOM' ? customLimit : RENDER_LIMITS[mode]
  return Math.max(1, Math.min(catalogSize, Math.min(50_000, Math.floor(limit))))
}

export function selectRenderSet(entries: OrbitalCatalogEntry[], limit: number, selectedId: number | null): OrbitalCatalogEntry[] {
  const selected = selectedId === null ? null : entries.find((entry) => entry.noradNumericId === selectedId)
  const result = selected ? [selected] : []
  for (const entry of entries) {
    if (result.length >= limit + (selected ? 1 : 0)) break
    if (!selected || entry.noradNumericId !== selectedId) result.push(entry)
  }
  return result
}

export class AutoRenderController {
  private lastChange = 0
  constructor(public limit = 5_000, private readonly min = 1_000, private readonly max = 10_000, private readonly cooldownMs = 8_000) {}
  update(signal: PerformanceSignal, nowMs: number): number {
    if (nowMs - this.lastChange < this.cooldownMs) return this.limit
    const p95 = signal.frameP95Ms ?? 0
    const poor = p95 > 100 || signal.workerMs > 250 || signal.applyMs > 40
    const healthy = p95 > 0 && p95 < 30 && signal.workerMs < 100 && signal.applyMs < 20
    if (poor && this.limit > this.min) { this.limit = Math.max(this.min, Math.floor(this.limit / 2)); this.lastChange = nowMs }
    else if (healthy && this.limit < this.max) { this.limit = Math.min(this.max, this.limit + 2_500); this.lastChange = nowMs }
    return this.limit
  }
}
