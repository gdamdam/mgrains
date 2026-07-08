import { describe, expect, it } from 'vitest'
import { DEFAULT_PATCH, PATCH_RANGES, sanitizePatch } from '../audio/contracts'
import type { MotionData } from '../performance/motion'
import {
  PRESET_SCHEMA_VERSION,
  deserializePreset,
  parseMotionLanes,
  serializePreset,
} from './presets'

describe('serializePreset / deserializePreset', () => {
  it('round-trips a serialized preset to an equal preset', () => {
    const preset = serializePreset('My Patch', DEFAULT_PATCH, 1_700_000_000_000)
    const roundTripped = deserializePreset(JSON.parse(JSON.stringify(preset)))

    expect(roundTripped).toEqual(preset)
  })

  it('stamps the schema version and the caller-supplied createdAt', () => {
    const preset = serializePreset('Stamped', DEFAULT_PATCH, 42)

    expect(preset.schemaVersion).toBe(PRESET_SCHEMA_VERSION)
    expect(preset.createdAt).toBe(42)
    // patch is sanitized into a safe, owned value rather than a frozen default
    expect(preset.patch).toEqual(sanitizePatch(DEFAULT_PATCH))
  })

  it('returns a default-patch preset for an empty object without throwing', () => {
    const preset = deserializePreset({})

    expect(preset.patch).toEqual(sanitizePatch(DEFAULT_PATCH))
    expect(preset.schemaVersion).toBe(PRESET_SCHEMA_VERSION)
    expect(typeof preset.name).toBe('string')
    expect(typeof preset.createdAt).toBe('number')
  })

  it('returns a default-patch preset for null without throwing', () => {
    const preset = deserializePreset(null)

    expect(preset.patch).toEqual(sanitizePatch(DEFAULT_PATCH))
    expect(preset.schemaVersion).toBe(PRESET_SCHEMA_VERSION)
  })

  it('does not throw on arbitrary garbage input', () => {
    for (const garbage of [undefined, 7, 'nope', [], true, Symbol.iterator]) {
      expect(() => deserializePreset(garbage)).not.toThrow()
      expect(deserializePreset(garbage).patch).toEqual(sanitizePatch(DEFAULT_PATCH))
    }
  })

  it('migrates a partial/old patch by sanitizing missing and invalid fields', () => {
    const preset = deserializePreset({
      name: 'Legacy',
      patch: {
        // only a few fields present, several out of range; rest missing
        grainSizeMs: 999_999,
        densityHz: -5,
        position: 2,
        outputGain: -1,
        bpm: 9_999,
      },
    })

    const patch = preset.patch
    expect(patch.grainSizeMs).toBe(PATCH_RANGES.grainSizeMs[1])
    expect(patch.densityHz).toBe(PATCH_RANGES.densityHz[0])
    expect(patch.position).toBe(PATCH_RANGES.position[1])
    expect(patch.outputGain).toBe(PATCH_RANGES.outputGain[0])
    expect(patch.bpm).toBe(PATCH_RANGES.bpm[1])

    // every clamped range field lands inside its declared bounds
    for (const [key, [min, max]] of Object.entries(PATCH_RANGES)) {
      const value = patch[key as keyof typeof PATCH_RANGES]
      expect(value).toBeGreaterThanOrEqual(min)
      expect(value).toBeLessThanOrEqual(max)
    }
    // shatter lane is always normalized to a full 16-step lane
    expect(patch.shatterSteps).toHaveLength(16)
  })

  it('preserves a valid name and valid patch values', () => {
    const preset = deserializePreset({
      name: 'Keeper',
      schemaVersion: 1,
      createdAt: 123,
      patch: {
        ...DEFAULT_PATCH,
        grainSizeMs: 200,
        densityHz: 20,
        position: 0.5,
        bpm: 128,
        mode: 'shatter',
      },
    })

    expect(preset.name).toBe('Keeper')
    expect(preset.createdAt).toBe(123)
    expect(preset.schemaVersion).toBe(1)
    expect(preset.patch.grainSizeMs).toBe(200)
    expect(preset.patch.densityHz).toBe(20)
    expect(preset.patch.position).toBe(0.5)
    expect(preset.patch.bpm).toBe(128)
    expect(preset.patch.mode).toBe('shatter')
  })

  it('coerces a missing or non-string name to a safe string', () => {
    expect(typeof deserializePreset({ patch: DEFAULT_PATCH }).name).toBe('string')
    expect(typeof deserializePreset({ name: 99, patch: DEFAULT_PATCH }).name).toBe('string')
    expect(deserializePreset({ name: 99, patch: DEFAULT_PATCH }).name.length).toBeGreaterThan(0)
  })

  it('stamps schema version 3', () => {
    expect(PRESET_SCHEMA_VERSION).toBe(3)
  })

  it('round-trips legacy motion (via options) into a position lane, and sourceLabel', () => {
    const motion: MotionData = {
      samples: [
        { tMs: 0, value: 0.1 },
        { tMs: 250, value: 0.6 },
        { tMs: 500, value: 0.42 },
      ],
      durationMs: 500,
    }
    const preset = serializePreset('Moving', DEFAULT_PATCH, 1_700_000_000_000, {
      motion,
      sourceLabel: 'kick.wav',
    })
    const roundTripped = deserializePreset(JSON.parse(JSON.stringify(preset)))

    expect(preset.schemaVersion).toBe(3)
    expect(roundTripped).toEqual(preset)
    expect(roundTripped.motionLanes).toEqual([{ target: 'position', data: motion }])
    expect(roundTripped.sourceLabel).toBe('kick.wav')
  })

  it('omits motionLanes and sourceLabel when no options are supplied', () => {
    const preset = serializePreset('Plain', DEFAULT_PATCH, 42)

    expect(preset.motionLanes).toBeUndefined()
    expect(preset.sourceLabel).toBeUndefined()

    const roundTripped = deserializePreset(JSON.parse(JSON.stringify(preset)))
    expect(roundTripped.motionLanes).toBeUndefined()
    expect(roundTripped.sourceLabel).toBeUndefined()
  })

  it('migrates a v1-shaped preset (no motion/sourceLabel) with those fields absent', () => {
    const preset = deserializePreset({
      name: 'V1',
      schemaVersion: 1,
      createdAt: 123,
      patch: { ...DEFAULT_PATCH },
    })

    expect(preset.name).toBe('V1')
    expect(preset.schemaVersion).toBe(1)
    expect(preset.motionLanes).toBeUndefined()
    expect(preset.sourceLabel).toBeUndefined()
    expect(preset.patch).toEqual(sanitizePatch(DEFAULT_PATCH))
  })

  it('drops malformed legacy motion to undefined without throwing', () => {
    const cases: unknown[] = [
      { motion: { samples: 'nope', durationMs: 100 } },
      { motion: { samples: [{ tMs: 0, value: 0 }], durationMs: Infinity } },
      { motion: { samples: [{ tMs: 'x', value: 0 }], durationMs: 100 } },
      { motion: { durationMs: 100 } },
      { motion: { samples: [{ tMs: 0, value: 0 }] } },
      { motion: 7 },
      { motion: null },
    ]
    for (const raw of cases) {
      expect(() => deserializePreset(raw)).not.toThrow()
      expect(deserializePreset(raw).motionLanes).toBeUndefined()
    }
  })

  it('drops a non-string sourceLabel to undefined', () => {
    expect(deserializePreset({ sourceLabel: 99 }).sourceLabel).toBeUndefined()
    expect(deserializePreset({ sourceLabel: 'sample.wav' }).sourceLabel).toBe('sample.wav')
  })
})

describe('preset motion lanes (schema v3)', () => {
  const lane = { target: 'position', data: { samples: [{ tMs: 0, value: 0.5 }], durationMs: 100 } }
  const macroLane = { target: 'macro:cloud', data: { samples: [{ tMs: 5, value: 1 }], durationMs: 100 } }

  it('serializes motionLanes and stamps schema v3', () => {
    const preset = serializePreset('take', DEFAULT_PATCH, 0, { motionLanes: [lane, macroLane] as never })
    expect(preset.schemaVersion).toBe(3)
    expect(preset.motionLanes).toHaveLength(2)
    expect(preset.motionLanes?.[0]).not.toBe(lane) // defensive clone
  })

  it('deserializes v3 motionLanes', () => {
    const raw = JSON.parse(JSON.stringify(serializePreset('take', DEFAULT_PATCH, 0, { motionLanes: [lane] as never })))
    expect(deserializePreset(raw).motionLanes).toEqual([lane])
  })

  it('migrates a legacy v2 preset (single motion) to a position lane', () => {
    const raw = { name: 'old', schemaVersion: 2, patch: DEFAULT_PATCH, createdAt: 0,
      motion: { samples: [{ tMs: 0, value: 0.3 }], durationMs: 80 } }
    expect(deserializePreset(raw).motionLanes).toEqual([
      { target: 'position', data: { samples: [{ tMs: 0, value: 0.3 }], durationMs: 80 } },
    ])
  })

  it('parseMotionLanes drops unknown targets, bad data, and truncates to 4 lanes', () => {
    expect(parseMotionLanes([{ target: 'garbage', data: lane.data }])).toBeUndefined()
    expect(parseMotionLanes([{ target: 'macro:nope', data: lane.data }])).toBeUndefined()
    expect(parseMotionLanes([{ target: 'position', data: { samples: 'x', durationMs: 1 } }])).toBeUndefined()
    const five = ['position', 'spray', 'grainSizeMs', 'densityHz', 'pitchSpreadSemitones']
      .map((target) => ({ target, data: lane.data }))
    expect(parseMotionLanes(five)).toHaveLength(4)
    expect(parseMotionLanes('not an array')).toBeUndefined()
  })
})
