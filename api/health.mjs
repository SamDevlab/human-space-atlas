export default function handler(_req, res) {
  res.statusCode = 200
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify({ ok: true, service: 'human-space-atlas-api', now: new Date().toISOString() }))
}
