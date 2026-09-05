import { pathToFileURL } from 'node:url'
import {
  createApp as createBaseApp,
  fetchWithCache,
  resetCache as resetBaseCache,
} from './app.mjs'
import {
  checkRequestRateLimit,
  rateLimitHeaders,
  resetRateLimitStore,
} from './rateLimit.mjs'

export { fetchWithCache }

export function resetCache() {
  resetBaseCache()
  resetRateLimitStore()
}

function rejectRateLimited(res, result) {
  res.writeHead(429, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
    ...rateLimitHeaders(result),
  })
  res.end(JSON.stringify({ error: 'Too many requests' }))
}

export function createApp() {
  const server = createBaseApp()
  const requestListeners = server.listeners('request')
  server.removeAllListeners('request')

  server.on('request', async (req, res) => {
    if (req.method !== 'OPTIONS' && req.url) {
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
      const result = await checkRequestRateLimit(req, url.pathname)
      if (result && !result.allowed) {
        return rejectRateLimited(res, result)
      }
    }

    for (const listener of requestListeners) {
      listener.call(server, req, res)
    }
  })

  return server
}

const PORT = Number(process.env.PORT ?? 8787)

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createApp()
  server.listen(PORT, () => {
    console.log(`Human Space Atlas API listening on http://localhost:${PORT}`)
  })
}
