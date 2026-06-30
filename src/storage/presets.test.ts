import { describe, expect, it } from 'vitest'
import { DEFAULT_PATCH, PATCH_RANGES, sanitizePatch } from '../audio/contracts'
import {
  PRESET_SCHEMA_VERSION,
  deserializePreset,
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
})
