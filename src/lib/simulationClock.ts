export function advanceSimulatedTime(simulatedAtMs: number, realElapsedMs: number, speed: number): number {
  if (![simulatedAtMs, realElapsedMs, speed].every(Number.isFinite)) {
    throw new Error('Clock inputs must be finite')
  }
  return speed === 0 ? simulatedAtMs : simulatedAtMs + realElapsedMs * speed
}
