import { describe, expect, it } from 'vitest'
import { pointerToRegionPosition, pointerToRegionPositionViewport } from './waveformPosition'

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

describe('pointerToRegionPositionViewport', () => {
  const region = { start: 0.25, end: 0.75 }

  it('matches the whole-buffer mapping when the viewport is full', () => {
    // px 400 of 1000 -> buffer 0.4 -> region-relative 0.3.
    expect(pointerToRegionPositionViewport(400, 1000, { start: 0, end: 1 }, region)).toBeCloseTo(0.3, 6)
  })

  it('routes through a zoomed viewport', () => {
    // Viewport spans [0.25,0.75]; px 500 -> buffer 0.5 (region centre) -> 0.5.
    expect(pointerToRegionPositionViewport(500, 1000, { start: 0.25, end: 0.75 }, region)).toBeCloseTo(0.5, 6)
  })

  it('clamps pixels outside the region to its edges', () => {
    expect(pointerToRegionPositionViewport(0, 1000, { start: 0, end: 1 }, region)).toBe(0)
    expect(pointerToRegionPositionViewport(1000, 1000, { start: 0, end: 1 }, region)).toBe(1)
  })
})
