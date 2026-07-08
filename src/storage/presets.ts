import { DEFAULT_PATCH, sanitizePatch, type GrainPatch } from '../audio/contracts'
import type { MotionData } from '../performance/motion'
import {
  MAX_MOTION_LANES,
  MOTION_PARAM_TARGETS,
  motionToLanes,
  type MotionLane,
} from '../performance/motionLanes'
import { MACROS } from '../audio/macros'

// Bump when the Preset envelope (name/schemaVersion/createdAt) changes shape.
// Patch-level migration is delegated to sanitizePatch, which already coerces
// missing/old/invalid GrainPatch fields back into safe ranges.
// v2 adds optional `motion` and `sourceLabel`; v1 presets migrate forward by
// simply lacking those fields (see deserializePreset).
// v3: single `motion` recording → multi-lane `motionLanes` (gesture takes).
// Legacy v2 `motion` still parses on load and migrates to a single position lane.
export const PRESET_SCHEMA_VERSION = 3

export interface Preset {
  name: string
  schemaVersion: number
  patch: GrainPatch
  createdAt: number
  // Optional multi-lane gesture recording captured alongside the patch.
  motionLanes?: MotionLane[]
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
  // TEMPORARY: `motion` stays alongside `motionLanes` only until App.tsx
  // migrates its call sites in Task 5; it is folded into a single position
  // lane when `motionLanes` is not supplied.
  options?: { motionLanes?: MotionLane[]; motion?: MotionData; sourceLabel?: string },
): Preset {
  const preset: Preset = {
    name: coerceName(name),
    schemaVersion: PRESET_SCHEMA_VERSION,
    // Own a sanitized copy so the stored patch never aliases a frozen default
    // and is always within safe ranges.
    patch: sanitizePatch(patch),
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
  }

  // Only attach motionLanes/sourceLabel when given, and clone/validate
  // defensively so the stored preset never aliases caller-owned data or
  // carries garbage.
  const motionLanes = parseMotionLanes(options?.motionLanes)
  if (motionLanes !== undefined) preset.motionLanes = motionLanes

  if (preset.motionLanes === undefined) {
    const legacy = orUndefined(motionToLanes(parseMotion(options?.motion)))
    if (legacy !== undefined) preset.motionLanes = legacy
  }

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

  // v1 presets simply lack these; v2 presets carry a single `motion`
  // recording (migrated below to a position lane); v3 presets carry
  // `motionLanes` directly. Bad values (and v1 absence) leave the field
  // undefined rather than throwing.
  const motionLanes = parseMotionLanes(record.motionLanes)
    ?? orUndefined(motionToLanes(parseMotion(record.motion)))
  if (motionLanes !== undefined) preset.motionLanes = motionLanes

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

const MOTION_TARGETS: ReadonlySet<string> = new Set([
  ...MOTION_PARAM_TARGETS,
  ...MACROS.map((macro) => `macro:${macro.id}`),
])

// Accept only well-formed lanes with known targets; clone defensively (via
// parseMotion) and cap at MAX_MOTION_LANES. Any malformed lane invalidates
// the whole array — same "all or nothing" contract as parseMotion — so a
// partially-corrupt preset doesn't silently load with missing automation.
// Returns undefined (not []) when nothing valid survives, so absent and
// invalid inputs read the same way v2 `motion` absence did.
export function parseMotionLanes(value: unknown): MotionLane[] | undefined {
  if (!Array.isArray(value)) return undefined
  const lanes: MotionLane[] = []
  for (const item of value) {
    if (lanes.length >= MAX_MOTION_LANES) break
    if (!isRecord(item)) return undefined
    if (typeof item.target !== 'string' || !MOTION_TARGETS.has(item.target)) return undefined
    const data = parseMotion(item.data)
    if (data === undefined) return undefined
    lanes.push({ target: item.target as MotionLane['target'], data })
  }
  return lanes.length > 0 ? lanes : undefined
}

function orUndefined(lanes: MotionLane[]): MotionLane[] | undefined {
  return lanes.length > 0 ? lanes : undefined
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
