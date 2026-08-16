import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const sizes = process.argv.includes('--objects') ? [Number(process.argv[process.argv.indexOf('--objects') + 1])] : [1000, 5000, 10000, 25000, 50000]
const renderLimit = process.argv.includes('--render-limit') ? Number(process.argv[process.argv.indexOf('--render-limit') + 1]) : null
const port = 5180
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port)], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
let serverOutput = ''
server.stdout.on('data', (chunk) => { serverOutput += chunk.toString() })
server.stderr.on('data', (chunk) => { serverOutput += chunk.toString() })

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { await fetch(`http://127.0.0.1:${port}/`); return } catch { await new Promise((resolve) => setTimeout(resolve, 250)) }
  }
  throw new Error(`Vite did not start${serverOutput ? `: ${serverOutput.trim()}` : ''}`)
}

function summary(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0
  const avg = values.reduce((sum, value) => sum + value, 0) / (values.length || 1)
  return { samples: values.length, average: avg, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: Math.max(...values, 0), fps: 1000 / avg }
}

try {
  await waitForServer()
  const browser = await chromium.launch({ headless: true })
  const results = []
  for (const count of sizes) {
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${port}/?debug=perf&benchmark=${count}${renderLimit ? `&renderLimit=${renderLimit}` : ''}`, { waitUntil: 'load' })
    await page.getByText(/benchmark sintético READY/).waitFor({ timeout: 30000 })
    await page.waitForTimeout(2000)
    const data = await page.evaluate(async () => {
      const frames = []
      const longTasks = []
      const observer = 'PerformanceObserver' in window ? new PerformanceObserver((list) => longTasks.push(...list.getEntries().map((entry) => entry.duration))) : null
      try { observer?.observe({ type: 'longtask', buffered: true }) } catch { /* unsupported */ }
      const started = performance.now()
      let previous = started
      while (performance.now() - started < 3000) {
        await new Promise((resolve) => requestAnimationFrame(resolve))
        const now = performance.now(); frames.push(now - previous); previous = now
      }
      observer?.disconnect()
      return { frames, longTasks, memory: 'memory' in performance ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize } : null }
    })
    const overlay = page.locator('.perf-overlay')
    const workerMs = Number(await overlay.getAttribute('data-worker-ms') ?? 0)
    const applyMs = Number(await overlay.getAttribute('data-apply-ms') ?? 0)
    const transferBytes = Number(await overlay.getAttribute('data-transfer-bytes') ?? 0)
    const loaded = Number(await overlay.getAttribute('data-loaded') ?? count)
    const visible = Number(await overlay.getAttribute('data-visible') ?? count)
    const frame = summary(data.frames)
    results.push({ catalogObjects: loaded, renderedObjects: visible, ...frame, workerMs, applyMs, transferBytes, longTasks: data.longTasks.length, longTaskTotal: data.longTasks.reduce((sum, value) => sum + value, 0), longTaskMax: Math.max(...data.longTasks, 0), memory: data.memory })
    await page.close()
  }
  await browser.close()
  console.table(results.map(({ catalogObjects, renderedObjects, average, p50, p95, p99, fps, workerMs, applyMs, longTasks, longTaskMax }) => ({ catalogObjects, renderedObjects, avgMs: average.toFixed(2), p50: p50.toFixed(2), p95: p95.toFixed(2), p99: p99.toFixed(2), fps: fps.toFixed(1), workerMs: workerMs.toFixed(2), applyMs: applyMs.toFixed(2), longTasks, longTaskMax: longTaskMax.toFixed(1) })))
  await mkdir('artifacts', { recursive: true })
  await writeFile('artifacts/benchmark-results.json', JSON.stringify({ generatedAt: new Date().toISOString(), method: 'Playwright Chromium; 2s warmup + 3s rAF measurement', results }, null, 2))
} catch (error) {
  console.error(`Browser benchmark unavailable: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 2
} finally {
  server.kill('SIGTERM')
}
