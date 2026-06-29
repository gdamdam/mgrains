import { describe, expect, it } from 'vitest'
import { DEFAULT_PATCH, sanitizePatch } from './contracts'

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
})
