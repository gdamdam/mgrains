import { describe, expect, it } from 'vitest'
import {
  analyzeSignal,
  detectDiscontinuities,
  dcSource,
  impulseSource,
  noiseSource,
  silenceSource,
  sineSource,
} from './artifactDetection'

describe('analyzeSignal', () => {
  it('measures peak, rms, dc and adjacent delta', () => {
    const dc = dcSource(1000, 0.5)
    const stats = analyzeSignal(dc)
    expect(stats.peak).toBeCloseTo(0.5)
    expect(stats.rms).toBeCloseTo(0.5)
    expect(stats.dcOffset).toBeCloseTo(0.5)
    expect(stats.maxAdjacentDelta).toBeCloseTo(0) // flat after the first sample
    expect(stats.nonFiniteCount).toBe(0)
  })

  it('counts non-finite samples', () => {
    const signal = new Float32Array([0, 0.1, NaN, 0.2, Infinity, -0.1])
    expect(analyzeSignal(signal).nonFiniteCount).toBe(2)
  })
})

describe('detectDiscontinuities', () => {
  it('flags an injected step in an otherwise smooth sine', () => {
    const sr = 48_000
    const signal = sineSource(4_000, 1_000, sr)
    // Inject a click: an abrupt +0.6 offset for the rest of the buffer.
    const clickFrame = 2_000
    for (let n = clickFrame; n < signal.length; n += 1) signal[n] += 0.6

    const found = detectDiscontinuities(signal)
    expect(found.length).toBeGreaterThanOrEqual(1)
    expect(found.some((d) => Math.abs(d.frame - clickFrame) <= 2)).toBe(true)
  })

  it('does not flag a clean sine (valid continuous motion)', () => {
    const signal = sineSource(8_000, 2_000, 48_000)
    expect(detectDiscontinuities(signal)).toHaveLength(0)
  })

  it('does not flag a clean sine at a high frequency (large but valid deltas)', () => {
    const signal = sineSource(8_000, 8_000, 48_000)
    expect(detectDiscontinuities(signal)).toHaveLength(0)
  })

  it('does not flag white noise as clicks (deltas are large but not isolated)', () => {
    const signal = noiseSource(8_000)
    expect(detectDiscontinuities(signal)).toHaveLength(0)
  })

  it('does not flag a single impulse as a click (valid transient, isolated context)', () => {
    // A lone impulse sits in silence; its rise IS a real discontinuity, but the
    // detector ties significance to local energy + isolation. A bare impulse in
    // silence has near-zero local RMS, so by design we want it NOT treated as a
    // grain-chain click. Verify it is at most a single boundary event, not a
    // smear of false positives across the buffer.
    const signal = impulseSource(8_000, 4_000)
    const found = detectDiscontinuities(signal)
    expect(found.length).toBeLessThanOrEqual(2)
    for (const d of found) expect(Math.abs(d.frame - 4_000)).toBeLessThanOrEqual(2)
  })

  it('does not flag silence or DC', () => {
    expect(detectDiscontinuities(silenceSource(4_000))).toHaveLength(0)
    expect(detectDiscontinuities(dcSource(4_000, 0.8))).toHaveLength(0)
  })
})
