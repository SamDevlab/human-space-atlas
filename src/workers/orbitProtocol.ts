import type { OmmRecord } from '../lib/types'

export type WorkerCommand =
  | { type: 'LOAD_CATALOG'; generation: number; objects: OmmRecord[] }
  | { type: 'PROPAGATE'; generation: number; requestId: number; timeMs: number }
  | { type: 'DISPOSE' }

export type WorkerResult =
  | { type: 'READY'; generation: number; validCount: number; rejectedCount: number }
  | { type: 'POSITIONS'; generation: number; requestId: number; ids: number[]; values: Float64Array; elapsedMs: number }
  | { type: 'ERROR'; generation: number; message: string }
