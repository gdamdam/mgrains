import { describe, expect, it } from 'vitest'
import { pointerToRegionPosition } from './waveformPosition'

describe('pointerToRegionPosition', () => {
  it('maps a pointer x (whole-buffer normalized) into the region so the playhead lands under it', () => {
    // Playhead renders at regionStart + position * span; the inverse of that
    // mapping must recover the clicked x.
    expect(pointerToRegionPosition(0.4, 0.25, 0.75)).toBeCloseTo(0.3, 10)
    expect(pointerToRegionPosition(0.25, 0.25, 0.75)).toBe(0)
    expect(pointerToRegionPosition(0.75, 0.25, 0.75)).toBe(1)
  })

  it('clamps clicks outside the region to its edges', () => {
    expect(pointerToRegionPosition(0.1, 0.25, 0.75)).toBe(0)
    expect(pointerToRegionPosition(0.95, 0.25, 0.75)).toBe(1)
  })

  it('degrades safely on a zero-width region', () => {
    expect(pointerToRegionPosition(0.5, 0.4, 0.4)).toBe(1)
  })
})
