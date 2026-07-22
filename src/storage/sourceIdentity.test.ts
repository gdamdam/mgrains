import { describe, expect, it } from 'vitest'
import { DEFAULT_PATCH, type GrainPatch } from '../audio/contracts'
import {
  KNOWN_SCENE_IDS,
  KNOWN_SOURCE_IDS,
  planSourceRestore,
  relinkMessage,
  resolveSourceIdentityForSave,
  shouldClearSceneId,
} from './sourceIdentity'

// Real ids from the catalogues so the "known" checks exercise actual data.
const REAL_SOURCE = 'glass-bells'
const REAL_SCENE = 'bell-spectral-rain'

// planSourceRestore takes mutable Sets; derive fresh ones from the exports.
const known = {
  sourceIds: new Set(KNOWN_SOURCE_IDS),
  sceneIds: new Set(KNOWN_SCENE_IDS),
}

describe('resolveSourceIdentityForSave', () => {
  it('persists a real factory sourceId only in sample mode', () => {
    const out = resolveSourceIdentityForSave({ sourceMode: 'sample', sourceId: REAL_SOURCE })
    expect(out.sourceId).toBe(REAL_SOURCE)
  })

  it('never persists a factory sourceId for live capture', () => {
    const out = resolveSourceIdentityForSave({
      sourceMode: 'live',
      sourceId: REAL_SOURCE,
      sourceLabel: 'Line in',
    })
    expect(out.sourceId).toBeUndefined()
    expect(out.sourceLabel).toBe('Line in')
  })

  it('never persists a factory sourceId for an imported file (label only)', () => {
    // An imported file may carry an unknown id; it must not masquerade as factory.
    const out = resolveSourceIdentityForSave({
      sourceMode: 'sample',
      sourceId: 'user-import-123',
      sourceLabel: 'my-loop.wav',
    })
    expect(out.sourceId).toBeUndefined()
    expect(out.sourceLabel).toBe('my-loop.wav')
  })

  it('persists sceneId only when it names a known scene', () => {
    expect(resolveSourceIdentityForSave({ sourceMode: 'sample', activeSceneId: REAL_SCENE }).sceneId)
      .toBe(REAL_SCENE)
    expect(resolveSourceIdentityForSave({ sourceMode: 'sample', activeSceneId: 'nope' }).sceneId)
      .toBeUndefined()
  })
})

describe('planSourceRestore', () => {
  it('prefers a known scene over a known source', () => {
    const plan = planSourceRestore({ sourceId: REAL_SOURCE, sceneId: REAL_SCENE }, known)
    expect(plan).toEqual({ kind: 'factory-scene', sceneId: REAL_SCENE, sourceId: REAL_SOURCE })
  })

  it('falls back to factory-source when only the source is known', () => {
    const plan = planSourceRestore({ sourceId: REAL_SOURCE }, known)
    expect(plan).toEqual({ kind: 'factory-source', sourceId: REAL_SOURCE })
  })

  it('degrades an unknown/removed sceneId+sourceId to relink when a label exists', () => {
    const plan = planSourceRestore(
      { sourceId: 'removed-source', sceneId: 'removed-scene', sourceLabel: 'old.wav' },
      known,
    )
    expect(plan).toEqual({ kind: 'relink', label: 'old.wav' })
  })

  it('degrades to none when nothing is known and no label exists', () => {
    expect(planSourceRestore({ sourceId: 'gone' }, known)).toEqual({ kind: 'none' })
    expect(planSourceRestore({}, known)).toEqual({ kind: 'none' })
  })

  it('drops an unknown source hint on a known-scene plan', () => {
    const plan = planSourceRestore({ sourceId: 'gone', sceneId: REAL_SCENE }, known)
    expect(plan).toEqual({ kind: 'factory-scene', sceneId: REAL_SCENE })
  })
})

describe('relinkMessage', () => {
  it('names the original source and is actionable', () => {
    const msg = relinkMessage('kick.wav')
    expect(msg).toContain('kick.wav')
    expect(msg).toContain('relink')
  })

  it('uses a generic phrase when no label is given', () => {
    expect(relinkMessage()).toContain('the previous audio')
  })
})

describe('shouldClearSceneId', () => {
  const base: Partial<GrainPatch> = { grainSizeMs: 260, densityHz: 8 }

  it('returns true when a manual edit moves a pinned field off the scene', () => {
    const prev: GrainPatch = { ...DEFAULT_PATCH, grainSizeMs: 260, densityHz: 8 }
    const next: GrainPatch = { ...prev, grainSizeMs: 500 }
    expect(shouldClearSceneId(base, prev, next)).toBe(true)
  })

  it('returns false when no pinned field changed', () => {
    const patch: GrainPatch = { ...DEFAULT_PATCH, grainSizeMs: 260, densityHz: 8 }
    // Editing a non-pinned field leaves the scene truthful.
    const next: GrainPatch = { ...patch, outputGain: 0.5 }
    expect(shouldClearSceneId(base, patch, next)).toBe(false)
    // No change at all: also false.
    expect(shouldClearSceneId(base, patch, patch)).toBe(false)
  })

  it('returns true when the caller signals a source change (null base)', () => {
    expect(shouldClearSceneId(null, DEFAULT_PATCH, DEFAULT_PATCH)).toBe(true)
  })
})
