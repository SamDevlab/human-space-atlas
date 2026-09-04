import { afterEach, describe, expect, it } from 'vitest'

import {
  cacheCapabilities,
  getCacheEntry,
  resetCacheStore,
  setCacheEntry,
} from '../server/cache.mjs'

afterEach(() => {
  resetCacheStore()
})

describe('API cache bounds', () => {
  it('evicts oldest entries when the memory cache reaches its configured cap', async () => {
    const maxEntries = cacheCapabilities().memoryMaxEntries
    for (let index = 0; index < maxEntries + 25; index += 1) {
      await setCacheEntry(
        `key:${index}`,
        { value: index, storedAt: index, fetchedAt: String(index) },
        60_000,
      )
    }

    expect(cacheCapabilities().memoryEntries).toBe(maxEntries)
    await expect(getCacheEntry('key:0')).resolves.toBeNull()
    await expect(getCacheEntry(`key:${maxEntries + 24}`)).resolves.toMatchObject({ value: maxEntries + 24 })
  })
})
