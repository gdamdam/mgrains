import { describe, expect, it } from 'vitest'
import { Limiter } from './limiter'

const SR = 48000

describe('Limiter', () => {
  it('limits a signal well above the ceiling to <= ceiling on both channels', () => {
    const limiter = new Limiter(SR)
    const ceiling = 0.9
    limiter.setParams({ ceiling, release: 0.1 })
    // Constant tone at 2x the ceiling on both channels.
    for (let i = 0; i < 4096; i += 1) {
      const [l, r] = limiter.process(1.8, 1.8)
      expect(Math.abs(l)).toBeLessThanOrEqual(ceiling + 1e-9)
      expect(Math.abs(r)).toBeLessThanOrEqual(ceiling + 1e-9)
    }
  })

  it('never overshoots the ceiling even on the very first loud sample (instant attack)', () => {
    const limiter = new Limiter(SR)
    const ceiling = 0.8
    limiter.setParams({ ceiling, release: 0.3 })
    // First sample is already a huge spike: instant attack must catch it.
    const [l, r] = limiter.process(5, -5)
    expect(Math.abs(l)).toBeLessThanOrEqual(ceiling + 1e-9)
    expect(Math.abs(r)).toBeLessThanOrEqual(ceiling + 1e-9)
  })

  it('passes a signal below the ceiling through ~unchanged (transparent)', () => {
    const limiter = new Limiter(SR)
    limiter.setParams({ ceiling: 0.95, release: 0.1 })
    for (let i = 0; i < 1000; i += 1) {
      const x = 0.3 * Math.sin((TWO_PI * 220 * i) / SR)
      const y = 0.2 * Math.sin((TWO_PI * 330 * i) / SR)
      const [l, r] = limiter.process(x, y)
      expect(l).toBeCloseTo(x, 6)
      expect(r).toBeCloseTo(y, 6)
    }
  })

  it('applies stereo-linked gain reduction: a loud-left burst attenuates BOTH channels by the same factor', () => {
    const limiter = new Limiter(SR)
    const ceiling = 0.5
    limiter.setParams({ ceiling, release: 0.5 })
    // Left is loud (2.0), right is quiet (0.4). The peak is |L| = 2.0, so the
    // gain must be ceiling / 2.0 = 0.25, applied to BOTH channels.
    const left = 2.0
    const right = 0.4
    const [l, r] = limiter.process(left, right)
    const expectedGain = ceiling / left
    expect(l).toBeCloseTo(left * expectedGain, 6)
    expect(r).toBeCloseTo(right * expectedGain, 6)
    // The image is preserved: L/R ratio is unchanged after limiting.
    expect(l / r).toBeCloseTo(left / right, 6)
    // Left now sits at the ceiling; right is well below it.
    expect(Math.abs(l)).toBeCloseTo(ceiling, 6)
    expect(Math.abs(r)).toBeLessThan(ceiling)
  })

  it('releases gain back toward unity over time after a loud burst', () => {
    const limiter = new Limiter(SR)
    const ceiling = 0.5
    limiter.setParams({ ceiling, release: 0.1 })
    // Drive the limiter hard for a moment to pull gain down.
    for (let i = 0; i < 64; i += 1) {
      limiter.process(4, 4)
    }
    // Then feed a quiet signal and watch the applied gain recover toward unity.
    const probe = 0.01
    const early = limiter.process(probe, probe)[0] / probe
    for (let i = 0; i < SR; i += 1) {
      limiter.process(probe, probe)
    }
    const late = limiter.process(probe, probe)[0] / probe
    expect(late).toBeGreaterThan(early)
    expect(late).toBeCloseTo(1, 3)
  })

  it('keeps output finite for non-finite / extreme input', () => {
    const limiter = new Limiter(SR)
    limiter.setParams({ ceiling: 0.95, release: 0.1 })
    const samples: [number, number][] = [
      [NaN, 0.5],
      [0.5, Infinity],
      [-Infinity, NaN],
      [1e30, -1e30],
    ]
    for (const [a, b] of samples) {
      const [l, r] = limiter.process(a, b)
      expect(Number.isFinite(l)).toBe(true)
      expect(Number.isFinite(r)).toBe(true)
      expect(Math.abs(l)).toBeLessThanOrEqual(0.95 + 1e-9)
      expect(Math.abs(r)).toBeLessThanOrEqual(0.95 + 1e-9)
    }
  })

  it('reset restores unity gain', () => {
    const limiter = new Limiter(SR)
    limiter.setParams({ ceiling: 0.5, release: 0.5 })
    for (let i = 0; i < 256; i += 1) {
      limiter.process(4, 4)
    }
    limiter.reset()
    // Immediately after reset a quiet sample passes through at unity gain.
    const probe = 0.02
    const [l, r] = limiter.process(probe, probe)
    expect(l).toBeCloseTo(probe, 6)
    expect(r).toBeCloseTo(probe, 6)
  })

  it('is deterministic for identical input', () => {
    const run = (): number[] => {
      const limiter = new Limiter(SR)
      limiter.setParams({ ceiling: 0.7, release: 0.2 })
      const out: number[] = []
      for (let i = 0; i < 2000; i += 1) {
        const x = 1.5 * Math.sin((TWO_PI * 110 * i) / SR)
        const y = 1.2 * Math.cos((TWO_PI * 110 * i) / SR)
        const [l, r] = limiter.process(x, y)
        out.push(l, r)
      }
      return out
    }
    expect(run()).toEqual(run())
  })

  it('processInto writes the same result as process without allocating', () => {
    const limiter = new Limiter(SR)
    limiter.setParams({ ceiling: 0.6, release: 0.15 })
    const ref = new Limiter(SR)
    ref.setParams({ ceiling: 0.6, release: 0.15 })
    const out = new Float64Array(2)
    for (let i = 0; i < 500; i += 1) {
      const x = 1.3 * Math.sin((TWO_PI * 200 * i) / SR)
      const y = 0.9 * Math.sin((TWO_PI * 200 * i) / SR + 1)
      limiter.processInto(x, y, out)
      const [l, r] = ref.process(x, y)
      expect(out[0]).toBe(l)
      expect(out[1]).toBe(r)
    }
  })
})

const TWO_PI = Math.PI * 2
