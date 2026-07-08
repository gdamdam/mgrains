import { describe, expect, it } from 'vitest'
import {
  ADVANCED_PARAM_KEYS,
  DEFAULT_PATCH,
  PATCH_RANGES,
  resetAdvancedToDefault,
  sanitizePatch,
} from './contracts'

describe('sanitizePatch', () => {
  it('clamps unsafe and non-finite values', () => {
    const patch = sanitizePatch({
      ...DEFAULT_PATCH,
      grainSizeMs: Number.POSITIVE_INFINITY,
      densityHz: 1000,
      regionStart: -2,
      regionEnd: 4,
      reverseProbability: -1,
      outputGain: 4,
    })

    expect(patch.grainSizeMs).toBe(5)
    expect(patch.densityHz).toBe(80)
    expect(patch.regionStart).toBe(0)
    expect(patch.regionEnd).toBe(1)
    expect(patch.reverseProbability).toBe(0)
    expect(patch.outputGain).toBe(1)
  })

  it('back-fills repeatFeedback from a legacy patch that only carried repeat', () => {
    // Old presets predate the send/feedback split; reproduce their loop gain.
    const legacy = { ...DEFAULT_PATCH, repeat: 0.65 } as Record<string, unknown>
    delete legacy.repeatFeedback
    const patch = sanitizePatch(legacy as unknown as typeof DEFAULT_PATCH)
    expect(patch.repeatFeedback).toBeCloseTo(0.65 * 0.85)
    expect(patch.repeatDivision).toBe(DEFAULT_PATCH.repeatDivision)
  })

  it('always yields exactly two sanitized LFOs and defaults invalid musical fields', () => {
    const partial = { ...DEFAULT_PATCH } as Record<string, unknown>
    delete partial.lfos
    delete partial.inputGain
    partial.pitchQuantize = 'bogus'
    partial.window = 'nonsense'
    partial.windowSkew = 5
    const patch = sanitizePatch(partial as unknown as typeof DEFAULT_PATCH)
    expect(patch.lfos).toHaveLength(2)
    expect(patch.lfos[0].target).toBe('none')
    expect(patch.pitchQuantize).toBe('off')
    expect(patch.window).toBe('hann')
    expect(patch.windowSkew).toBe(1) // clamped to range max
    expect(patch.inputGain).toBe(1) // missing → unity
  })

  it('accepts the morph window and a valid scatter scale', () => {
    const patch = sanitizePatch({ ...DEFAULT_PATCH, window: 'morph', pitchQuantize: 'minorPent' })
    expect(patch.window).toBe('morph')
    expect(patch.pitchQuantize).toBe('minorPent')
  })

  it('normalizes Shatter steps to a safe deterministic lane', () => {
    const patch = sanitizePatch({
      ...DEFAULT_PATCH,
      bpm: 999,
      shatterSteps: [{
        enabled: true,
        probability: 4,
        pitchOffsetSemitones: -99,
        reverse: true,
        ratchet: 9 as 1,
        positionOffset: 0,
        sizeScale: 1,
      }],
    })

    expect(patch.bpm).toBe(300)
    expect(patch.shatterSteps).toHaveLength(16)
    expect(patch.shatterSteps[0]).toEqual({
      enabled: true,
      probability: 1,
      pitchOffsetSemitones: -24,
      reverse: true,
      ratchet: 4,
      positionOffset: 0,
      sizeScale: 1,
    })
  })
})

describe('shatter lanes + swing schema (v1.7.0)', () => {
  it('fills missing per-step positionOffset/sizeScale with neutral defaults', () => {
    // A pre-1.7 step object has neither new field.
    const patch = sanitizePatch({
      ...DEFAULT_PATCH,
      shatterSteps: [{ enabled: true, probability: 1, pitchOffsetSemitones: 0, reverse: false, ratchet: 1 } as never],
    })
    expect(patch.shatterSteps[0].positionOffset).toBe(0)
    expect(patch.shatterSteps[0].sizeScale).toBe(1)
  })

  it('clamps per-step positionOffset to [-0.5, 0.5] and sizeScale to [0.25, 4]', () => {
    const patch = sanitizePatch({
      ...DEFAULT_PATCH,
      shatterSteps: [{
        enabled: true, probability: 1, pitchOffsetSemitones: 0, reverse: false, ratchet: 1,
        positionOffset: 9, sizeScale: 99,
      } as never, {
        enabled: true, probability: 1, pitchOffsetSemitones: 0, reverse: false, ratchet: 1,
        positionOffset: -9, sizeScale: 0.001,
      } as never],
    })
    expect(patch.shatterSteps[0].positionOffset).toBe(0.5)
    expect(patch.shatterSteps[0].sizeScale).toBe(4)
    expect(patch.shatterSteps[1].positionOffset).toBe(-0.5)
    expect(patch.shatterSteps[1].sizeScale).toBe(0.25)
  })

  it('defaults shatterSwing to 0 and clamps it to [0, 0.6]', () => {
    expect(DEFAULT_PATCH.shatterSwing).toBe(0)
    expect(sanitizePatch({ ...DEFAULT_PATCH, shatterSwing: 5 }).shatterSwing).toBe(0.6)
    expect(sanitizePatch({ ...DEFAULT_PATCH, shatterSwing: -1 }).shatterSwing).toBe(0)
    // Missing (old preset) → neutral 0.
    expect(sanitizePatch({ ...DEFAULT_PATCH, shatterSwing: undefined as never }).shatterSwing).toBe(0)
    expect(PATCH_RANGES.shatterSwing).toEqual([0, 0.6])
  })
})

describe('resetAdvancedToDefault', () => {
  const edited = sanitizePatch({
    ...DEFAULT_PATCH,
    mode: 'shatter',
    grainSizeMs: 50,
    densityHz: 30,
    position: 0.7,
    spray: 0.8,
    bpm: 90,
    shatterDivision: '1/8',
    // advanced surface — every field moved off its default
    regionStart: 0.2,
    regionEnd: 0.6,
    timingJitter: 0.5,
    scanSpeed: 1,
    pitchSemitones: 7,
    pitchSpreadSemitones: 5,
    reverseProbability: 0.9,
    stereoSpread: 0.2,
    window: 'hard',
    outputGain: 0.4,
  })

  it('restores every advanced parameter to its default', () => {
    const reset = resetAdvancedToDefault(edited)
    for (const key of ADVANCED_PARAM_KEYS) {
      expect(reset[key]).toEqual(DEFAULT_PATCH[key])
    }
  })

  it('preserves the main performance parameters', () => {
    const reset = resetAdvancedToDefault(edited)
    expect(reset.mode).toBe('shatter')
    expect(reset.grainSizeMs).toBe(50)
    expect(reset.densityHz).toBe(30)
    expect(reset.position).toBe(0.7)
    expect(reset.spray).toBe(0.8)
    expect(reset.bpm).toBe(90)
    expect(reset.shatterDivision).toBe('1/8')
  })
})
