import { createSatrec, getOrbitState, toCesiumHeightMeters } from '../lib/orbit'
import type { OmmRecord } from '../lib/types'
import type { WorkerCommand, WorkerResult } from './orbitProtocol'
import { LatestOnlyQueue } from './latestOnlyQueue'

let generation = 0
let satrecs = new Map<number, ReturnType<typeof createSatrec>>()
const requests = new LatestOnlyQueue<{ generation: number; requestId: number; timeMs: number }>()

async function propagate(command: { generation: number; requestId: number; timeMs: number }): Promise<void> {
  if (command.generation !== generation) {
    const next = requests.complete()
    if (next) queueMicrotask(() => { void propagate(next) })
    return
  }
  const started = performance.now()
  const ids: number[] = []
  const values = new Float64Array(satrecs.size * 3)
  let offset = 0
  let processed = 0
  for (const [id, satrec] of satrecs) {
    const state = getOrbitState(satrec, new Date(command.timeMs))
    if (!state) continue
    ids.push(id)
    values[offset++] = state.longitudeDeg
    values[offset++] = state.latitudeDeg
    values[offset++] = toCesiumHeightMeters(state.altitudeKm)
    processed += 1
    if (processed % 256 === 0) await new Promise((resolve) => setTimeout(resolve, 0))
  }
  const packed = values.slice(0, offset)
  const result: WorkerResult = { type: 'POSITIONS', generation, requestId: command.requestId, ids, values: packed, elapsedMs: performance.now() - started }
  self.postMessage(result, { transfer: [packed.buffer] })
  const next = requests.complete()
  if (next) queueMicrotask(() => { void propagate(next) })
}

self.onmessage = (event: MessageEvent<WorkerCommand>) => {
  const command = event.data
  try {
    if (command.type === 'LOAD_CATALOG') {
      generation = command.generation
      requests.clear()
      satrecs = new Map()
      let rejectedCount = 0
      for (const object of command.objects) {
        try { satrecs.set(object.NORAD_CAT_ID, createSatrec(object)) } catch { rejectedCount += 1 }
      }
      const result: WorkerResult = { type: 'READY', generation, validCount: satrecs.size, rejectedCount }
      self.postMessage(result)
      return
    }
    if (command.type === 'PROPAGATE') {
      const next = requests.submit({ generation: command.generation, requestId: command.requestId, timeMs: command.timeMs })
      if (next) void propagate(next)
      return
    }
    if (command.type === 'DISPOSE') {
      satrecs.clear()
      self.close()
    }
  } catch (error) {
    const result: WorkerResult = { type: 'ERROR', generation, message: error instanceof Error ? error.message : String(error) }
    self.postMessage(result)
  }
}
