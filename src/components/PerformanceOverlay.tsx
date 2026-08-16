import { useEffect, useState } from 'react'

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

export function PerformanceOverlay({ loaded, visible }: { loaded: number; visible: number }) {
  const [frames, setFrames] = useState<number[]>([])
  useEffect(() => {
    let last = performance.now()
    let frame = 0
    let animation = 0
    const tick = (now: number) => {
      const delta = now - last
      last = now
      setFrames((current) => [...current.slice(-119), delta])
      frame += 1
      if (frame < 300) animation = requestAnimationFrame(tick)
    }
    animation = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(animation)
  }, [])
  const average = frames.length ? frames.reduce((sum, value) => sum + value, 0) / frames.length : 0
  const fps = average ? 1000 / average : 0
  return <div className="perf-overlay">
    <strong>PERF DEBUG</strong>
    <span>Objects: {loaded.toLocaleString()} / visible: {visible.toLocaleString()}</span>
    <span>Frame avg: {average.toFixed(1)} ms · p95: {percentile(frames, 0.95).toFixed(1)} ms</span>
    <span>FPS approx: {fps.toFixed(1)} · Worker: ON</span>
    <span>Memory: {('memory' in performance) ? 'available' : 'unavailable'}</span>
  </div>
}
