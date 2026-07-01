import { describe, expect, it } from 'vitest'
import { dragNormalized } from './dialDrag'

describe('dragNormalized', () => {
  it('dragging up (negative dy) increases the normalized value', () => {
    expect(dragNormalized(0.5, -50)).toBeCloseTo(0.75, 6)
  })

  it('dragging up clamps at 1', () => {
    expect(dragNormalized(0.9, -1000)).toBe(1)
  })

  it('dragging down (positive dy) decreases the normalized value', () => {
    expect(dragNormalized(0.5, 50)).toBeCloseTo(0.25, 6)
  })

  it('dragging down clamps at 0', () => {
    expect(dragNormalized(0.1, 1000)).toBe(0)
  })

  it('zero dy is a no-op', () => {
    expect(dragNormalized(0.42, 0)).toBe(0.42)
  })

  it('sensitivity scales the delta', () => {
    expect(dragNormalized(0.5, -100, 400)).toBeCloseTo(0.75, 6)
    expect(dragNormalized(0.5, -100, 100)).toBe(1)
  })
})
