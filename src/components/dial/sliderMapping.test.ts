import { describe, expect, it } from 'vitest'
import { SLIDER_STEPS, fromSlider, toSlider } from './sliderMapping'

describe('sliderMapping', () => {
  it('maps linear midpoint round-trip', () => {
    const s = toSlider(50, { minimum: 0, maximum: 100 })
    expect(s).toBe(SLIDER_STEPS / 2)
    expect(fromSlider(s, { minimum: 0, maximum: 100 })).toBeCloseTo(50, 6)
  })

  it('maps log scale round-trip', () => {
    const s = toSlider(100, { minimum: 10, maximum: 1000, scale: 'log' })
    expect(s).toBe(SLIDER_STEPS / 2)
    expect(fromSlider(s, { minimum: 10, maximum: 1000, scale: 'log' })).toBeCloseTo(100, 4)
  })

  it('clamps out-of-range slider input', () => {
    expect(fromSlider(SLIDER_STEPS, { minimum: 0, maximum: 100 })).toBe(100)
    expect(fromSlider(0, { minimum: 0, maximum: 100 })).toBe(0)
  })

  it('snaps to step when provided', () => {
    expect(fromSlider(SLIDER_STEPS / 2, { minimum: 0, maximum: 100, step: 5 })).toBe(50)
    const near = fromSlider(toSlider(52, { minimum: 0, maximum: 100 }), { minimum: 0, maximum: 100, step: 5 })
    expect(near).toBe(50)
  })
})
