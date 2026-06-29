import { describe, expect, it } from 'vitest'
import { grainWindow } from './windows'

describe('grainWindow', () => {
  it('keeps smooth windows closed at both endpoints', () => {
    expect(grainWindow('hann', 0)).toBe(0)
    expect(grainWindow('hann', 0.5)).toBeCloseTo(1)
    expect(grainWindow('hann', 1)).toBe(0)
  })

  it('mirrors percussive and reverse envelopes', () => {
    expect(grainWindow('percussive', 0.2)).toBeCloseTo(grainWindow('reverse', 0.8))
  })
})
