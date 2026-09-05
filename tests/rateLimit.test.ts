import { afterEach, describe, expect, it } from 'vitest'

import {
  checkRequestRateLimit,
  clientKey,
  consumeDistributedRateLimit,
  consumeRateLimit,
  rateLimitHeaders,
  rateLimitPolicy,
  resetRateLimitStore,
} from '../server/rateLimit.mjs'

afterEach(() => {
  delete process.env.HSA_RATE_LIMIT_PER_MINUTE
  delete process.env.HSA_HORIZONS_RATE_LIMIT_PER_MINUTE
  delete process.env.HSA_RATE_LIMIT_REDIS_TIMEOUT_MS
  delete process.env.HSA_TRUST_PROXY
  delete process.env.VERCEL
  delete process.env.KV_REST_API_URL
  delete process.env.KV_REST_API_TOKEN
  delete process.env.UPSTASH_REDIS_REST_URL
  delete process.env.UPSTASH_REDIS_REST_TOKEN
  resetRateLimitStore()
})

describe('API rate limiting', () => {
  it('blocks requests after the configured window budget and resets on the next window', () => {
    const policy = { scope: 'api', limit: 2, windowMs: 60_000 }

    expect(consumeRateLimit('client-a', policy, 1_000).allowed).toBe(true)
    expect(consumeRateLimit('client-a', policy, 2_000).allowed).toBe(true)
    const blocked = consumeRateLimit('client-a', policy, 3_000)

    expect(blocked.allowed).toBe(false)
    expect(blocked.remaining).toBe(0)
    expect(blocked.backend).toBe('memory')
    expect(rateLimitHeaders(blocked)['retry-after']).toBeDefined()

    const reset = consumeRateLimit('client-a', policy, 61_001)
    expect(reset.allowed).toBe(true)
    expect(reset.remaining).toBe(1)
  })

  it('uses a stricter independent budget for Horizons', () => {
    process.env.HSA_RATE_LIMIT_PER_MINUTE = '200'
    process.env.HSA_HORIZONS_RATE_LIMIT_PER_MINUTE = '12'

    expect(rateLimitPolicy('/api/catalog')).toMatchObject({ scope: 'api', limit: 200 })
    expect(rateLimitPolicy('/api/horizons')).toMatchObject({ scope: 'horizons', limit: 12 })
    expect(rateLimitPolicy('/api/health')).toBeNull()
  })

  it('does not trust forwarded client addresses unless proxy trust is explicit', () => {
    const request = {
      headers: { 'x-forwarded-for': '203.0.113.10, 10.0.0.2' },
      socket: { remoteAddress: '127.0.0.1' },
    }

    expect(clientKey(request)).toBe('127.0.0.1')
    process.env.HSA_TRUST_PROXY = '1'
    expect(clientKey(request)).toBe('203.0.113.10')
  })

  it('uses Redis/KV as the shared counter without exposing the raw client key', async () => {
    process.env.KV_REST_API_URL = 'https://redis.example.test'
    process.env.KV_REST_API_TOKEN = 'secret-token'
    let requestBody: unknown = null
    let authorization = ''
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body))
      authorization = String((init?.headers as Record<string, string>)?.authorization ?? '')
      return {
        ok: true,
        status: 200,
        json: async () => ({ result: 3 }),
      } as Response
    }

    const result = await consumeDistributedRateLimit(
      '203.0.113.77',
      { scope: 'api', limit: 2, windowMs: 60_000 },
      120_000,
      fetchImpl,
    )

    expect(result?.allowed).toBe(false)
    expect(result?.backend).toBe('redis')
    expect(authorization).toBe('Bearer secret-token')
    expect(JSON.stringify(requestBody)).not.toContain('203.0.113.77')
    expect(requestBody).toEqual(expect.arrayContaining(['EVAL', '1', '60000']))
  })

  it('falls back to the bounded memory limiter when the distributed backend fails', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test'
    process.env.UPSTASH_REDIS_REST_TOKEN = 'secret-token'
    process.env.HSA_RATE_LIMIT_PER_MINUTE = '10'
    const request = {
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    }
    const fetchImpl = async () => {
      throw new Error('redis unavailable')
    }

    const result = await checkRequestRateLimit(request, '/api/catalog', 1_000, fetchImpl)

    expect(result).toMatchObject({
      allowed: true,
      backend: 'memory-fallback',
      degraded: true,
      limit: 10,
    })
    expect(rateLimitHeaders(result)['x-ratelimit-degraded']).toBe('true')
  })
})
