import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const memory = new Map()
const inFlight = new Map()
const remoteUrl = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL ?? null
const remoteToken = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN ?? null
const diskEnabled = process.env.NODE_ENV !== 'test' && process.env.HSA_CACHE_DISABLE_DISK !== '1'
const cacheDirectory = process.env.HSA_CACHE_DIR
  ?? (process.env.VERCEL ? path.join(tmpdir(), 'human-space-atlas-cache') : path.join(process.cwd(), '.cache', 'human-space-atlas'))
const REMOTE_PREFIX = 'hsa:v2:'
const parsedMemoryMaxEntries = Number(process.env.HSA_CACHE_MEMORY_MAX_ENTRIES ?? 256)
const memoryMaxEntries = Number.isFinite(parsedMemoryMaxEntries)
  ? Math.max(16, Math.min(4096, Math.floor(parsedMemoryMaxEntries)))
  : 256

function filePathForKey(key) {
  const digest = createHash('sha256').update(key).digest('hex')
  return path.join(cacheDirectory, `${digest}.json`)
}

function remember(key, entry) {
  // Map preserves insertion order. Reinsert hits so eviction approximates LRU
  // without adding another dependency to the small API proxy.
  memory.delete(key)
  memory.set(key, entry)
  while (memory.size > memoryMaxEntries) {
    const oldest = memory.keys().next().value
    if (oldest === undefined) break
    memory.delete(oldest)
  }
}

async function remoteCommand(command) {
  if (!remoteUrl || !remoteToken) return null
  const response = await fetch(remoteUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${remoteToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) throw new Error(`Remote cache ${response.status}`)
  const payload = await response.json()
  return payload?.result ?? null
}

async function readRemote(key) {
  try {
    const value = await remoteCommand(['GET', `${REMOTE_PREFIX}${key}`])
    if (typeof value !== 'string') return null
    return JSON.parse(value)
  } catch {
    return null
  }
}

async function writeRemote(key, entry, retentionMs) {
  try {
    const seconds = Math.max(60, Math.ceil(retentionMs / 1000))
    await remoteCommand(['SET', `${REMOTE_PREFIX}${key}`, JSON.stringify(entry), 'EX', String(seconds)])
  } catch {
    // Remote cache is an optimization. Memory/disk continue to work when the
    // configured KV service is temporarily unavailable.
  }
}

async function readDisk(key) {
  if (!diskEnabled) return null
  try {
    return JSON.parse(await readFile(filePathForKey(key), 'utf8'))
  } catch {
    return null
  }
}

async function writeDisk(key, entry) {
  if (!diskEnabled) return
  try {
    await mkdir(cacheDirectory, { recursive: true })
    await writeFile(filePathForKey(key), JSON.stringify(entry), 'utf8')
  } catch {
    // Read-only/serverless filesystems are allowed; memory and optional KV are
    // still available in that environment.
  }
}

export async function getCacheEntry(key) {
  const memoryEntry = memory.get(key)
  if (memoryEntry) {
    remember(key, memoryEntry)
    return memoryEntry
  }

  const remoteEntry = await readRemote(key)
  if (remoteEntry) {
    remember(key, remoteEntry)
    return remoteEntry
  }

  const diskEntry = await readDisk(key)
  if (diskEntry) {
    remember(key, diskEntry)
    return diskEntry
  }
  return null
}

export async function setCacheEntry(key, entry, retentionMs) {
  remember(key, entry)
  await Promise.allSettled([
    writeDisk(key, entry),
    writeRemote(key, entry, retentionMs),
  ])
}

export function getInFlight(key) {
  return inFlight.get(key) ?? null
}

export function setInFlight(key, promise) {
  inFlight.set(key, promise)
  promise.finally(() => {
    if (inFlight.get(key) === promise) inFlight.delete(key)
  }).catch(() => undefined)
}

export function resetCacheStore() {
  memory.clear()
  inFlight.clear()
  if (diskEnabled) void rm(cacheDirectory, { recursive: true, force: true }).catch(() => undefined)
}

export function cacheCapabilities() {
  return {
    memory: true,
    memoryEntries: memory.size,
    memoryMaxEntries,
    disk: diskEnabled,
    remote: Boolean(remoteUrl && remoteToken),
  }
}
