import http from 'node:http'
import { URL, pathToFileURL } from 'node:url'

const PORT = Number(process.env.PORT ?? 8787)
const CACHE_TTL_MS = 2 * 60 * 60 * 1000
const EVENT_CACHE_TTL_MS = 15 * 60 * 1000
const AIRCRAFT_CACHE_TTL_MS = 15 * 1000
const CATALOG_GROUPS = new Set(['stations', 'active', 'starlink', 'gps-ops'])
const EONET_STATUSES = new Set(['open', 'closed', 'all'])
const cache = new Map()

export function resetCache() {
  cache.clear()
}

function json(res, status, payload, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(JSON.stringify(payload))
}

export async function fetchWithCache(key, url, ttl = CACHE_TTL_MS) {
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

async function handleEarthEvents(url, res) {
  const status = (url.searchParams.get('status') ?? 'open').toLowerCase()
  if (!EONET_STATUSES.has(status)) return json(res, 400, { error: 'Unsupported event status', allowed: [...EONET_STATUSES] })
  const rawDays = Number(url.searchParams.get('days') ?? 30)
  const rawLimit = Number(url.searchParams.get('limit') ?? 500)
  const days = Number.isFinite(rawDays) ? Math.max(1, Math.min(60, rawDays)) : 30
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(500, rawLimit)) : 500
  const upstream = new URL('https://eonet.gsfc.nasa.gov/api/v3/events')
  upstream.searchParams.set('status', status)
  upstream.searchParams.set('days', String(days))
  upstream.searchParams.set('limit', String(limit))
  const result = await fetchWithCache(`eonet:${upstream.searchParams.toString()}`, upstream, EVENT_CACHE_TTL_MS)
  return json(res, 200, {
    source: 'nasa-eonet-v3',
    fetchedAt: result.fetchedAt,
    cache: result.cache,
    status,
    days,
    events: Array.isArray(result.value?.events) ? result.value.events : [],
  })
}

function normalizeAircraftStates(payload, limit) {
  const states = Array.isArray(payload?.states) ? payload.states : []
  return states
    .filter((state) => Array.isArray(state) && typeof state[0] === 'string' && Number.isFinite(state[5]) && Number.isFinite(state[6]))
    .map((state) => {
      const altitudeMeters = Number.isFinite(state[13]) ? state[13] : state[7]
      return {
        icao24: state[0].trim().toLowerCase(),
        callsign: typeof state[1] === 'string' ? state[1].trim() || null : null,
        originCountry: typeof state[2] === 'string' ? state[2] : null,
        longitudeDeg: state[5],
        latitudeDeg: state[6],
        altitudeMeters,
        velocityMetersPerSecond: state[9],
        trueTrackDeg: Number.isFinite(state[10]) ? state[10] : null,
        verticalRateMetersPerSecond: Number.isFinite(state[11]) ? state[11] : 0,
        lastContact: state[4],
        category: Number.isFinite(state[17]) ? state[17] : null,
        onGround: state[8] === true,
      }
    })
    .filter((state) => !state.onGround && Number.isFinite(state.altitudeMeters) && state.altitudeMeters >= 500 && state.altitudeMeters <= 20_000 && Number.isFinite(state.velocityMetersPerSecond) && state.velocityMetersPerSecond >= 20 && Number.isFinite(state.lastContact))
    .sort((a, b) => b.altitudeMeters - a.altitudeMeters)
    .slice(0, limit)
    .map(({ onGround: _onGround, ...state }) => state)
}

async function handleAircraftStates(url, res) {
  const rawLimit = Number(url.searchParams.get('limit') ?? 180)
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(500, Math.floor(rawLimit))) : 180
  const upstream = 'https://opensky-network.org/api/states/all?extended=1'
  const result = await fetchWithCache('opensky:states:all', upstream, AIRCRAFT_CACHE_TTL_MS)
  return json(res, 200, {
    source: 'opensky',
    fetchedAt: result.fetchedAt,
    cache: result.cache,
    states: normalizeAircraftStates(result.value, limit),
  })
}

export function createApp() {
  return http.createServer(async (req, res) => {
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
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/api/health')) {
      return json(res, 200, { ok: true, service: 'human-space-atlas-api', now: new Date().toISOString() })
    }
    if (req.method === 'GET' && url.pathname === '/api/catalog') return await handleCatalog(url, res)
    if (req.method === 'GET' && url.pathname === '/api/horizons') return await handleHorizons(url, res)
    if (req.method === 'GET' && url.pathname === '/api/earth/events') return await handleEarthEvents(url, res)
    if (req.method === 'GET' && url.pathname === '/api/aircraft/states') return await handleAircraftStates(url, res)
    return json(res, 404, { error: 'Not found' })
  } catch (error) {
    console.error(error)
    return json(res, 502, {
      error: 'Upstream data source unavailable',
      detail: error instanceof Error ? error.message : String(error),
    })
  }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createApp()
  server.listen(PORT, () => {
    console.log(`Human Space Atlas API listening on http://localhost:${PORT}`)
  })
}
