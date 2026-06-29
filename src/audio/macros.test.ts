import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PATCH,
  PATCH_RANGES,
  SHATTER_DIVISIONS,
  type GrainPatch,
} from './contracts'
import { applyMacro, MACRO_PARAMS, MACROS } from './macros'

function inRange(value: number, range: readonly [number, number]): boolean {
  return value >= range[0] && value <= range[1]
}

describe('MACROS registry', () => {
  it('contains exactly cloud, drift (bloom) and chop, scatter (shatter)', () => {
    const ids = MACROS.map((macro) => macro.id).sort()
    expect(ids).toEqual(['chop', 'cloud', 'drift', 'scatter'])
  })

  it('tags each macro with the mode it belongs to', () => {
    const byId = new Map(MACROS.map((macro) => [macro.id, macro.mode]))
    expect(byId.get('cloud')).toBe('bloom')
    expect(byId.get('drift')).toBe('bloom')
    expect(byId.get('chop')).toBe('shatter')
    expect(byId.get('scatter')).toBe('shatter')
  })

  it('keeps MACRO_PARAMS keys aligned with the registry', () => {
    const registryIds = MACROS.map((macro) => macro.id).sort()
    const paramKeys = Object.keys(MACRO_PARAMS).sort()
    expect(paramKeys).toEqual(registryIds)
  })

  it('mirrors each macro params array in MACRO_PARAMS', () => {
    for (const macro of MACROS) {
      expect(MACRO_PARAMS[macro.id]).toEqual(macro.params)
    }
  })
})

describe('applyMacro: cloud', () => {
  it('produces in-range grainSizeMs and densityHz at both endpoints', () => {
    const low = applyMacro(DEFAULT_PATCH, 'cloud', 0)
    const high = applyMacro(DEFAULT_PATCH, 'cloud', 1)
    for (const result of [low, high]) {
      expect(inRange(result.grainSizeMs as number, PATCH_RANGES.grainSizeMs)).toBe(true)
      expect(inRange(result.densityHz as number, PATCH_RANGES.densityHz)).toBe(true)
    }
  })

  it('grows grainSizeMs and densityHz monotonically with value', () => {
    const low = applyMacro(DEFAULT_PATCH, 'cloud', 0)
    const mid = applyMacro(DEFAULT_PATCH, 'cloud', 0.5)
    const high = applyMacro(DEFAULT_PATCH, 'cloud', 1)
    expect((high.grainSizeMs as number)).toBeGreaterThan(low.grainSizeMs as number)
    expect((mid.grainSizeMs as number)).toBeGreaterThan(low.grainSizeMs as number)
    expect((high.grainSizeMs as number)).toBeGreaterThan(mid.grainSizeMs as number)
    expect((high.densityHz as number)).toBeGreaterThan(low.densityHz as number)
  })

  it('returns only the params it controls', () => {
    const result = applyMacro(DEFAULT_PATCH, 'cloud', 0.5)
    expect(Object.keys(result).sort()).toEqual(['densityHz', 'grainSizeMs'])
  })
})

describe('applyMacro: drift', () => {
  it('grows scanSpeed, spray, timingJitter and pitchSpreadSemitones with value', () => {
    const low = applyMacro(DEFAULT_PATCH, 'drift', 0)
    const high = applyMacro(DEFAULT_PATCH, 'drift', 1)
    expect((high.scanSpeed as number)).toBeGreaterThan(low.scanSpeed as number)
    expect((high.spray as number)).toBeGreaterThan(low.spray as number)
    expect((high.timingJitter as number)).toBeGreaterThan(low.timingJitter as number)
    expect((high.pitchSpreadSemitones as number)).toBeGreaterThan(
      low.pitchSpreadSemitones as number,
    )
  })

  it('keeps every controlled param in range at the endpoints', () => {
    const low = applyMacro(DEFAULT_PATCH, 'drift', 0)
    const high = applyMacro(DEFAULT_PATCH, 'drift', 1)
    for (const result of [low, high]) {
      expect(inRange(result.scanSpeed as number, PATCH_RANGES.scanSpeed)).toBe(true)
      expect(inRange(result.spray as number, PATCH_RANGES.spray)).toBe(true)
      expect(inRange(result.timingJitter as number, PATCH_RANGES.timingJitter)).toBe(true)
      expect(
        inRange(result.pitchSpreadSemitones as number, PATCH_RANGES.pitchSpreadSemitones),
      ).toBe(true)
    }
  })
})

describe('applyMacro: chop', () => {
  it('selects a finer division as value rises, always a SHATTER_DIVISIONS member', () => {
    const low = applyMacro(DEFAULT_PATCH, 'chop', 0)
    const high = applyMacro(DEFAULT_PATCH, 'chop', 1)
    const lowDivision = low.shatterDivision as GrainPatch['shatterDivision']
    const highDivision = high.shatterDivision as GrainPatch['shatterDivision']
    expect(SHATTER_DIVISIONS).toContain(lowDivision)
    expect(SHATTER_DIVISIONS).toContain(highDivision)
    // higher value => later (finer) index in the ordered SHATTER_DIVISIONS array
    expect(SHATTER_DIVISIONS.indexOf(highDivision)).toBeGreaterThan(
      SHATTER_DIVISIONS.indexOf(lowDivision),
    )
  })

  it('shrinks grainSizeMs as value rises, staying in range', () => {
    const low = applyMacro(DEFAULT_PATCH, 'chop', 0)
    const high = applyMacro(DEFAULT_PATCH, 'chop', 1)
    expect((high.grainSizeMs as number)).toBeLessThan(low.grainSizeMs as number)
    expect(inRange(low.grainSizeMs as number, PATCH_RANGES.grainSizeMs)).toBe(true)
    expect(inRange(high.grainSizeMs as number, PATCH_RANGES.grainSizeMs)).toBe(true)
  })
})

describe('applyMacro: scatter', () => {
  it('maps spray, timingJitter and reverseProbability within [0, 1]', () => {
    for (const value of [0, 0.5, 1]) {
      const result = applyMacro(DEFAULT_PATCH, 'scatter', value)
      expect(inRange(result.spray as number, PATCH_RANGES.spray)).toBe(true)
      expect(inRange(result.timingJitter as number, PATCH_RANGES.timingJitter)).toBe(true)
      expect(
        inRange(result.reverseProbability as number, PATCH_RANGES.reverseProbability),
      ).toBe(true)
    }
  })

  it('grows all three params with value', () => {
    const low = applyMacro(DEFAULT_PATCH, 'scatter', 0)
    const high = applyMacro(DEFAULT_PATCH, 'scatter', 1)
    expect((high.spray as number)).toBeGreaterThan(low.spray as number)
    expect((high.timingJitter as number)).toBeGreaterThan(low.timingJitter as number)
    expect((high.reverseProbability as number)).toBeGreaterThan(
      low.reverseProbability as number,
    )
  })
})

describe('applyMacro: value handling', () => {
  it('clamps value above 1 to the value-1 result', () => {
    expect(applyMacro(DEFAULT_PATCH, 'cloud', 5)).toEqual(
      applyMacro(DEFAULT_PATCH, 'cloud', 1),
    )
  })

  it('clamps value below 0 to the value-0 result', () => {
    expect(applyMacro(DEFAULT_PATCH, 'cloud', -3)).toEqual(
      applyMacro(DEFAULT_PATCH, 'cloud', 0),
    )
  })

  it('returns an empty patch for an unknown macro id', () => {
    expect(applyMacro(DEFAULT_PATCH, 'nope', 0.5)).toEqual({})
  })
})
