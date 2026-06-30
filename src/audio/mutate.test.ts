import { describe, expect, it } from 'vitest'
import { DEFAULT_PATCH, PATCH_RANGES, type GrainPatch } from './contracts'
import { mutatePatch } from './mutate'

// A patch with a non-trivial Shatter lane so mutation has something to chew on.
const basePatch: GrainPatch = {
  ...DEFAULT_PATCH,
  mode: 'shatter',
  shatterSteps: DEFAULT_PATCH.shatterSteps.map((step) => ({ ...step })),
}

describe('mutatePatch', () => {
  it('is deterministic: same patch + seed yields a byte-identical result', () => {
    expect(mutatePatch(basePatch, 42)).toEqual(mutatePatch(basePatch, 42))
  })

  it('changes at least one field from the input', () => {
    const mutated = mutatePatch(basePatch, 42)
    expect(mutated).not.toEqual(basePatch)
  })

  it('produces different results for different seeds', () => {
    const seeds = [1, 2, 3, 7, 11, 42, 1337, 0xdead]
    const results = seeds.map((seed) => JSON.stringify(mutatePatch(basePatch, seed)))
    const unique = new Set(results)
    // Not every seed must differ, but the family must not collapse to one value.
    expect(unique.size).toBeGreaterThan(1)
  })

  it('keeps continuous params within PATCH_RANGES', () => {
    for (const seed of [1, 5, 42, 99, 1234, 0xbeef]) {
      const p = mutatePatch(basePatch, seed)
      expect(p.grainSizeMs).toBeGreaterThanOrEqual(PATCH_RANGES.grainSizeMs[0])
      expect(p.grainSizeMs).toBeLessThanOrEqual(PATCH_RANGES.grainSizeMs[1])
      expect(p.densityHz).toBeGreaterThanOrEqual(PATCH_RANGES.densityHz[0])
      expect(p.densityHz).toBeLessThanOrEqual(PATCH_RANGES.densityHz[1])
      expect(p.spray).toBeGreaterThanOrEqual(PATCH_RANGES.spray[0])
      expect(p.spray).toBeLessThanOrEqual(PATCH_RANGES.spray[1])
      expect(p.timingJitter).toBeGreaterThanOrEqual(PATCH_RANGES.timingJitter[0])
      expect(p.timingJitter).toBeLessThanOrEqual(PATCH_RANGES.timingJitter[1])
      expect(p.pitchSpreadSemitones).toBeGreaterThanOrEqual(
        PATCH_RANGES.pitchSpreadSemitones[0],
      )
      expect(p.pitchSpreadSemitones).toBeLessThanOrEqual(
        PATCH_RANGES.pitchSpreadSemitones[1],
      )
    }
  })

  it('always returns exactly 16 sanitized Shatter steps', () => {
    for (const seed of [1, 42, 7777]) {
      const p = mutatePatch(basePatch, seed)
      expect(p.shatterSteps).toHaveLength(16)
      for (const step of p.shatterSteps) {
        expect(step.probability).toBeGreaterThanOrEqual(0)
        expect(step.probability).toBeLessThanOrEqual(1)
        expect(step.pitchOffsetSemitones).toBeGreaterThanOrEqual(-24)
        expect(step.pitchOffsetSemitones).toBeLessThanOrEqual(24)
        expect(Number.isInteger(step.pitchOffsetSemitones)).toBe(true)
        expect(step.ratchet).toBeGreaterThanOrEqual(1)
        expect(step.ratchet).toBeLessThanOrEqual(4)
        expect([1, 2, 3, 4]).toContain(step.ratchet)
        expect(typeof step.enabled).toBe('boolean')
        expect(typeof step.reverse).toBe('boolean')
      }
    }
  })

  it('emphasizes the Shatter lane: across seeds it toggles gates and moves pitch', () => {
    const seeds = Array.from({ length: 32 }, (_, i) => i + 1)
    let gateToggled = false
    let pitchShifted = false
    for (const seed of seeds) {
      const p = mutatePatch(basePatch, seed)
      for (let i = 0; i < 16; i += 1) {
        if (p.shatterSteps[i].enabled !== basePatch.shatterSteps[i].enabled) {
          gateToggled = true
        }
        if (
          p.shatterSteps[i].pitchOffsetSemitones
          !== basePatch.shatterSteps[i].pitchOffsetSemitones
        ) {
          pitchShifted = true
        }
      }
    }
    expect(gateToggled).toBe(true)
    expect(pitchShifted).toBe(true)
  })

  it('preserves mode, bpm and shatterDivision', () => {
    for (const seed of [1, 42, 0xface]) {
      const p = mutatePatch(basePatch, seed)
      expect(p.mode).toBe(basePatch.mode)
      expect(p.bpm).toBe(basePatch.bpm)
      expect(p.shatterDivision).toBe(basePatch.shatterDivision)
    }
  })

  it('keeps the region essentially intact', () => {
    for (const seed of [1, 42, 0xcafe]) {
      const p = mutatePatch(basePatch, seed)
      expect(Math.abs(p.regionStart - basePatch.regionStart)).toBeLessThan(0.05)
      expect(Math.abs(p.regionEnd - basePatch.regionEnd)).toBeLessThan(0.05)
    }
  })

  it('is a variation, not chaos: most continuous params stay near the input', () => {
    // Within a generous bound for the nudged params (relative move kept small).
    const p = mutatePatch(basePatch, 42)
    expect(p.grainSizeMs).toBeGreaterThan(basePatch.grainSizeMs * 0.7)
    expect(p.grainSizeMs).toBeLessThan(basePatch.grainSizeMs * 1.3)
    expect(p.densityHz).toBeGreaterThan(basePatch.densityHz * 0.7)
    expect(p.densityHz).toBeLessThan(basePatch.densityHz * 1.3)
  })

  it('does not mutate the input patch in place', () => {
    const snapshot = JSON.parse(JSON.stringify(basePatch))
    mutatePatch(basePatch, 42)
    expect(basePatch).toEqual(snapshot)
  })
})
