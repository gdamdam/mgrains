import { describe, expect, it } from 'vitest'
import { Comb } from './comb'

const SR = 48000

/** Drive a left/right impulse through the comb and collect `length` samples. */
function impulseResponse(comb: Comb, length: number): { left: Float32Array; right: Float32Array } {
  const left = new Float32Array(length)
  const right = new Float32Array(length)
  for (let i = 0; i < length; i += 1) {
    const drive = i === 0 ? 1 : 0
    const [l, r] = comb.process(drive, drive)
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

/**
 * Indices of local-maximum magnitude peaks above `threshold`. Used to confirm
 * the ringing is periodic at the comb period.
 */
function peakIndices(signal: Float32Array, threshold: number): number[] {
  const peaks: number[] = []
  for (let i = 1; i < signal.length - 1; i += 1) {
    const mag = Math.abs(signal[i])
    if (mag > threshold && mag >= Math.abs(signal[i - 1]) && mag > Math.abs(signal[i + 1])) {
      peaks.push(i)
    }
  }
  return peaks
}

describe('Comb', () => {
  it('rings periodically at ~frequency after an impulse and stays finite', () => {
    const comb = new Comb(SR)
    const frequency = 480
    comb.setParams({ frequency, resonance: 0.85 })
    const period = SR / frequency // 100 samples
    const { left } = impulseResponse(comb, 4000)

    for (let i = 0; i < left.length; i += 1) {
      expect(Number.isFinite(left[i])).toBe(true)
    }

    // The ringing peaks should be spaced ~one comb period apart.
    const peaks = peakIndices(left, 0.05)
    expect(peaks.length).toBeGreaterThan(3)
    let gapSum = 0
    let gaps = 0
    for (let i = 1; i < peaks.length; i += 1) {
      gapSum += peaks[i] - peaks[i - 1]
      gaps += 1
    }
    const meanGap = gapSum / gaps
    expect(meanGap).toBeGreaterThan(period * 0.9)
    expect(meanGap).toBeLessThan(period * 1.1)
  })

  it('decays toward silence after the impulse (later RMS < earlier RMS)', () => {
    const comb = new Comb(SR)
    comb.setParams({ frequency: 220, resonance: 0.8 })
    const { left } = impulseResponse(comb, 40000)
    const early = rms(left, 1000, 5000)
    const late = rms(left, 30000, 34000)
    expect(late).toBeLessThan(early)
    expect(rms(left, 36000, 40000)).toBeLessThan(1e-2)
  })

  it('higher resonance rings longer than lower resonance', () => {
    const lowRes = new Comb(SR)
    lowRes.setParams({ frequency: 330, resonance: 0.5 })
    const highRes = new Comb(SR)
    highRes.setParams({ frequency: 330, resonance: 0.9 })

    const lengthSamples = 30000
    const lowIr = impulseResponse(lowRes, lengthSamples)
    const highIr = impulseResponse(highRes, lengthSamples)

    // A higher feedback resonance sustains longer, so the late-tail energy
    // is greater than for the more damped, lower-resonance comb.
    const lowLate = rms(lowIr.left, 18000, 30000)
    const highLate = rms(highIr.left, 18000, 30000)
    expect(highLate).toBeGreaterThan(lowLate)
  })

  it('clamps resonance: 5 behaves like the max and stays bounded over a long render', () => {
    const overdriven = new Comb(SR)
    overdriven.setParams({ frequency: 110, resonance: 5 })
    const atMax = new Comb(SR)
    atMax.setParams({ frequency: 110, resonance: 0.95 })

    let last = 0
    for (let i = 0; i < 200000; i += 1) {
      const x = Math.sin(i * 0.05)
      const [overL] = overdriven.process(x, x)
      const [maxL] = atMax.process(x, x)
      // Clamped resonance of 5 should behave identically to the max (0.95).
      expect(overL).toBe(maxL)
      last = overL
    }
    // Even at the clamped maximum the output must remain finite and bounded.
    expect(Number.isFinite(last)).toBe(true)
    expect(Math.abs(last)).toBeLessThan(50)
  })

  it('clamps frequency to a sane range without producing NaN/Inf', () => {
    for (const frequency of [1, 20, 4000, 20000]) {
      const comb = new Comb(SR)
      comb.setParams({ frequency, resonance: 0.9 })
      const { left } = impulseResponse(comb, 8000)
      for (let i = 0; i < left.length; i += 1) {
        expect(Number.isFinite(left[i])).toBe(true)
      }
    }
  })

  it('reset() clears internal state so the same input reproduces output', () => {
    const comb = new Comb(SR)
    comb.setParams({ frequency: 440, resonance: 0.85 })
    const first = impulseResponse(comb, 8000)
    comb.reset()
    const second = impulseResponse(comb, 8000)
    for (let i = 0; i < first.left.length; i += 1) {
      expect(second.left[i]).toBe(first.left[i])
      expect(second.right[i]).toBe(first.right[i])
    }
  })

  it('is deterministic: same input and params produce identical output', () => {
    const a = new Comb(SR)
    a.setParams({ frequency: 300, resonance: 0.7 })
    const b = new Comb(SR)
    b.setParams({ frequency: 300, resonance: 0.7 })
    for (let i = 0; i < 5000; i += 1) {
      const x = Math.sin(i * 0.05) * 0.5
      const [al, ar] = a.process(x, x)
      const [bl, br] = b.process(x, x)
      expect(bl).toBe(al)
      expect(br).toBe(ar)
    }
  })

  it('processInto writes a stereo pair without allocating a tuple', () => {
    const comb = new Comb(SR)
    comb.setParams({ frequency: 440, resonance: 0.6 })
    const out = new Float64Array(2)
    comb.processInto(1, 1, out)
    expect(Number.isFinite(out[0])).toBe(true)
    expect(Number.isFinite(out[1])).toBe(true)
  })
})

describe('Comb retune', () => {
  it('crossfades the read tap on retune instead of stepping', () => {
    const comb = new Comb(48_000)
    comb.setParams({ frequency: 220, resonance: 0.85 })
    const out = new Float64Array(2)
    const input = (index: number) => Math.sin(2 * Math.PI * 110 * index / 48_000) * 0.5
    const outputs = new Float64Array(9_600)
    for (let index = 0; index < outputs.length; index += 1) {
      if (index === 4_800) comb.setParams({ frequency: 331, resonance: 0.85 })
      comb.processInto(input(index), input(index), out)
      outputs[index] = out[0]
    }

    const maxDelta = (from: number, to: number) => {
      let max = 0
      for (let index = from + 1; index < to; index += 1) {
        max = Math.max(max, Math.abs(outputs[index] - outputs[index - 1]))
      }
      return max
    }

    // While ringing, an instantaneous read-tap jump (218 → 145 samples) steps
    // the output by O(signal); a 5 ms crossfade keeps the retune window's
    // sample-to-sample movement in the same league as steady state.
    const steady = maxDelta(2_000, 4_800)
    const retune = maxDelta(4_800, 5_600)
    expect(retune).toBeLessThan(steady * 2)
  })
})
