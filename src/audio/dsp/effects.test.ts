import { describe, expect, it } from 'vitest'
import {
  bitcrush,
  DelayLine,
  OnePole,
  SampleRateReducer,
  softClipDrive,
} from './effects'

describe('softClipDrive', () => {
  it('stays bounded within roughly [-1, 1] for large inputs', () => {
    for (const drive of [0, 0.25, 0.5, 0.75, 1]) {
      expect(Math.abs(softClipDrive(10, drive))).toBeLessThanOrEqual(1.0001)
      expect(Math.abs(softClipDrive(-10, drive))).toBeLessThanOrEqual(1.0001)
    }
  })

  it('is monotonic in the input', () => {
    const drive = 0.6
    let previous = softClipDrive(-5, drive)
    for (let x = -5; x <= 5; x += 0.1) {
      const value = softClipDrive(x, drive)
      expect(value).toBeGreaterThanOrEqual(previous - 1e-9)
      previous = value
    }
  })

  it('is near unity for small signals at drive 0', () => {
    expect(softClipDrive(0.01, 0)).toBeCloseTo(0.01, 3)
    expect(softClipDrive(0, 0)).toBeCloseTo(0)
  })

  it('compresses a large input more as drive increases', () => {
    // More drive pushes a large input harder into saturation, so its output
    // sits closer to the ceiling (less headroom left below 1.0).
    const input = 0.9
    const lowHeadroom = 1 - softClipDrive(input, 0.1)
    const highHeadroom = 1 - softClipDrive(input, 1)
    expect(highHeadroom).toBeLessThan(lowHeadroom)
  })

  it('produces finite output for finite inputs', () => {
    expect(Number.isFinite(softClipDrive(0.5, 0.5))).toBe(true)
    expect(Number.isFinite(softClipDrive(1000, 1))).toBe(true)
  })
})

describe('bitcrush', () => {
  it('quantizes hard at 1 bit', () => {
    const a = bitcrush(0.1, 1)
    const b = bitcrush(0.4, 1)
    expect(a).toBe(b)
  })

  it('approaches the input as bits increase', () => {
    const input = 0.3137
    const coarse = Math.abs(bitcrush(input, 2) - input)
    const fine = Math.abs(bitcrush(input, 16) - input)
    expect(fine).toBeLessThan(coarse)
  })

  it('stays bounded and finite', () => {
    expect(Math.abs(bitcrush(0.99, 8))).toBeLessThanOrEqual(1)
    expect(Number.isFinite(bitcrush(-0.5, 4))).toBe(true)
  })
})

describe('SampleRateReducer', () => {
  it('holds the value for `factor` samples', () => {
    const reducer = new SampleRateReducer(3)
    expect(reducer.process(1)).toBe(1)
    expect(reducer.process(2)).toBe(1)
    expect(reducer.process(3)).toBe(1)
    expect(reducer.process(4)).toBe(4)
    expect(reducer.process(5)).toBe(4)
  })

  it('passes through with factor 1', () => {
    const reducer = new SampleRateReducer(1)
    expect(reducer.process(0.2)).toBe(0.2)
    expect(reducer.process(0.7)).toBe(0.7)
  })

  it('resets the hold state', () => {
    const reducer = new SampleRateReducer(2)
    reducer.process(5)
    reducer.reset()
    expect(reducer.process(9)).toBe(9)
  })
})

describe('OnePole', () => {
  it('lowpass converges to a steady DC input', () => {
    const filter = new OnePole()
    filter.setCutoff(0.1, 'lowpass')
    let value = 0
    for (let i = 0; i < 2000; i += 1) {
      value = filter.process(1)
    }
    expect(value).toBeCloseTo(1, 2)
  })

  it('highpass blocks DC', () => {
    const filter = new OnePole()
    filter.setCutoff(0.1, 'highpass')
    let value = 0
    for (let i = 0; i < 2000; i += 1) {
      value = filter.process(1)
    }
    expect(value).toBeCloseTo(0, 2)
  })

  it('stays finite at cutoff extremes', () => {
    for (const cutoff of [0, 1]) {
      for (const type of ['lowpass', 'highpass'] as const) {
        const filter = new OnePole()
        filter.setCutoff(cutoff, type)
        let value = 0
        for (let i = 0; i < 100; i += 1) {
          value = filter.process(Math.sin(i))
        }
        expect(Number.isFinite(value)).toBe(true)
      }
    }
  })

  it('resets internal state', () => {
    const filter = new OnePole()
    filter.setCutoff(0.05, 'lowpass')
    for (let i = 0; i < 100; i += 1) {
      filter.process(1)
    }
    filter.reset()
    expect(filter.process(0)).toBeCloseTo(0)
  })
})

describe('DelayLine', () => {
  it('reads back a written sample after the delay', () => {
    const delay = new DelayLine(16)
    delay.write(0.5)
    delay.write(0.25)
    delay.write(0.125)
    expect(delay.read(1)).toBe(0.25)
    expect(delay.read(2)).toBe(0.5)
  })

  it('processFeedback decays for feedback 0.5', () => {
    const delay = new DelayLine(64)
    const first = delay.processFeedback(1, 4, 0.5)
    let peak = Math.abs(first)
    for (let i = 0; i < 500; i += 1) {
      const out = delay.processFeedback(0, 4, 0.5)
      peak = Math.max(peak, Math.abs(out))
    }
    expect(peak).toBeLessThanOrEqual(Math.abs(first) + 1e-6)
    let tail = 0
    for (let i = 0; i < 500; i += 1) {
      tail = delay.processFeedback(0, 4, 0.5)
    }
    expect(Math.abs(tail)).toBeLessThan(1e-3)
  })

  it('stays finite and resets', () => {
    const delay = new DelayLine(8)
    for (let i = 0; i < 50; i += 1) {
      delay.processFeedback(0.9, 3, 0.5)
    }
    delay.reset()
    expect(delay.read(3)).toBe(0)
  })
})
