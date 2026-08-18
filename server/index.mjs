import { pathToFileURL } from 'node:url'
import { createApp } from './app.mjs'

export { createApp, fetchWithCache, resetCache } from './app.mjs'

const PORT = Number(process.env.PORT ?? 8787)

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createApp()
  server.listen(PORT, () => {
    console.log(`Human Space Atlas API listening on http://localhost:${PORT}`)
  })
}
