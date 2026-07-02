import { DEFAULT_PATCH, sanitizePatch, type GrainPatch } from '../audio/contracts'
import type { MotionData } from '../performance/motion'
import { isRecord, parseMotion, parseSourceLabel } from './presets'

// The working session: the full editable state minus audio. Audio is never
// stored (see presets.ts) — sourceLabel only prompts a relink. Bump when the
// envelope changes shape; patch-level migration is delegated to sanitizePatch.
export const SESSION_SCHEMA_VERSION = 1

export type SessionViewMode = 'live' | 'studio'

export interface Session {
  schemaVersion: number
  patch: GrainPatch
  viewMode: SessionViewMode
  savedAt: number
  motion?: MotionData
  sourceLabel?: string
}

// localStorage key for the auto-persisted "last session" restored on startup.
const LAST_SESSION_KEY = 'mgrains.lastSession'

// savedAt is caller-supplied (not Date.now here) so serialization stays
// deterministic and testable, matching serializePreset.
export function serializeSession(
  patch: GrainPatch,
  viewMode: SessionViewMode,
  savedAt: number,
  options?: { motion?: MotionData; sourceLabel?: string },
): Session {
  const session: Session = {
    schemaVersion: SESSION_SCHEMA_VERSION,
    patch: sanitizePatch(patch),
    viewMode: viewMode === 'studio' ? 'studio' : 'live',
    savedAt: Number.isFinite(savedAt) ? savedAt : 0,
  }

  const motion = parseMotion(options?.motion)
  if (motion !== undefined) session.motion = motion

  const sourceLabel = parseSourceLabel(options?.sourceLabel)
  if (sourceLabel !== undefined) session.sourceLabel = sourceLabel

  return session
}

// Defensively rebuild a Session from an unknown value (parsed from storage or an
// imported file). Never throws: bad/missing fields fall back to safe defaults and
// the patch is migrated through sanitizePatch.
export function deserializeSession(raw: unknown): Session {
  const record = isRecord(raw) ? raw : {}

  const schemaVersion = Number.isFinite(record.schemaVersion)
    ? (record.schemaVersion as number)
    : SESSION_SCHEMA_VERSION

  const patchCandidate = isRecord(record.patch)
    ? { ...DEFAULT_PATCH, ...record.patch }
    : DEFAULT_PATCH

  const session: Session = {
    schemaVersion,
    patch: sanitizePatch(patchCandidate as GrainPatch),
    viewMode: record.viewMode === 'studio' ? 'studio' : 'live',
    savedAt: Number.isFinite(record.savedAt) ? (record.savedAt as number) : 0,
  }

  const motion = parseMotion(record.motion)
  if (motion !== undefined) session.motion = motion

  const sourceLabel = parseSourceLabel(record.sourceLabel)
  if (sourceLabel !== undefined) session.sourceLabel = sourceLabel

  return session
}

// Read the auto-saved last session, or null if none/unavailable. Guards against a
// missing or throwing localStorage (private mode) so the app degrades silently.
export function readLastSession(): Session | null {
  try {
    const raw = localStorage.getItem(LAST_SESSION_KEY)
    if (!raw) return null
    return deserializeSession(JSON.parse(raw))
  } catch {
    return null
  }
}

export function writeLastSession(session: Session): void {
  try {
    localStorage.setItem(LAST_SESSION_KEY, JSON.stringify(session))
  } catch {
    /* storage unavailable/full — autosave silently disabled */
  }
}

export function clearLastSession(): void {
  try {
    localStorage.removeItem(LAST_SESSION_KEY)
  } catch {
    /* ignore */
  }
}
