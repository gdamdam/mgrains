import { describe, expect, it } from 'vitest'
import { DEFAULT_PATCH } from '../audio/contracts'
import { deserializeSession, serializeSession, SESSION_SCHEMA_VERSION } from './session'

describe('serializeSession / deserializeSession', () => {
  it('defaults missing/invalid fields and sanitizes the patch', () => {
    const session = deserializeSession({ patch: { position: 5, densityHz: 1e6 }, viewMode: 'bogus' })

    expect(session.viewMode).toBe('live')
    expect(session.savedAt).toBe(0)
    // sanitizePatch clamps out-of-range values and fills the rest from defaults.
    expect(session.patch.position).toBe(1)
    expect(session.patch.densityHz).toBe(80)
    expect(session.patch.pitchQuantize).toBe(DEFAULT_PATCH.pitchQuantize)
    expect(session.motionLanes).toBeUndefined()
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
    expect(session.motionLanes).toBeUndefined()
  })
})

describe('session motion lanes (schema v2)', () => {
  const lane = { target: 'position', data: { samples: [{ tMs: 0, value: 0.5 }], durationMs: 100 } }

  it('serializes motionLanes and stamps the current schema version', () => {
    const session = serializeSession(DEFAULT_PATCH, 'studio', 0, { motionLanes: [lane] as never })
    expect(session.schemaVersion).toBe(SESSION_SCHEMA_VERSION)
    expect(session.motionLanes).toEqual([lane])
  })

  it('round-trips motionLanes and sourceLabel supplied via options', () => {
    const session = serializeSession(
      { ...DEFAULT_PATCH, position: 0.7 },
      'studio',
      1234,
      { motionLanes: [lane] as never, sourceLabel: 'My sample' },
    )
    const restored = deserializeSession(JSON.parse(JSON.stringify(session)))

    expect(restored.schemaVersion).toBe(SESSION_SCHEMA_VERSION)
    expect(restored.viewMode).toBe('studio')
    expect(restored.savedAt).toBe(1234)
    expect(restored.patch.position).toBeCloseTo(0.7)
    expect(restored.motionLanes).toEqual([lane])
    expect(restored.sourceLabel).toBe('My sample')
  })

  it('migrates a legacy v1 session (single motion) to a position lane', () => {
    const raw = { schemaVersion: 1, patch: DEFAULT_PATCH, viewMode: 'studio', savedAt: 0,
      motion: { samples: [{ tMs: 0, value: 0.3 }], durationMs: 80 } }
    expect(deserializeSession(raw).motionLanes).toEqual([
      { target: 'position', data: { samples: [{ tMs: 0, value: 0.3 }], durationMs: 80 } },
    ])
  })
})

describe('session factory identity (schema v3)', () => {
  it('round-trips sourceId and sceneId supplied via options', () => {
    const session = serializeSession(DEFAULT_PATCH, 'live', 7, {
      sourceId: 'glass-bells',
      sceneId: 'bell-spectral-rain',
    })
    const restored = deserializeSession(JSON.parse(JSON.stringify(session)))

    expect(session.schemaVersion).toBe(3)
    expect(restored.sourceId).toBe('glass-bells')
    expect(restored.sceneId).toBe('bell-spectral-rain')
  })

  it('omits sourceId/sceneId when not supplied and drops non-string values', () => {
    const session = serializeSession(DEFAULT_PATCH, 'live', 0)
    expect(session.sourceId).toBeUndefined()
    expect(session.sceneId).toBeUndefined()

    const restored = deserializeSession({ patch: DEFAULT_PATCH, sourceId: 99, sceneId: {} })
    expect(restored.sourceId).toBeUndefined()
    expect(restored.sceneId).toBeUndefined()
  })

  it('deserializes an old v2 session without the new fields', () => {
    const raw = { schemaVersion: 2, patch: DEFAULT_PATCH, viewMode: 'studio', savedAt: 5 }
    const restored = deserializeSession(raw)
    // Older payload still loads; new fields are simply absent.
    expect(restored.schemaVersion).toBe(2)
    expect(restored.sourceId).toBeUndefined()
    expect(restored.sceneId).toBeUndefined()
    expect(restored.viewMode).toBe('studio')
  })
})
