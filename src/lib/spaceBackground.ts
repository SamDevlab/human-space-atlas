import { SkyBox } from 'cesium'

type SkyFace = 'positiveX' | 'negativeX' | 'positiveY' | 'negativeY' | 'positiveZ' | 'negativeZ'

type Direction = { x: number; y: number; z: number }
type Star = Direction & { brightness: number; warmth: number; size: number }

const SKY_FACE_SIZE = 2048
const STAR_COUNT = 4_600
const SKY_FACES: SkyFace[] = ['positiveX', 'negativeX', 'positiveY', 'negativeY', 'positiveZ', 'negativeZ']

function random(seed: number): () => number {
  let value = seed >>> 0
  return () => {
    value += 0x6d2b79f5
    let next = value
    next = Math.imul(next ^ (next >>> 15), next | 1)
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61)
    return ((next ^ (next >>> 14)) >>> 0) / 4_294_967_296
  }
}

function randomDirection(next: () => number): Direction {
  const z = next() * 2 - 1
  const angle = next() * Math.PI * 2
  const radius = Math.sqrt(Math.max(0, 1 - z * z))
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, z }
}

function createStar(next: () => number): Star {
  const direction = randomDirection(next)
  // A magnitude-like distribution: the overwhelming majority of stars are
  // faint, with only a few bright anchors. This keeps the sky scientific and
  // avoids the uniform "wallpaper" look.
  const magnitudeSample = Math.pow(next(), 3.7)
  const brightness = 0.18 + magnitudeSample * 0.82
  const warmth = next()
  const size = 0.16 + Math.pow(brightness, 2.3) * 1.05
  return { ...direction, brightness, warmth, size }
}

function faceForDirection(direction: Direction): SkyFace {
  const x = Math.abs(direction.x)
  const y = Math.abs(direction.y)
  const z = Math.abs(direction.z)
  if (x >= y && x >= z) return direction.x >= 0 ? 'positiveX' : 'negativeX'
  if (y >= x && y >= z) return direction.y >= 0 ? 'positiveY' : 'negativeY'
  return direction.z >= 0 ? 'positiveZ' : 'negativeZ'
}

function projectDirection(direction: Direction, face: SkyFace): { u: number; v: number } {
  switch (face) {
    case 'positiveX': return { u: -direction.z / Math.abs(direction.x), v: -direction.y / Math.abs(direction.x) }
    case 'negativeX': return { u: direction.z / Math.abs(direction.x), v: -direction.y / Math.abs(direction.x) }
    case 'positiveY': return { u: direction.x / Math.abs(direction.y), v: direction.z / Math.abs(direction.y) }
    case 'negativeY': return { u: direction.x / Math.abs(direction.y), v: -direction.z / Math.abs(direction.y) }
    case 'positiveZ': return { u: direction.x / Math.abs(direction.z), v: -direction.y / Math.abs(direction.z) }
    case 'negativeZ': return { u: -direction.x / Math.abs(direction.z), v: -direction.y / Math.abs(direction.z) }
  }
}

function drawDeepSpaceHaze(context: CanvasRenderingContext2D, size: number, faceIndex: number): void {
  // Subtle broad gradients add depth without a conspicuous nebula texture.
  const gradient = context.createRadialGradient(
    size * (0.18 + (faceIndex % 3) * 0.28),
    size * (0.2 + (faceIndex % 2) * 0.44),
    0,
    size * 0.5,
    size * 0.5,
    size * 0.82,
  )
  gradient.addColorStop(0, 'rgba(32, 64, 99, 0.075)')
  gradient.addColorStop(0.45, 'rgba(12, 27, 51, 0.035)')
  gradient.addColorStop(1, 'rgba(1, 3, 9, 0)')
  context.fillStyle = gradient
  context.fillRect(0, 0, size, size)

  // A nearly imperceptible galactic wash. It is intentionally too subtle to
  // read as an illustrated Milky Way band; it only prevents pure-black space
  // from feeling flat when the Earth occupies a smaller portion of the frame.
  const wash = context.createLinearGradient(0, size * 0.16, size, size * 0.84)
  wash.addColorStop(0, 'rgba(12, 18, 32, 0)')
  wash.addColorStop(0.45, 'rgba(37, 46, 67, 0.026)')
  wash.addColorStop(0.55, 'rgba(33, 43, 63, 0.032)')
  wash.addColorStop(1, 'rgba(12, 18, 32, 0)')
  context.fillStyle = wash
  context.fillRect(0, 0, size, size)
}

function starRgb(warmth: number, brightness: number): string {
  if (warmth < 0.18) return brightness > 0.72 ? '177, 211, 255' : '197, 220, 255'
  if (warmth > 0.86) return brightness > 0.72 ? '255, 222, 183' : '246, 229, 207'
  if (warmth > 0.68) return '247, 238, 221'
  return '224, 235, 255'
}

function renderSkyFace(face: SkyFace, faceIndex: number, stars: Star[]): string {
  const canvas = document.createElement('canvas')
  canvas.width = SKY_FACE_SIZE
  canvas.height = SKY_FACE_SIZE
  const context = canvas.getContext('2d')
  if (!context) return ''

  context.fillStyle = '#01030a'
  context.fillRect(0, 0, SKY_FACE_SIZE, SKY_FACE_SIZE)
  drawDeepSpaceHaze(context, SKY_FACE_SIZE, faceIndex)
  context.globalCompositeOperation = 'screen'

  for (const star of stars) {
    if (faceForDirection(star) !== face) continue
    const projected = projectDirection(star, face)
    const x = (projected.u * 0.5 + 0.5) * SKY_FACE_SIZE
    const y = (1 - (projected.v * 0.5 + 0.5)) * SKY_FACE_SIZE
    if (x < -4 || x > SKY_FACE_SIZE + 4 || y < -4 || y > SKY_FACE_SIZE + 4) continue

    const bright = star.brightness > 0.78
    const radius = star.size * (bright ? 1.15 : 0.82)
    const color = starRgb(star.warmth, star.brightness)
    const alpha = Math.min(0.98, 0.24 + star.brightness * 0.68)
    context.fillStyle = `rgba(${color}, ${alpha})`
    if (bright) {
      context.shadowColor = `rgba(${color}, ${0.16 + star.brightness * 0.24})`
      context.shadowBlur = radius * 2.4
    }
    context.beginPath()
    context.arc(x, y, radius, 0, Math.PI * 2)
    context.fill()
    context.shadowBlur = 0
  }
  context.globalCompositeOperation = 'source-over'
  return canvas.toDataURL('image/png')
}

/**
 * Deterministic high-resolution skybox with a magnitude-weighted star field,
 * restrained color temperature variation and a faint deep-space wash. The
 * generated cubemap remains static, so it adds no per-frame React/Cesium cost.
 */
export function createHighResolutionSpaceSkyBox(): SkyBox {
  const next = random(0x485341)
  const stars = Array.from({ length: STAR_COUNT }, () => createStar(next))
  const sources = Object.fromEntries(SKY_FACES.map((face, index) => [face, renderSkyFace(face, index, stars)]))
  return new SkyBox({ sources, show: true })
}
