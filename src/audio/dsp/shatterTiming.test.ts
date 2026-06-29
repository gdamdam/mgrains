import { describe, expect, it } from 'vitest'
import { shatterStepFrames } from './shatterTiming'

describe('shatterStepFrames', () => {
  it('maps straight, dotted, and triplet divisions to sample frames', () => {
    expect(shatterStepFrames(48_000, 120, '1/4')).toBe(24_000)
    expect(shatterStepFrames(48_000, 120, '1/16')).toBe(6_000)
    expect(shatterStepFrames(48_000, 120, '1/16D')).toBe(9_000)
    expect(shatterStepFrames(48_000, 120, '1/16T')).toBe(4_000)
  })
})
