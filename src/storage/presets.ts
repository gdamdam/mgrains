import { DEFAULT_PATCH, sanitizePatch, type GrainPatch } from '../audio/contracts'

// Bump when the Preset envelope (name/schemaVersion/createdAt) changes shape.
// Patch-level migration is delegated to sanitizePatch, which already coerces
// missing/old/invalid GrainPatch fields back into safe ranges.
export const PRESET_SCHEMA_VERSION = 1

export interface Preset {
  name: string
  schemaVersion: number
  patch: GrainPatch
  createdAt: number
}

const DEFAULT_PRESET_NAME = 'Untitled'

// createdAt is supplied by the caller (not Date.now here) so serialization stays
// deterministic and testable.
export function serializePreset(
  name: string,
  patch: GrainPatch,
  createdAt: number,
): Preset {
  return {
    name: coerceName(name),
    schemaVersion: PRESET_SCHEMA_VERSION,
    // Own a sanitized copy so the stored patch never aliases a frozen default
    // and is always within safe ranges.
    patch: sanitizePatch(patch),
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
  }
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

  return {
    name,
    schemaVersion,
    patch: sanitizePatch(patchCandidate as GrainPatch),
    createdAt,
  }
}

function coerceName(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_PRESET_NAME
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : DEFAULT_PRESET_NAME
}

function isRecord(value: unknown): value is Record<string, unknown> {
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
