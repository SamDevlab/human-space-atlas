import { useEffect, useState } from 'react'
import { summarizeDurations } from '../lib/performanceStats'

export function PerformanceOverlay({ loaded, visible, workerMs, applyMs, transferBytes, pending }: { loaded: number; visible: number; workerMs: number; applyMs: number; transferBytes: number; pending: number }) {
  const [frames, setFrames] = useState<number[]>([])
  const [longTasks, setLongTasks] = useState<number[]>([])
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
    const observer = 'PerformanceObserver' in window ? new PerformanceObserver((list) => setLongTasks((current) => [...current, ...list.getEntries().map((entry) => entry.duration)])) : null
    observer?.observe({ type: 'longtask', buffered: true })
    return () => { cancelAnimationFrame(animation); observer?.disconnect() }
  }, [])
  const frame = summarizeDurations(frames)
  const long = summarizeDurations(longTasks)
  return <div className="perf-overlay" data-loaded={loaded} data-visible={visible} data-worker-ms={workerMs} data-apply-ms={applyMs} data-transfer-bytes={transferBytes} data-pending={pending} data-frame-average={frame.average} data-frame-p95={frame.p95}>
    <strong>PERF DEBUG</strong>
    <span>Objects: {loaded.toLocaleString()} / visible: {visible.toLocaleString()}</span>
    <span>Frame avg: {frame.average.toFixed(1)} · p50: {frame.p50.toFixed(1)} · p95: {frame.p95.toFixed(1)} · p99: {frame.p99.toFixed(1)} ms</span>
    <span>FPS: {frame.fps.toFixed(1)} · max: {frame.max.toFixed(1)} ms</span>
    <span>Worker: {workerMs.toFixed(1)} ms · pending: {pending}</span>
    <span>Apply: {applyMs.toFixed(1)} ms · transfer: {transferBytes.toLocaleString()} B</span>
    <span>Long tasks: {long.count} · max: {long.max.toFixed(1)} ms</span>
    <span>Memory: {('memory' in performance) ? 'available' : 'unavailable'}</span>
  </div>
}
