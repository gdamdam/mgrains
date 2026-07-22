import type { AudioSourceMode, GrainPatch } from '../audio/contracts'
import { DEMO_SOURCES } from '../audio/demoSource'
import { FACTORY_SCENES } from '../audio/factoryScenes'

// Pure identity/relink logic for persisting and restoring factory sources and
// scenes. Intentionally free of any App/DOM/WebAudio dependency: it imports only
// the id catalogues (no synthesis runs at import time) so it stays trivially
// testable and reusable from serialization, restore, and UI code alike.

// Set builders derived from the catalogues, so callers pass a `known` set into
// planSourceRestore rather than this module reaching for globals. These are the
// single source of truth for "is this a real factory id".
export const KNOWN_SOURCE_IDS: ReadonlySet<string> = new Set(
  DEMO_SOURCES.map((source) => source.id),
)
export const KNOWN_SCENE_IDS: ReadonlySet<string> = new Set(
  FACTORY_SCENES.map((scene) => scene.id),
)

// A stored, opaque string or undefined — mirrors parseSourceLabel's coercion so
// non-strings never leak through as ids.
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

// Decide what factory identity (if any) a save should persist. Only a REAL
// factory source persists a `sourceId`: imported files and live capture never
// do — they persist only their `sourceLabel` and must not masquerade as factory
// material. `sceneId` persists only when it names a known FACTORY_SCENES entry.
export function resolveSourceIdentityForSave(input: {
  sourceMode: AudioSourceMode
  sourceId?: string
  activeSceneId?: string
  sourceLabel?: string
}): { sourceId?: string; sceneId?: string; sourceLabel?: string } {
  const result: { sourceId?: string; sceneId?: string; sourceLabel?: string } = {}

  // Factory source only: sample mode AND a recognised DEMO_SOURCES id. Live and
  // imported-file sources fall through and never emit a factory sourceId.
  const sourceId = asString(input.sourceId)
  if (input.sourceMode === 'sample' && sourceId !== undefined && KNOWN_SOURCE_IDS.has(sourceId)) {
    result.sourceId = sourceId
  }

  const sceneId = asString(input.activeSceneId)
  if (sceneId !== undefined && KNOWN_SCENE_IDS.has(sceneId)) {
    result.sceneId = sceneId
  }

  // Keep the human label for imported-file/live relink regardless of the above.
  const sourceLabel = asString(input.sourceLabel)
  if (sourceLabel !== undefined) result.sourceLabel = sourceLabel

  return result
}

// The concrete action a caller should take to restore a saved source identity.
export type RestorePlan =
  | { kind: 'factory-scene'; sceneId: string; sourceId?: string }
  | { kind: 'factory-source'; sourceId: string }
  | { kind: 'relink'; label?: string }
  | { kind: 'none' }

// Choose how to restore, preferring the most specific identity that is still
// known: scene → factory source → relink-by-label → nothing. An id that is
// present but UNKNOWN (e.g. a source/scene removed in a later build) is ignored
// rather than trusted, so we degrade to relink (with any label) or none — never
// throw and never load a phantom id.
export function planSourceRestore(
  stored: { sourceId?: string; sceneId?: string; sourceLabel?: string },
  known: { sourceIds: ReadonlySet<string>; sceneIds: ReadonlySet<string> },
): RestorePlan {
  const sourceId = asString(stored.sourceId)
  const sceneId = asString(stored.sceneId)

  if (sceneId !== undefined && known.sceneIds.has(sceneId)) {
    const plan: RestorePlan = { kind: 'factory-scene', sceneId }
    // Pass the source id through only when it too is known, as a hint; the scene
    // itself already binds its source, so an unknown/absent one is harmless.
    if (sourceId !== undefined && known.sourceIds.has(sourceId)) plan.sourceId = sourceId
    return plan
  }

  if (sourceId !== undefined && known.sourceIds.has(sourceId)) {
    return { kind: 'factory-source', sourceId }
  }

  const label = asString(stored.sourceLabel)
  if (label !== undefined) return { kind: 'relink', label }
  return { kind: 'none' }
}

// An actionable message for the relink case, naming the original source so the
// user knows what to reload.
export function relinkMessage(label?: string): string {
  const name = label !== undefined && label.trim().length > 0 ? label : 'the previous audio'
  return `Couldn't find the original source “${name}”. Load a file or pick a source to relink.`
}

// Structural equality for scene-pinned patch values. Scene patches hold only
// plain JSON (numbers, strings, and arrays of plain step/lfo objects with a
// fixed key order), so a JSON comparison is deterministic and sufficient here —
// no NaN, function, or Date values ever occur in patch data.
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  return JSON.stringify(a) === JSON.stringify(b)
}

// Decide whether a live sceneId is still truthful after a patch change.
//
// A scene is defined ENTIRELY by the fields it pins (its Partial<GrainPatch>);
// the patch is still "the scene" for as long as every pinned field matches the
// scene's value. The rule:
//   - `sceneBasePatch === null` is the caller's signal that there is no scene to
//     honor (e.g. the source changed out from under the scene) → clear.
//   - otherwise clear when this edit MOVED a pinned field off the scene's value
//     (the field differs between prev and next, and next no longer matches the
//     scene). Editing a non-pinned field, or restoring a pinned field back to
//     the scene value, does not clear.
export function shouldClearSceneId(
  sceneBasePatch: Partial<GrainPatch> | null,
  prevPatch: GrainPatch,
  nextPatch: GrainPatch,
): boolean {
  if (sceneBasePatch === null) return true

  for (const key of Object.keys(sceneBasePatch) as (keyof GrainPatch)[]) {
    // Only fields this edit actually changed can newly break truthfulness.
    if (valuesEqual(prevPatch[key], nextPatch[key])) continue
    if (!valuesEqual(sceneBasePatch[key], nextPatch[key])) return true
  }
  return false
}
