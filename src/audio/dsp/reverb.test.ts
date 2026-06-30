import { describe, expect, it } from 'vitest'
import { Reverb } from './reverb'

const SR = 48000

/** Drive an impulse through the reverb and collect `length` output samples. */
function impulseResponse(
  reverb: Reverb,
  length: number,
): { left: Float32Array; right: Float32Array } {
  const left = new Float32Array(length)
  const right = new Float32Array(length)
  for (let i = 0; i < length; i += 1) {
    const drive = i === 0 ? 1 : 0
    const [l, r] = reverb.process(drive, drive)
    left[i] = l
    right[i] = r
  }
  return { left, right }
}

/** RMS over a slice [start, end) of a signal. */
function rms(signal: Float32Array, start: number, end: number): number {
  let sum = 0
  for (let i = start; i < end; i += 1) {
    sum += signal[i] * signal[i]
  }
  return Math.sqrt(sum / (end - start))
}

/** Mean squared successive-sample difference — a proxy for HF energy. */
function highFreqEnergy(signal: Float32Array, start: number, end: number): number {
  let sum = 0
  for (let i = start + 1; i < end; i += 1) {
    const d = signal[i] - signal[i - 1]
    sum += d * d
  }
  return sum / (end - start - 1)
}

describe('Reverb', () => {
  it('produces a finite, bounded decaying tail from an impulse', () => {
    const reverb = new Reverb(SR)
    reverb.setParams({ size: 0.7, damp: 0.3, width: 1 })
    const { left, right } = impulseResponse(reverb, 20000)
    for (let i = 0; i < left.length; i += 1) {
      expect(Number.isFinite(left[i])).toBe(true)
      expect(Number.isFinite(right[i])).toBe(true)
      expect(Math.abs(left[i])).toBeLessThan(4)
      expect(Math.abs(right[i])).toBeLessThan(4)
    }
  })

  it('decays toward zero after the input stops (later RMS < earlier RMS)', () => {
    const reverb = new Reverb(SR)
    reverb.setParams({ size: 0.6, damp: 0.4, width: 1 })
    const { left } = impulseResponse(reverb, 48000)
    // Skip the initial buildup; compare an early window to a late window.
    const early = rms(left, 4000, 8000)
    const late = rms(left, 40000, 44000)
    expect(late).toBeLessThan(early)
    // And it should be near silence far into the tail.
    expect(rms(left, 44000, 48000)).toBeLessThan(1e-2)
  })

  it('higher size yields a longer/louder tail than lower size', () => {
    const small = new Reverb(SR)
    small.setParams({ size: 0.2, damp: 0.3, width: 1 })
    const large = new Reverb(SR)
    large.setParams({ size: 0.95, damp: 0.3, width: 1 })

    const lengthSamples = 30000
    const smallIr = impulseResponse(small, lengthSamples)
    const largeIr = impulseResponse(large, lengthSamples)

    // Late-tail energy: a bigger room rings longer, so its late RMS is higher.
    const smallLate = rms(smallIr.left, 20000, 30000)
    const largeLate = rms(largeIr.left, 20000, 30000)
    expect(largeLate).toBeGreaterThan(smallLate)
  })

  it('damp 1 yields less high-frequency energy in the tail than damp 0', () => {
    const bright = new Reverb(SR)
    bright.setParams({ size: 0.7, damp: 0, width: 1 })
    const dark = new Reverb(SR)
    dark.setParams({ size: 0.7, damp: 1, width: 1 })

    const lengthSamples = 24000
    const brightIr = impulseResponse(bright, lengthSamples)
    const darkIr = impulseResponse(dark, lengthSamples)

    const brightHf = highFreqEnergy(brightIr.left, 8000, 24000)
    const darkHf = highFreqEnergy(darkIr.left, 8000, 24000)
    expect(darkHf).toBeLessThan(brightHf)
  })

  it('reset() clears internal state so the same input reproduces output', () => {
    const reverb = new Reverb(SR)
    reverb.setParams({ size: 0.6, damp: 0.5, width: 0.8 })
    const first = impulseResponse(reverb, 8000)
    reverb.reset()
    const second = impulseResponse(reverb, 8000)
    for (let i = 0; i < first.left.length; i += 1) {
      expect(second.left[i]).toBe(first.left[i])
      expect(second.right[i]).toBe(first.right[i])
    }
  })

  it('is deterministic: same input and params produce identical output', () => {
    const a = new Reverb(SR)
    a.setParams({ size: 0.55, damp: 0.35, width: 0.9 })
    const b = new Reverb(SR)
    b.setParams({ size: 0.55, damp: 0.35, width: 0.9 })

    for (let i = 0; i < 5000; i += 1) {
      const x = Math.sin(i * 0.05) * 0.5
      const [al, ar] = a.process(x, x)
      const [bl, br] = b.process(x, x)
      expect(bl).toBe(al)
      expect(br).toBe(ar)
    }
  })

  it('stays bounded and finite for extreme params over a long noise-free run', () => {
    for (const size of [0, 1]) {
      for (const damp of [0, 1]) {
        for (const width of [0, 1]) {
          const reverb = new Reverb(SR)
          reverb.setParams({ size, damp, width })
          let value = 0
          for (let i = 0; i < 10000; i += 1) {
            const x = Math.sin(i * 0.1)
            const [l] = reverb.process(x, x)
            value = l
          }
          expect(Number.isFinite(value)).toBe(true)
          expect(Math.abs(value)).toBeLessThan(8)
        }
      }
    }
  })
})
