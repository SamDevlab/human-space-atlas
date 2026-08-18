import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const baseUrl = process.env.HSA_SMOKE_URL ?? 'http://127.0.0.1:5173'
const outputDirectory = path.resolve(process.env.HSA_SMOKE_OUTPUT ?? 'artifacts/earth-smoke')
const headed = process.env.HSA_SMOKE_HEADED === '1'

await mkdir(outputDirectory, { recursive: true })
const browser = await chromium.launch({ headless: !headed })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
const fatal = []

page.on('pageerror', (error) => fatal.push(`pageerror: ${error.message}`))
page.on('console', (message) => {
  if (message.type() !== 'error') return
  const text = message.text()
  if (/webgl|cesium|typeerror|referenceerror|rangeerror/i.test(text)) fatal.push(`console: ${text}`)
})
page.on('requestfailed', (request) => {
  const url = request.url()
  if (url.startsWith(baseUrl) && !/favicon/i.test(url)) fatal.push(`requestfailed: ${url} (${request.failure()?.errorText ?? 'unknown'})`)
})

try {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  const canvas = page.locator('.cesium-widget canvas').first()
  await canvas.waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(8_000)

  const atlasMetrics = await canvas.evaluate((element) => ({
    width: element.clientWidth,
    height: element.clientHeight,
    backingWidth: element.width,
    backingHeight: element.height,
  }))
  if (atlasMetrics.width < 300 || atlasMetrics.height < 200 || atlasMetrics.backingWidth < 300 || atlasMetrics.backingHeight < 200) {
    fatal.push(`invalid Cesium canvas size: ${JSON.stringify(atlasMetrics)}`)
  }
  await page.screenshot({ path: path.join(outputDirectory, 'atlas.png'), fullPage: true })

  const exploreButton = page.locator('button.mode-toggle').first()
  if (await exploreButton.count()) {
    await exploreButton.click()
    const exploreHud = page.locator('.exploration-hud').first()
    await exploreHud.waitFor({ state: 'visible', timeout: 15_000 })
    await page.waitForTimeout(10_000)
    await page.screenshot({ path: path.join(outputDirectory, 'explore.png'), fullPage: true })
  }

  const runtime = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    visibilityState: document.visibilityState,
    canvasCount: document.querySelectorAll('.cesium-widget canvas').length,
  }))
  console.log(JSON.stringify({ baseUrl, atlasMetrics, runtime, fatal }, null, 2))

  if (fatal.length > 0) process.exitCode = 1
} finally {
  await browser.close()
}
