import { SkyBox } from 'cesium'

type SkyFace = 'positiveX' | 'negativeX' | 'positiveY' | 'negativeY' | 'positiveZ' | 'negativeZ'

type Direction = { x: number; y: number; z: number }

const SKY_FACE_SIZE = 1536
const STAR_COUNT = 4_200
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

function drawNebulaHint(context: CanvasRenderingContext2D, size: number, faceIndex: number): void {
  // A very restrained haze keeps the background dimensional without turning
  // the sky into a noisy wallpaper. Stars remain the sharp visual element.
  const gradient = context.createRadialGradient(
    size * (0.18 + (faceIndex % 3) * 0.28),
    size * (0.2 + (faceIndex % 2) * 0.44),
    0,
    size * 0.5,
    size * 0.5,
    size * 0.75,
  )
  gradient.addColorStop(0, 'rgba(39, 83, 126, 0.12)')
  gradient.addColorStop(0.42, 'rgba(16, 38, 69, 0.055)')
  gradient.addColorStop(1, 'rgba(2, 6, 14, 0)')
  context.fillStyle = gradient
  context.fillRect(0, 0, size, size)
}

function renderSkyFace(face: SkyFace, faceIndex: number, stars: Direction[]): string {
  const canvas = document.createElement('canvas')
  canvas.width = SKY_FACE_SIZE
  canvas.height = SKY_FACE_SIZE
  const context = canvas.getContext('2d')
  if (!context) return ''

  context.fillStyle = '#01040b'
  context.fillRect(0, 0, SKY_FACE_SIZE, SKY_FACE_SIZE)
  drawNebulaHint(context, SKY_FACE_SIZE, faceIndex)
  context.globalCompositeOperation = 'screen'

  for (const direction of stars) {
    if (faceForDirection(direction) !== face) continue
    const projected = projectDirection(direction, face)
    const x = (projected.u * 0.5 + 0.5) * SKY_FACE_SIZE
    const y = (1 - (projected.v * 0.5 + 0.5)) * SKY_FACE_SIZE
    if (x < -4 || x > SKY_FACE_SIZE + 4 || y < -4 || y > SKY_FACE_SIZE + 4) continue

    const brightness = Math.max(0.35, Math.min(1, 0.35 + Math.abs(direction.x * 0.7 + direction.y * 0.2 + direction.z * 0.4)))
    const largeStar = brightness > 0.78
    const radius = largeStar ? 1.1 + brightness * 1.25 : 0.35 + brightness * 0.55
    const color = largeStar ? '198, 226, 255' : '224, 235, 255'
    context.fillStyle = `rgba(${color}, ${0.45 + brightness * 0.5})`
    if (largeStar) {
      context.shadowColor = `rgba(138, 205, 255, ${0.35 + brightness * 0.25})`
      context.shadowBlur = radius * 3.5
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
 * Replace Cesium's tiny default star map with a sharper, deterministic sky.
 * The six faces are generated once at startup and then rendered by Cesium's
 * normal cubemap path, so the result stays crisp while the camera rotates.
 */
export function createHighResolutionSpaceSkyBox(): SkyBox {
  const next = random(0x485341)
  const stars = Array.from({ length: STAR_COUNT }, () => randomDirection(next))
  const sources = Object.fromEntries(SKY_FACES.map((face, index) => [face, renderSkyFace(face, index, stars)]))
  return new SkyBox({ sources, show: true })
}
