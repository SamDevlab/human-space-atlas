const buckets = new Map()
const WINDOW_MS = 60_000

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

function evictOldestBucketIfNeeded(nextKey) {
  if (buckets.has(nextKey) || buckets.size < maxBuckets()) return
  const oldestKey = buckets.keys().next().value
  if (oldestKey !== undefined) buckets.delete(oldestKey)
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

export function consumeRateLimit(key, { scope = 'api', limit = 180, windowMs = WINDOW_MS } = {}, now = Date.now()) {
  const safeLimit = Math.max(1, Math.floor(limit))
  const safeWindowMs = Math.max(1000, Math.floor(windowMs))
  const bucketKey = `${scope}:${key}`
  evictOldestBucketIfNeeded(bucketKey)

  let bucket = buckets.get(bucketKey)
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + safeWindowMs }
    buckets.set(bucketKey, bucket)
  }

  bucket.count += 1
  const remaining = Math.max(0, safeLimit - bucket.count)
  const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
  return {
    allowed: bucket.count <= safeLimit,
    limit: safeLimit,
    remaining,
    resetAt: bucket.resetAt,
    retryAfterSeconds,
  }
}

export function checkRequestRateLimit(req, pathname, now = Date.now()) {
  const policy = rateLimitPolicy(pathname)
  if (!policy) return null
  return consumeRateLimit(clientKey(req), policy, now)
}

export function rateLimitHeaders(result) {
  if (!result) return {}
  return {
    'x-ratelimit-limit': String(result.limit),
    'x-ratelimit-remaining': String(result.remaining),
    'x-ratelimit-reset': String(Math.ceil(result.resetAt / 1000)),
    ...(result.allowed ? {} : { 'retry-after': String(result.retryAfterSeconds) }),
  }
}
