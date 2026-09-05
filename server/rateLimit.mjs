import { createHash } from 'node:crypto'

const buckets = new Map()
const WINDOW_MS = 60_000
const DISTRIBUTED_PREFIX = 'hsa:ratelimit:v1'
const DISTRIBUTED_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return current
`

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function maxBuckets() {
  return boundedInteger(process.env.HSA_RATE_LIMIT_MAX_CLIENTS, 2048, 128, 20_000)
}

function generalLimit() {
  return boundedInteger(process.env.HSA_RATE_LIMIT_PER_MINUTE, 180, 10, 10_000)
}

function horizonsLimit() {
  return boundedInteger(process.env.HSA_HORIZONS_RATE_LIMIT_PER_MINUTE, 30, 5, 1000)
}

function distributedTimeoutMs() {
  return boundedInteger(process.env.HSA_RATE_LIMIT_REDIS_TIMEOUT_MS, 1200, 100, 5000)
}

function distributedConfig() {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL ?? null
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN ?? null
  if (!url || !token) return null
  return { url: String(url).replace(/\/+$/, ''), token: String(token) }
}

function evictOldestBucketIfNeeded(nextKey) {
  if (buckets.has(nextKey) || buckets.size < maxBuckets()) return
  const oldestKey = buckets.keys().next().value
  if (oldestKey !== undefined) buckets.delete(oldestKey)
}

function normalizedPolicy({ scope = 'api', limit = 180, windowMs = WINDOW_MS } = {}) {
  return {
    scope: String(scope || 'api').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) || 'api',
    limit: Math.max(1, Math.floor(limit)),
    windowMs: Math.max(1000, Math.floor(windowMs)),
  }
}

function resultForCount(count, policy, resetAt, backend, degraded = false) {
  const remaining = Math.max(0, policy.limit - count)
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))
  return {
    allowed: count <= policy.limit,
    limit: policy.limit,
    remaining,
    resetAt,
    retryAfterSeconds,
    backend,
    degraded,
  }
}

function distributedKey(key, policy, now) {
  const windowNumber = Math.floor(now / policy.windowMs)
  const digest = createHash('sha256').update(String(key)).digest('hex').slice(0, 32)
  return `${DISTRIBUTED_PREFIX}:${policy.scope}:${windowNumber}:${digest}`
}

export function resetRateLimitStore() {
  buckets.clear()
}

export function clientKey(req) {
  const trustProxy = process.env.HSA_TRUST_PROXY === '1' || Boolean(process.env.VERCEL)
  if (trustProxy) {
    const forwarded = req?.headers?.['x-forwarded-for']
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded
    const first = typeof raw === 'string' ? raw.split(',')[0]?.trim() : ''
    if (first && first.length <= 128) return first
  }
  const remoteAddress = req?.socket?.remoteAddress
  return typeof remoteAddress === 'string' && remoteAddress ? remoteAddress : 'unknown'
}

export function rateLimitPolicy(pathname) {
  if (pathname === '/health' || pathname === '/api/health') return null
  if (pathname === '/api/horizons') {
    return { scope: 'horizons', limit: horizonsLimit(), windowMs: WINDOW_MS }
  }
  if (pathname.startsWith('/api/')) {
    return { scope: 'api', limit: generalLimit(), windowMs: WINDOW_MS }
  }
  return null
}

export function consumeRateLimit(key, inputPolicy = {}, now = Date.now(), metadata = {}) {
  const policy = normalizedPolicy(inputPolicy)
  const bucketKey = `${policy.scope}:${key}`
  evictOldestBucketIfNeeded(bucketKey)

  let bucket = buckets.get(bucketKey)
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + policy.windowMs }
    buckets.set(bucketKey, bucket)
  }

  bucket.count += 1
  const result = resultForCount(bucket.count, policy, bucket.resetAt, metadata.backend ?? 'memory', Boolean(metadata.degraded))
  result.retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
  return result
}

export async function consumeDistributedRateLimit(key, inputPolicy = {}, now = Date.now(), fetchImpl = globalThis.fetch) {
  const config = distributedConfig()
  if (!config) return null
  if (typeof fetchImpl !== 'function') throw new Error('Distributed rate limiting requires fetch')

  const policy = normalizedPolicy(inputPolicy)
  const resetAt = (Math.floor(now / policy.windowMs) + 1) * policy.windowMs
  const redisKey = distributedKey(key, policy, now)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), distributedTimeoutMs())

  try {
    const response = await fetchImpl(config.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(['EVAL', DISTRIBUTED_SCRIPT, '1', redisKey, String(policy.windowMs)]),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`Distributed rate limit backend returned ${response.status}`)
    const payload = await response.json()
    const count = Number(payload?.result)
    if (!Number.isFinite(count) || count < 1) throw new Error('Distributed rate limit backend returned an invalid counter')

    const result = resultForCount(count, policy, resetAt, 'redis')
    result.retryAfterSeconds = Math.max(1, Math.ceil((resetAt - now) / 1000))
    return result
  } finally {
    clearTimeout(timer)
  }
}

export async function checkRequestRateLimit(req, pathname, now = Date.now(), fetchImpl = globalThis.fetch) {
  const policy = rateLimitPolicy(pathname)
  if (!policy) return null
  const key = clientKey(req)

  if (distributedConfig()) {
    try {
      const distributed = await consumeDistributedRateLimit(key, policy, now, fetchImpl)
      if (distributed) return distributed
    } catch {
      // Never become unlimited when Redis/KV is unavailable. Each instance falls
      // back to the bounded in-memory limiter until the distributed backend recovers.
      return consumeRateLimit(key, policy, now, { backend: 'memory-fallback', degraded: true })
    }
  }

  return consumeRateLimit(key, policy, now)
}

export function rateLimitHeaders(result) {
  if (!result) return {}
  return {
    'x-ratelimit-limit': String(result.limit),
    'x-ratelimit-remaining': String(result.remaining),
    'x-ratelimit-reset': String(Math.ceil(result.resetAt / 1000)),
    'x-ratelimit-backend': String(result.backend ?? 'memory'),
    ...(result.degraded ? { 'x-ratelimit-degraded': 'true' } : {}),
    ...(result.allowed ? {} : { 'retry-after': String(result.retryAfterSeconds) }),
  }
}
