import { afterEach, describe, expect, it } from 'vitest'

import {
  clientKey,
  consumeRateLimit,
  rateLimitHeaders,
  rateLimitPolicy,
  resetRateLimitStore,
} from '../server/rateLimit.mjs'

afterEach(() => {
  delete process.env.HSA_RATE_LIMIT_PER_MINUTE
  delete process.env.HSA_HORIZONS_RATE_LIMIT_PER_MINUTE
  delete process.env.HSA_TRUST_PROXY
  delete process.env.VERCEL
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
})
