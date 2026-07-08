import { DEFAULT_PATCH, sanitizePatch, type GrainPatch } from '../audio/contracts'
import { motionToLanes, type MotionLane } from '../performance/motionLanes'
import { isRecord, parseMotion, parseMotionLanes, parseSourceLabel } from './presets'

// The working session: the full editable state minus audio. Audio is never
// stored (see presets.ts) — sourceLabel only prompts a relink. Bump when the
// envelope changes shape; patch-level migration is delegated to sanitizePatch.
// v2: single `motion` recording → multi-lane `motionLanes` (gesture takes).
// Legacy v1 `motion` still parses on load and migrates to a single position lane.
export const SESSION_SCHEMA_VERSION = 2

export type SessionViewMode = 'live' | 'studio'

export interface Session {
  schemaVersion: number
  patch: GrainPatch
  viewMode: SessionViewMode
  savedAt: number
  // Optional multi-lane gesture recording captured alongside the patch.
  motionLanes?: MotionLane[]
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
  options?: { motionLanes?: MotionLane[]; sourceLabel?: string },
): Session {
  const session: Session = {
    schemaVersion: SESSION_SCHEMA_VERSION,
    patch: sanitizePatch(patch),
    viewMode: viewMode === 'studio' ? 'studio' : 'live',
    savedAt: Number.isFinite(savedAt) ? savedAt : 0,
  }

  // Only attach motionLanes/sourceLabel when given, and clone/validate
  // defensively so the stored session never aliases caller-owned data or
  // carries garbage.
  const motionLanes = parseMotionLanes(options?.motionLanes)
  if (motionLanes !== undefined) session.motionLanes = motionLanes

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

  // v1 sessions simply lack these; v2 sessions carry a single `motion`
  // recording (migrated below to a position lane); v2 sessions may also carry
  // `motionLanes` directly. Bad values (and v1 absence) leave the field
  // undefined rather than throwing.
  const motionLanes = parseMotionLanes(record.motionLanes)
    ?? orUndefined(motionToLanes(parseMotion(record.motion)))
  if (motionLanes !== undefined) session.motionLanes = motionLanes

  const sourceLabel = parseSourceLabel(record.sourceLabel)
  if (sourceLabel !== undefined) session.sourceLabel = sourceLabel

  return session
}

function orUndefined(lanes: MotionLane[]): MotionLane[] | undefined {
  return lanes.length > 0 ? lanes : undefined
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
