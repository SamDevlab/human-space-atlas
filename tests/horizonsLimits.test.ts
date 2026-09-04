import { describe, expect, it } from 'vitest'

import { validateHorizonsQuery } from '../server/app.mjs'

describe('Horizons query validation', () => {
  it('accepts the application default deep-space query shape', () => {
    const url = new URL('http://localhost/api/horizons?command=-31&start=2026-09-04&stop=2026-09-05&step=1%20h&center=500%4010')
    expect(validateHorizonsQuery(url)).toMatchObject({
      command: '-31',
      start: '2026-09-04',
      stop: '2026-09-05',
      step: '1 h',
      center: '500@10',
    })
  })

  it('rejects arbitrary command text and unsupported centers', () => {
    expect(validateHorizonsQuery(new URL('http://localhost/api/horizons?command=abc')).error).toBe('Invalid command parameter')
    expect(
      validateHorizonsQuery(
        new URL('http://localhost/api/horizons?command=399&start=2026-09-04&stop=2026-09-05&center=anything'),
      ).error,
    ).toBe('Invalid center parameter')
  })

  it('rejects oversized date windows and high-cardinality step values', () => {
    expect(
      validateHorizonsQuery(
        new URL('http://localhost/api/horizons?command=399&start=2026-01-01&stop=2026-12-31'),
      ).error,
    ).toContain('range exceeds')
    expect(
      validateHorizonsQuery(
        new URL('http://localhost/api/horizons?command=399&start=2026-09-04&stop=2026-09-05&step=17%20minutes'),
      ).error,
    ).toBe('Unsupported step')
  })
})
