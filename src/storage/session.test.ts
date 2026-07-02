import { describe, expect, it } from 'vitest'
import { DEFAULT_PATCH } from '../audio/contracts'
import { deserializeSession, serializeSession, SESSION_SCHEMA_VERSION } from './session'

describe('serializeSession / deserializeSession', () => {
  it('round-trips a full session through JSON', () => {
    const motion = { samples: [{ tMs: 0, value: 0.2 }, { tMs: 100, value: 0.8 }], durationMs: 100 }
    const session = serializeSession(
      { ...DEFAULT_PATCH, position: 0.7 },
      'studio',
      1234,
      { motion, sourceLabel: 'My sample' },
    )
    const restored = deserializeSession(JSON.parse(JSON.stringify(session)))

    expect(restored.schemaVersion).toBe(SESSION_SCHEMA_VERSION)
    expect(restored.viewMode).toBe('studio')
    expect(restored.savedAt).toBe(1234)
    expect(restored.patch.position).toBeCloseTo(0.7)
    expect(restored.motion).toEqual(motion)
    expect(restored.sourceLabel).toBe('My sample')
  })

  it('defaults missing/invalid fields and sanitizes the patch', () => {
    const session = deserializeSession({ patch: { position: 5, densityHz: 1e6 }, viewMode: 'bogus' })

    expect(session.viewMode).toBe('live')
    expect(session.savedAt).toBe(0)
    // sanitizePatch clamps out-of-range values and fills the rest from defaults.
    expect(session.patch.position).toBe(1)
    expect(session.patch.densityHz).toBe(80)
    expect(session.patch.pitchQuantize).toBe(DEFAULT_PATCH.pitchQuantize)
    expect(session.motion).toBeUndefined()
    expect(session.sourceLabel).toBeUndefined()
  })

  it('never throws on garbage input', () => {
    for (const bad of [null, undefined, 42, 'nope', [], { patch: 'x', motion: { samples: 'no' } }]) {
      const session = deserializeSession(bad)
      expect(session.viewMode).toBe('live')
      expect(session.patch).toEqual(DEFAULT_PATCH)
    }
  })

  it('drops a malformed motion recording', () => {
    const session = deserializeSession({
      patch: DEFAULT_PATCH,
      motion: { samples: [{ tMs: 0 }], durationMs: 10 },
    })
    expect(session.motion).toBeUndefined()
  })
})
