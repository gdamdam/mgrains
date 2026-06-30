import { describe, expect, it } from 'vitest'
import { Sub } from './sub'

const SR = 48000

/**
 * Goertzel single-bin magnitude estimate at `freq` Hz over `signal`. Returns
 * the squared magnitude of the bin — proportional to the energy at `freq`,
 * which is all the tests need (relative comparison dry-vs-wet).
 */
function goertzel(signal: Float64Array, freq: number, sampleRate: number): number {
  const w = (2 * Math.PI * freq) / sampleRate
  const coeff = 2 * Math.cos(w)
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < signal.length; i += 1) {
    const s0 = signal[i] + coeff * s1 - s2
    s2 = s1
    s1 = s0
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2
}

/** Generate a steady mono sine at `freq`, returned as a left/right pair. */
function steadySine(
  freq: number,
  length: number,
  amp = 0.5,
): { left: Float64Array; right: Float64Array } {
  const left = new Float64Array(length)
  const right = new Float64Array(length)
  for (let i = 0; i < length; i += 1) {
    const v = amp * Math.sin((2 * Math.PI * freq * i) / SR)
    left[i] = v
    right[i] = v
  }
  return { left, right }
}

/** RMS over a slice [start, end) of a signal. */
function rms(signal: Float64Array, start: number, end: number): number {
  let sum = 0
  for (let i = start; i < end; i += 1) {
    sum += signal[i] * signal[i]
  }
  return Math.sqrt(sum / (end - start))
}

describe('Sub', () => {
  it('adds low-frequency energy at `tune` versus the dry input', () => {
    const tune = 50
    const length = 48000
    const { left, right } = steadySine(220, length)

    const sub = new Sub(SR)
    sub.setParams({ tune })

    const out = new Float64Array(2)
    const wet = new Float64Array(length)
    for (let i = 0; i < length; i += 1) {
      sub.processInto(left[i], right[i], out)
      wet[i] = out[0]
    }

    // Compare bin energy at `tune` in the dry input vs the additive output.
    // The synthesised sub tone deposits energy at `tune` that the dry 220 Hz
    // sine has essentially none of.
    const dryBin = goertzel(left, tune, SR)
    const wetBin = goertzel(wet, tune, SR)
    expect(wetBin).toBeGreaterThan(dryBin * 10)
  })

  it('decays to ~silence after the input goes silent (envelope releases)', () => {
    const tune = 50
    const sub = new Sub(SR)
    sub.setParams({ tune })

    const out = new Float64Array(2)
    // Drive a steady tone to open the envelope.
    const driven = steadySine(220, 24000)
    for (let i = 0; i < driven.left.length; i += 1) {
      sub.processInto(driven.left[i], driven.right[i], out)
    }

    // Now feed silence and measure how the output decays.
    const tail = new Float64Array(48000)
    for (let i = 0; i < tail.length; i += 1) {
      sub.processInto(0, 0, out)
      tail[i] = out[0]
    }
    const early = rms(tail, 0, 1000)
    const late = rms(tail, 47000, 48000)
    expect(late).toBeLessThan(early)
    expect(late).toBeLessThan(1e-3)
  })

  it('produces finite, bounded output over a long render', () => {
    const tune = 60
    const sub = new Sub(SR)
    sub.setParams({ tune })

    const out = new Float64Array(2)
    const length = 96000
    for (let i = 0; i < length; i += 1) {
      // Mixed harmonic input, deterministic (no Math.random).
      const t = i / SR
      const l = 0.6 * Math.sin(2 * Math.PI * 110 * t) + 0.3 * Math.sin(2 * Math.PI * 330 * t)
      const r = 0.6 * Math.sin(2 * Math.PI * 110 * t) + 0.3 * Math.sin(2 * Math.PI * 550 * t)
      sub.processInto(l, r, out)
      expect(Number.isFinite(out[0])).toBe(true)
      expect(Number.isFinite(out[1])).toBe(true)
      expect(Math.abs(out[0])).toBeLessThan(4)
      expect(Math.abs(out[1])).toBeLessThan(4)
    }
  })

  it('reset clears state and is deterministic for identical input', () => {
    const tune = 45
    const sub = new Sub(SR)
    sub.setParams({ tune })

    const { left, right } = steadySine(180, 8000)
    const runA = new Float64Array(8000)
    const out = new Float64Array(2)
    for (let i = 0; i < left.length; i += 1) {
      sub.processInto(left[i], right[i], out)
      runA[i] = out[0]
    }

    sub.reset()

    const runB = new Float64Array(8000)
    for (let i = 0; i < left.length; i += 1) {
      sub.processInto(left[i], right[i], out)
      runB[i] = out[0]
    }

    // After reset the same input must reproduce the same output bit-for-bit.
    for (let i = 0; i < runA.length; i += 1) {
      expect(runB[i]).toBe(runA[i])
    }
  })

  it('clamps tune into the sub-bass range', () => {
    const sub = new Sub(SR)
    // Out-of-range requests must not throw and must keep output finite.
    sub.setParams({ tune: 5 })
    sub.setParams({ tune: 5000 })
    const out = new Float64Array(2)
    const { left, right } = steadySine(220, 2000)
    for (let i = 0; i < left.length; i += 1) {
      sub.processInto(left[i], right[i], out)
      expect(Number.isFinite(out[0])).toBe(true)
    }
  })

  it('process returns a fresh tuple matching processInto', () => {
    const sub = new Sub(SR)
    sub.setParams({ tune: 50 })
    const ref = new Sub(SR)
    ref.setParams({ tune: 50 })

    const out = new Float64Array(2)
    for (let i = 0; i < 5000; i += 1) {
      const v = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR)
      const [l, r] = sub.process(v, v)
      ref.processInto(v, v, out)
      expect(l).toBe(out[0])
      expect(r).toBe(out[1])
    }
  })
})
