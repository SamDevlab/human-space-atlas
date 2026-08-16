export function percentile(values: number[], p: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]
}

export function summarizeDurations(values: number[]) {
  const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
  return { count: values.length, average, p50: percentile(values, 0.5), p95: percentile(values, 0.95), p99: percentile(values, 0.99), max: values.length ? Math.max(...values) : 0, fps: average ? 1000 / average : 0 }
}
