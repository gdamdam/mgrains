import { describe, expect, it } from 'vitest'
import { RingMod } from './ringMod'

const SR = 48000

describe('RingMod', () => {
  it('at amount 1 multiplies the input by the sine carrier', () => {
    const f = 1000
    const ring = new RingMod(SR)
    ring.setParams({ frequency: f, amount: 1 })
    // Phase convention: carrier[n] = sin(2π f n / sr), advanced AFTER the
    // sample is produced, so the very first sample multiplies by sin(0) = 0
    // and sample n uses sin(2π f n / sr).
    for (let n = 0; n < 256; n += 1) {
      const x = Math.sin(n * 0.123) // arbitrary deterministic signal
      const expected = x * Math.sin((2 * Math.PI * f * n) / SR)
      const [l, r] = ring.process(x, x)
      expect(l).toBeCloseTo(expected, 6)
      expect(r).toBeCloseTo(expected, 6)
    }
  })

  it('amount 0 is a dry bypass', () => {
    const ring = new RingMod(SR)
    ring.setParams({ frequency: 500, amount: 0 })
    for (let n = 0; n < 128; n += 1) {
      const l = Math.sin(n * 0.31)
      const r = Math.cos(n * 0.17)
      const [outL, outR] = ring.process(l, r)
      expect(outL).toBeCloseTo(l, 12)
      expect(outR).toBeCloseTo(r, 12)
    }
  })

  it('mixes dry and wet at intermediate amount', () => {
    const f = 800
    const amount = 0.4
    const ring = new RingMod(SR)
    ring.setParams({ frequency: f, amount })
    for (let n = 0; n < 64; n += 1) {
      const x = Math.sin(n * 0.21) + 0.3
      const carrier = Math.sin((2 * Math.PI * f * n) / SR)
      const expected = x * (1 - amount) + x * carrier * amount
      const [l] = ring.process(x, x)
      expect(l).toBeCloseTo(expected, 6)
    }
  })

  it('changes the carrier rate when frequency changes', () => {
    // A higher carrier frequency crosses zero more often, so count sign
    // changes of the carrier (recovered by driving a constant DC input at
    // amount 1, which yields out = dc * carrier).
    const countZeroCrossings = (frequency: number): number => {
      const ring = new RingMod(SR)
      ring.setParams({ frequency, amount: 1 })
      let prev = 0
      let crossings = 0
      for (let n = 0; n < 4800; n += 1) {
        const [v] = ring.process(1, 1)
        if (n > 0 && Math.sign(v) !== Math.sign(prev) && v !== 0) crossings += 1
        prev = v
      }
      return crossings
    }
    const low = countZeroCrossings(200)
    const high = countZeroCrossings(2000)
    expect(high).toBeGreaterThan(low)
  })

  it('output stays finite and never exceeds the input magnitude', () => {
    const ring = new RingMod(SR)
    ring.setParams({ frequency: 1234, amount: 1 })
    for (let n = 0; n < 2000; n += 1) {
      const x = 0.8 * Math.sin(n * 0.05)
      const [l, r] = ring.process(x, x)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
      // |carrier| <= 1 so the wet path never amplifies; dry/wet mix is convex.
      expect(Math.abs(l)).toBeLessThanOrEqual(Math.abs(x) + 1e-9)
      expect(Math.abs(r)).toBeLessThanOrEqual(Math.abs(x) + 1e-9)
    }
  })

  it('clamps frequency into the valid range', () => {
    const ring = new RingMod(SR)
    // Out-of-range frequencies must not produce NaN/Inf or runaway phase.
    for (const f of [-100, 0, 1e9, Number.NaN, Number.POSITIVE_INFINITY]) {
      ring.setParams({ frequency: f, amount: 1 })
      ring.reset()
      for (let n = 0; n < 100; n += 1) {
        const [l, r] = ring.process(0.5, -0.5)
        expect(Number.isFinite(l)).toBe(true)
        expect(Number.isFinite(r)).toBe(true)
      }
    }
  })

  it('reset() restores the carrier phase and is deterministic', () => {
    const ring = new RingMod(SR)
    ring.setParams({ frequency: 777, amount: 1 })
    const first: number[] = []
    for (let n = 0; n < 200; n += 1) {
      first.push(ring.process(Math.sin(n * 0.07), 0)[0])
    }
    ring.reset()
    const second: number[] = []
    for (let n = 0; n < 200; n += 1) {
      second.push(ring.process(Math.sin(n * 0.07), 0)[0])
    }
    for (let n = 0; n < first.length; n += 1) {
      expect(second[n]).toBe(first[n])
    }
  })

  it('processInto writes into the provided buffer without allocating a tuple', () => {
    const ring = new RingMod(SR)
    ring.setParams({ frequency: 600, amount: 1 })
    const out = new Float64Array(2)
    ring.processInto(0.5, 0.25, out)
    // First sample multiplies by sin(0) = 0 under the post-advance phase convention.
    expect(out[0]).toBeCloseTo(0, 12)
    expect(out[1]).toBeCloseTo(0, 12)
    ring.processInto(0.5, 0.25, out)
    const carrier1 = Math.sin((2 * Math.PI * 600) / SR)
    expect(out[0]).toBeCloseTo(0.5 * carrier1, 9)
    expect(out[1]).toBeCloseTo(0.25 * carrier1, 9)
  })

  it('sanitizes non-finite input to silence', () => {
    const ring = new RingMod(SR)
    ring.setParams({ frequency: 440, amount: 1 })
    const [l, r] = ring.process(Number.NaN, Number.POSITIVE_INFINITY)
    expect(l).toBe(0)
    expect(r).toBe(0)
  })
})
