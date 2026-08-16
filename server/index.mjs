import http from 'node:http'
import { URL } from 'node:url'

const PORT = Number(process.env.PORT ?? 8787)
const CACHE_TTL_MS = 2 * 60 * 60 * 1000
const CATALOG_GROUPS = new Set(['stations', 'active', 'starlink', 'gps-ops'])
const cache = new Map()

function json(res, status, payload, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(JSON.stringify(payload))
}

async function fetchWithCache(key, url, ttl = CACHE_TTL_MS) {
  const now = Date.now()
  const cached = cache.get(key)
  if (cached && now - cached.storedAt < ttl) {
    return { value: cached.value, cache: 'hit', fetchedAt: cached.fetchedAt }
  }

  const response = await fetch(url, {
    headers: {
      'user-agent': 'human-space-atlas/0.1 (+https://github.com/)',
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(30_000),
  })

  if (!response.ok) {
    throw new Error(`Upstream ${response.status}: ${await response.text()}`)
  }

  const value = await response.json()
  const fetchedAt = new Date().toISOString()
  cache.set(key, { value, storedAt: now, fetchedAt })
  return { value, cache: 'miss', fetchedAt }
}

async function handleCatalog(url, res) {
  const group = (url.searchParams.get('group') ?? 'stations').toLowerCase()
  if (!CATALOG_GROUPS.has(group)) {
    return json(res, 400, { error: 'Unsupported group', allowed: [...CATALOG_GROUPS] })
  }

  const upstream = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(group)}&FORMAT=json`
  const result = await fetchWithCache(`celestrak:${group}`, upstream)
  return json(res, 200, {
    source: 'celestrak',
    group,
    fetchedAt: result.fetchedAt,
    cache: result.cache,
    objects: result.value,
  })
}

async function handleHorizons(url, res) {
  const command = url.searchParams.get('command')
  if (!command) return json(res, 400, { error: 'Missing command parameter' })

  const start = url.searchParams.get('start') ?? new Date().toISOString().slice(0, 10)
  const stop = url.searchParams.get('stop') ?? new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
  const step = url.searchParams.get('step') ?? '1 h'
  const center = url.searchParams.get('center') ?? '500@10'

  const upstream = new URL('https://ssd.jpl.nasa.gov/api/horizons.api')
  upstream.searchParams.set('format', 'json')
  upstream.searchParams.set('COMMAND', `'${command}'`)
  upstream.searchParams.set('EPHEM_TYPE', 'VECTORS')
  upstream.searchParams.set('CENTER', `'${center}'`)
  upstream.searchParams.set('START_TIME', `'${start}'`)
  upstream.searchParams.set('STOP_TIME', `'${stop}'`)
  upstream.searchParams.set('STEP_SIZE', `'${step}'`)
  upstream.searchParams.set('OUT_UNITS', 'KM-S')

  const key = `horizons:${upstream.searchParams.toString()}`
  const result = await fetchWithCache(key, upstream, 60 * 60 * 1000)
  return json(res, 200, {
    source: 'jpl-horizons',
    fetchedAt: result.fetchedAt,
    cache: result.cache,
    payload: result.value,
  })
}

const server = http.createServer(async (req, res) => {
  if (!req.url) return json(res, 400, { error: 'Missing URL' })

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,OPTIONS',
      'access-control-allow-headers': 'content-type',
    })
    return res.end()
  }

  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)

  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, service: 'human-space-atlas-api', now: new Date().toISOString() })
    }
    if (req.method === 'GET' && url.pathname === '/api/catalog') return await handleCatalog(url, res)
    if (req.method === 'GET' && url.pathname === '/api/horizons') return await handleHorizons(url, res)
    return json(res, 404, { error: 'Not found' })
  } catch (error) {
    console.error(error)
    return json(res, 502, {
      error: 'Upstream data source unavailable',
      detail: error instanceof Error ? error.message : String(error),
    })
  }
})

server.listen(PORT, () => {
  console.log(`Human Space Atlas API listening on http://localhost:${PORT}`)
})
