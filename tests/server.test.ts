import { afterEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import { createApp, resetCache } from '../server/index.mjs'

const catalog = [{ OBJECT_NAME: 'TEST SAT', NORAD_CAT_ID: 100123 }]

async function request(path: string) {
  const app = createApp()
  await new Promise<void>((resolve) => app.listen(0, resolve))
  const address = app.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  try {
    return await new Promise<Response>((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port: address.port, path }, (incoming) => {
        const chunks: Buffer[] = []
        incoming.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        incoming.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode, headers: incoming.headers as Record<string, string> })))
      }).on('error', reject)
    })
  } finally {
    await new Promise<void>((resolve, reject) => app.close((error) => error ? reject(error) : resolve()))
  }
}

afterEach(() => {
  resetCache()
  vi.restoreAllMocks()
})

describe('local API proxy', () => {
  it('proxies CelesTrak JSON and caches within TTL', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(catalog), { status: 200 }))
    const first = await request('/api/catalog?group=stations')
    const second = await request('/api/catalog?group=stations')
    expect(first.status).toBe(200)
    expect((await first.json()).objects).toEqual(catalog)
    expect((await second.json()).cache).toBe('hit')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refreshes the cache after its TTL expires', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(0)
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(catalog), { status: 200 }))
    await request('/api/catalog?group=stations')
    now.mockReturnValue(2 * 60 * 60 * 1000 + 1)
    await request('/api/catalog?group=stations')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('proxies successful JPL Horizons JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ result: '$$SOE\n$$EOE' }), { status: 200 }))
    const response = await request('/api/horizons?command=399&start=2026-08-16&stop=2026-08-17')
    expect(response.status).toBe(200)
    expect((await response.json()).source).toBe('jpl-horizons')
  })

  it('returns structured upstream errors without crashing', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network offline'))
    const response = await request('/api/catalog?group=stations')
    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toMatchObject({ error: 'Upstream data source unavailable' })
  })

  it('handles invalid upstream JSON as a 502', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{bad json', { status: 200 }))
    const response = await request('/api/horizons?command=399')
    expect(response.status).toBe(502)
  })

  it('validates catalog groups and required Horizons command', async () => {
    expect((await request('/api/catalog?group=unknown')).status).toBe(400)
    expect((await request('/api/horizons')).status).toBe(400)
  })
})
