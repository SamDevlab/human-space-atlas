import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const port = 5181
const active = [1000, 2500, 5000, 10000, 25000, 50000]
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port)], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
let output = ''
server.stdout.on('data', (chunk) => { output += chunk.toString() })
server.stderr.on('data', (chunk) => { output += chunk.toString() })

async function waitForServer() {
  for (let i = 0; i < 120; i += 1) {
    try { await fetch(`http://127.0.0.1:${port}/`); return } catch { await new Promise((resolve) => setTimeout(resolve, 250)) }
  }
  throw new Error(`Vite did not start${output ? `: ${output.trim()}` : ''}`)
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0
  const average = values.reduce((sum, value) => sum + value, 0) / (values.length || 1)
  return { samples: values.length, average, p50: at(.5), p95: at(.95), p99: at(.99), max: Math.max(...values, 0), fps: 1000 / average }
}

try {
  await waitForServer()
  const browser = await chromium.launch({ headless: false })
  const results = []
  for (const limit of active) {
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${port}/?debug=perf&benchmark=50000&renderLimit=${limit}`, { waitUntil: 'load' })
    await page.getByText(/benchmark sintético READY/).waitFor({ timeout: 30000 })
    const environment = await page.evaluate(() => {
      const canvas = document.querySelector('canvas')
      const gl = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl')
      const debug = gl?.getExtension('WEBGL_debug_renderer_info')
      return { userAgent: navigator.userAgent, resolution: `${innerWidth}x${innerHeight}`, devicePixelRatio, webgl: gl ? { version: gl.getParameter(gl.VERSION), vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR), renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) } : null }
    })
    await page.waitForTimeout(4000)
    const measured = await page.evaluate(async () => {
      const frames = []; const longTasks = []
      const observer = 'PerformanceObserver' in window ? new PerformanceObserver((list) => longTasks.push(...list.getEntries().map((entry) => entry.duration))) : null
      try { observer?.observe({ type: 'longtask', buffered: true }) } catch { /* unsupported */ }
      const start = performance.now(); let previous = start
      while (performance.now() - start < 5000) {
        await new Promise((resolve) => requestAnimationFrame(resolve))
        const now = performance.now(); frames.push(now - previous); previous = now
      }
      observer?.disconnect()
      const sorted = [...frames].sort((a, b) => a - b)
      const at = (p) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0
      const average = frames.reduce((sum, value) => sum + value, 0) / (frames.length || 1)
      return { frame: { samples: frames.length, average, p50: at(.5), p95: at(.95), p99: at(.99), max: Math.max(...frames, 0), fps: 1000 / average }, longTasks, memory: 'memory' in performance ? performance.memory : null }
    })
    const overlay = page.locator('.perf-overlay')
    results.push({ catalogObjects: Number(await overlay.getAttribute('data-loaded') ?? 50000), activeObjects: Number(await overlay.getAttribute('data-visible') ?? limit), limit, workerMs: Number(await overlay.getAttribute('data-worker-ms') ?? 0), applyMs: Number(await overlay.getAttribute('data-apply-ms') ?? 0), environment, ...measured, longTaskCount: measured.longTasks.length, longTaskTotal: measured.longTasks.reduce((a, b) => a + b, 0), longTaskMax: Math.max(...measured.longTasks, 0) })
    await page.close()
  }
  await browser.close()
  console.table(results.map((r) => ({ catalog: r.catalogObjects, active: r.activeObjects, fps: r.frame.fps.toFixed(1), avgMs: r.frame.average.toFixed(2), p95: r.frame.p95.toFixed(2), workerMs: r.workerMs.toFixed(2), applyMs: r.applyMs.toFixed(2), longTasks: r.longTaskCount })))
  await mkdir('artifacts', { recursive: true })
  await writeFile('artifacts/benchmark-headed-results.json', JSON.stringify({ generatedAt: new Date().toISOString(), method: 'headed Chromium; 4s warmup + 5s rAF measurement; 50k catalog', results }, null, 2))
} catch (error) {
  console.error(`Headed browser benchmark unavailable: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 2
} finally { server.kill('SIGTERM') }
