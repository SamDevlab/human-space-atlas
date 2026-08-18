import { describe, expect, it, vi } from 'vitest'
import type { ImageryProvider } from 'cesium'
import { imageryWarmupMaxLevel, warmImageryProvider } from '../src/lib/mapStyles'

function fakeProvider() {
  const requestImage = vi.fn(() => Promise.resolve({}))
  const provider = {
    tilingScheme: {
      getNumberOfXTilesAtLevel: (level: number) => 2 ** (level + 1),
      getNumberOfYTilesAtLevel: (level: number) => 2 ** level,
    },
    requestImage,
  } as unknown as ImageryProvider
  return { provider, requestImage }
}

describe('map style texture streaming', () => {
  it('uses a conservative warmup level outside the browser', () => {
    expect(imageryWarmupMaxLevel()).toBe(1)
  })

  it('warms complete coarse ancestors before a style is exposed', async () => {
    const { provider, requestImage } = fakeProvider()
    await warmImageryProvider(provider, 1)
    expect(requestImage).toHaveBeenCalledTimes(10)
    expect(requestImage).toHaveBeenCalledWith(0, 0, 0)
  })

  it('never exceeds the fixed warmup request budget', async () => {
    const { provider, requestImage } = fakeProvider()
    await warmImageryProvider(provider, 2)
    expect(requestImage).toHaveBeenCalledTimes(28)
  })
})
