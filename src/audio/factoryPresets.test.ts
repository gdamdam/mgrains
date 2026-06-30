import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PATCH,
  PATCH_RANGES,
  sanitizePatch,
  type GrainPatch,
} from './contracts'
import { FACTORY_PRESETS, type FactoryPreset } from './factoryPresets'

// Numeric fields that have an authoritative [min, max] tuple in PATCH_RANGES.
const RANGED_KEYS = Object.keys(PATCH_RANGES) as ReadonlyArray<
  keyof typeof PATCH_RANGES
>

function applyPreset(preset: FactoryPreset): GrainPatch {
  return sanitizePatch({ ...DEFAULT_PATCH, ...preset.patch })
}

describe('FACTORY_PRESETS', () => {
  it('ships between 8 and 12 presets', () => {
    expect(FACTORY_PRESETS.length).toBeGreaterThanOrEqual(8)
    expect(FACTORY_PRESETS.length).toBeLessThanOrEqual(12)
  })

  it('gives every preset a unique, non-empty name', () => {
    const names = FACTORY_PRESETS.map((preset) => preset.name)
    for (const name of names) {
      expect(name.trim().length).toBeGreaterThan(0)
    }
    expect(new Set(names).size).toBe(names.length)
  })

  it('includes at least 3 bloom and at least 3 shatter presets', () => {
    const blooms = FACTORY_PRESETS.filter((preset) => preset.mode === 'bloom')
    const shatters = FACTORY_PRESETS.filter((preset) => preset.mode === 'shatter')
    expect(blooms.length).toBeGreaterThanOrEqual(3)
    expect(shatters.length).toBeGreaterThanOrEqual(3)
  })

  it('keeps a non-empty sourceHint on every preset', () => {
    for (const preset of FACTORY_PRESETS) {
      expect(preset.sourceHint.trim().length).toBeGreaterThan(0)
    }
  })

  it('declares preset.mode consistently with the patch override', () => {
    for (const preset of FACTORY_PRESETS) {
      if (preset.patch.mode !== undefined) {
        expect(preset.patch.mode).toBe(preset.mode)
      }
    }
  })

  it('only references keys that exist on GrainPatch', () => {
    const validKeys = new Set(Object.keys(DEFAULT_PATCH))
    for (const preset of FACTORY_PRESETS) {
      for (const key of Object.keys(preset.patch)) {
        expect(validKeys.has(key)).toBe(true)
      }
    }
  })

  it('produces a valid, fully-ranged patch when applied over DEFAULT_PATCH', () => {
    for (const preset of FACTORY_PRESETS) {
      const patch = applyPreset(preset)

      expect(patch.shatterSteps).toHaveLength(16)

      for (const key of RANGED_KEYS) {
        const value = patch[key]
        const [min, max] = PATCH_RANGES[key]
        expect(Number.isFinite(value)).toBe(true)
        expect(value).toBeGreaterThanOrEqual(min)
        expect(value).toBeLessThanOrEqual(max)
      }
    }
  })

  it('round-trips its declared overrides through sanitize unchanged', () => {
    // A preset author should already be inside the valid envelope: sanitizing
    // must not silently rewrite any field they explicitly set.
    for (const preset of FACTORY_PRESETS) {
      const patch = applyPreset(preset)
      for (const key of Object.keys(preset.patch) as Array<keyof GrainPatch>) {
        expect(patch[key]).toEqual(preset.patch[key])
      }
    }
  })

  it('freezes the registry and every entry', () => {
    expect(Object.isFrozen(FACTORY_PRESETS)).toBe(true)
    for (const preset of FACTORY_PRESETS) {
      expect(Object.isFrozen(preset)).toBe(true)
    }
  })
})
