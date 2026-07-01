import { describe, expect, it } from 'vitest'
import { nextActiveIndex } from './selectNav'

describe('nextActiveIndex', () => {
  it('ArrowDown moves down, clamps at end', () => {
    expect(nextActiveIndex(0, 'ArrowDown', 3)).toBe(1)
    expect(nextActiveIndex(2, 'ArrowDown', 3)).toBe(2)
  })
  it('ArrowUp moves up, clamps at start', () => {
    expect(nextActiveIndex(2, 'ArrowUp', 3)).toBe(1)
    expect(nextActiveIndex(0, 'ArrowUp', 3)).toBe(0)
  })
  it('Home/End jump to bounds', () => {
    expect(nextActiveIndex(1, 'Home', 3)).toBe(0)
    expect(nextActiveIndex(1, 'End', 3)).toBe(2)
  })
  it('ignores unrelated keys', () => {
    expect(nextActiveIndex(1, 'Enter', 3)).toBe(1)
  })
})
