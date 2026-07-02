import { DEFAULT_PATCH, sanitizePatch, type GrainPatch } from '../audio/contracts'
import type { MotionData } from '../performance/motion'

// Bump when the Preset envelope (name/schemaVersion/createdAt) changes shape.
// Patch-level migration is delegated to sanitizePatch, which already coerces
// missing/old/invalid GrainPatch fields back into safe ranges.
// v2 adds optional `motion` and `sourceLabel`; v1 presets migrate forward by
// simply lacking those fields (see deserializePreset).
export const PRESET_SCHEMA_VERSION = 2

export interface Preset {
  name: string
  schemaVersion: number
  patch: GrainPatch
  createdAt: number
  // Optional motion automation recording captured alongside the patch.
  motion?: MotionData
  // Optional label of the audio source, used to prompt a relink on load.
  sourceLabel?: string
}

const DEFAULT_PRESET_NAME = 'Untitled'

// createdAt is supplied by the caller (not Date.now here) so serialization stays
// deterministic and testable. The optional `options` arg is appended so the
// existing positional callers keep working unchanged.
export function serializePreset(
  name: string,
  patch: GrainPatch,
  createdAt: number,
  options?: { motion?: MotionData; sourceLabel?: string },
): Preset {
  const preset: Preset = {
    name: coerceName(name),
    schemaVersion: PRESET_SCHEMA_VERSION,
    // Own a sanitized copy so the stored patch never aliases a frozen default
    // and is always within safe ranges.
    patch: sanitizePatch(patch),
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
  }

  // Only attach motion/sourceLabel when given, and clone/validate defensively
  // so the stored preset never aliases caller-owned data or carries garbage.
  const motion = parseMotion(options?.motion)
  if (motion !== undefined) preset.motion = motion

  const sourceLabel = parseSourceLabel(options?.sourceLabel)
  if (sourceLabel !== undefined) preset.sourceLabel = sourceLabel

  return preset
}

// Defensively rebuild a Preset from an unknown value (e.g. parsed from storage).
// Never throws: bad/missing fields fall back to safe defaults, and the patch is
// migrated through sanitizePatch.
export function deserializePreset(raw: unknown): Preset {
  const record = isRecord(raw) ? raw : {}

  const name = coerceName(record.name)

  const schemaVersion = Number.isFinite(record.schemaVersion)
    ? (record.schemaVersion as number)
    : PRESET_SCHEMA_VERSION

  const createdAt = Number.isFinite(record.createdAt)
    ? (record.createdAt as number)
    : 0

  // sanitizePatch fills every field from a partial/invalid candidate, so spread
  // the (possibly empty) raw patch over DEFAULT_PATCH before sanitizing.
  const patchCandidate = isRecord(record.patch)
    ? { ...DEFAULT_PATCH, ...record.patch }
    : DEFAULT_PATCH

  const preset: Preset = {
    name,
    schemaVersion,
    patch: sanitizePatch(patchCandidate as GrainPatch),
    createdAt,
  }

  // v1 presets simply lack these; v2 presets carry them when valid. Bad values
  // (and v1 absence) leave the fields undefined rather than throwing.
  const motion = parseMotion(record.motion)
  if (motion !== undefined) preset.motion = motion

  const sourceLabel = parseSourceLabel(record.sourceLabel)
  if (sourceLabel !== undefined) preset.sourceLabel = sourceLabel

  return preset
}

// Accept only a well-formed MotionData: an object with an array `samples` of
// { tMs, value } finite numbers and a finite `durationMs`. Returns a defensive
// clone, or undefined for anything malformed. Never throws.
export function parseMotion(value: unknown): MotionData | undefined {
  if (!isRecord(value)) return undefined
  if (!Array.isArray(value.samples)) return undefined
  if (!Number.isFinite(value.durationMs)) return undefined

  const samples: MotionData['samples'] = []
  for (const sample of value.samples) {
    if (!isRecord(sample)) return undefined
    if (!Number.isFinite(sample.tMs) || !Number.isFinite(sample.value)) return undefined
    samples.push({ tMs: sample.tMs as number, value: sample.value as number })
  }

  return { samples, durationMs: value.durationMs as number }
}

export function parseSourceLabel(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function coerceName(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_PRESET_NAME
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : DEFAULT_PRESET_NAME
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Thin IndexedDB wrapper for persisting presets keyed by name. IndexedDB is not
// available in the node test environment, so this class is intentionally untested
// there; methods reject with a clear Error when IndexedDB is unavailable.
export class PresetStore {
  private readonly dbName: string
  private readonly storeName: string

  constructor(dbName = 'mgrains', storeName = 'presets') {
    this.dbName = dbName
    this.storeName = storeName
  }

  async save(preset: Preset): Promise<void> {
    const db = await this.open()
    try {
      await this.tx(db, 'readwrite', (store) => store.put(preset, preset.name))
    } finally {
      db.close()
    }
  }

  async load(name: string): Promise<Preset | null> {
    const db = await this.open()
    try {
      const raw = await this.tx(db, 'readonly', (store) => store.get(name))
      return raw === undefined ? null : deserializePreset(raw)
    } finally {
      db.close()
    }
  }

  async list(): Promise<Preset[]> {
    const db = await this.open()
    try {
      const raws = await this.tx(db, 'readonly', (store) => store.getAll())
      return (raws as unknown[]).map((raw) => deserializePreset(raw))
    } finally {
      db.close()
    }
  }

  async delete(name: string): Promise<void> {
    const db = await this.open()
    try {
      await this.tx(db, 'readwrite', (store) => store.delete(name))
    } finally {
      db.close()
    }
  }

  async rename(oldName: string, newName: string): Promise<void> {
    const existing = await this.load(oldName)
    if (existing === null) {
      throw new Error(`PresetStore.rename: no preset named "${oldName}"`)
    }
    await this.save({ ...existing, name: coerceName(newName) })
    if (coerceName(newName) !== oldName) {
      await this.delete(oldName)
    }
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('PresetStore: IndexedDB is not available in this environment'))
        return
      }
      const request = indexedDB.open(this.dbName, 1)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName)
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () =>
        reject(request.error ?? new Error('PresetStore: failed to open IndexedDB'))
    })
  }

  private tx<T>(
    db: IDBDatabase,
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.storeName, mode)
      const store = transaction.objectStore(this.storeName)
      const request = run(store)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () =>
        reject(request.error ?? new Error('PresetStore: IndexedDB request failed'))
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('PresetStore: IndexedDB transaction aborted'))
    })
  }
}
