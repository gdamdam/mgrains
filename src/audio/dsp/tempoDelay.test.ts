import { describe, expect, it } from 'vitest'
import { detectDiscontinuities, sineSource } from './artifactDetection'
import { divisionToSeconds, TempoDelay } from './tempoDelay'

const SR = 48000

// Drive a single impulse through the left channel, then render `tail` silent
// samples, collecting the left-channel output of every sample.
function renderImpulse(
  delay: TempoDelay,
  tail: number,
  impulse = 1,
): number[] {
  const out: number[] = []
  out.push(delay.process(impulse, impulse)[0])
  for (let i = 0; i < tail; i += 1) {
    out.push(delay.process(0, 0)[0])
  }
  return out
}

// Sum of absolute first differences — a cheap proxy for high-frequency energy.
// A darker (more low-passed) signal changes less sample-to-sample.
function hfEnergy(samples: number[]): number {
  let total = 0
  for (let i = 1; i < samples.length; i += 1) {
    total += Math.abs(samples[i] - samples[i - 1])
  }
  return total
}

describe('divisionToSeconds', () => {
  it('converts a quarter note at 120 bpm to 0.5 s', () => {
    expect(divisionToSeconds(1 / 4, 120)).toBeCloseTo(0.5, 6)
  })

  it('converts an eighth note at 120 bpm to 0.25 s', () => {
    expect(divisionToSeconds(1 / 8, 120)).toBeCloseTo(0.25, 6)
  })
})

describe('TempoDelay', () => {
  it('reproduces an impulse roughly timeSeconds later', () => {
    const delay = new TempoDelay(SR)
    const timeSeconds = 0.01
    // No feedback: a single clean echo at the delay tap.
    delay.setParams({ timeSeconds, feedback: 0, tone: 0, width: 0 })
    const expected = Math.round(timeSeconds * SR)
    const out = renderImpulse(delay, expected + 50)

    // Find the index of the loudest tap after the immediate dry-free output.
    let peakIndex = 0
    let peak = 0
    for (let i = 1; i < out.length; i += 1) {
      if (Math.abs(out[i]) > peak) {
        peak = Math.abs(out[i])
        peakIndex = i
      }
    }
    expect(Math.abs(peakIndex - expected)).toBeLessThanOrEqual(2)
    expect(peak).toBeGreaterThan(0.1)
  })

  it('decays with feedback 0.5 (each echo smaller than the last)', () => {
    const delay = new TempoDelay(SR)
    const timeSeconds = 0.005
    delay.setParams({ timeSeconds, feedback: 0.5, tone: 0, width: 0 })
    const step = Math.round(timeSeconds * SR)
    const out = renderImpulse(delay, step * 5 + 20)

    // Peak magnitude in a small window around each echo tap; they must strictly
    // shrink. A window (not the exact index) accounts for the feedback LPF
    // smearing the impulse across a few samples.
    const tapPeak = (center: number): number => {
      let p = 0
      for (let i = center - 3; i <= center + 3; i += 1) {
        if (i >= 0 && i < out.length) p = Math.max(p, Math.abs(out[i]))
      }
      return p
    }
    const taps: number[] = []
    for (let n = 1; n <= 4; n += 1) {
      taps.push(tapPeak(n * step))
    }
    for (let i = 1; i < taps.length; i += 1) {
      expect(taps[i]).toBeLessThan(taps[i - 1])
    }
    expect(taps.every((v) => Number.isFinite(v))).toBe(true)
  })

  it('clamps feedback >= 1 to a stable value and stays bounded', () => {
    const delay = new TempoDelay(SR)
    delay.setParams({ timeSeconds: 0.003, feedback: 5, tone: 0, width: 0 })
    let peak = 0
    // Feed an impulse, then a long render: a clamped (<1) feedback must decay
    // rather than blow up over many delay cycles.
    let [l] = delay.process(1, 1)
    peak = Math.max(peak, Math.abs(l))
    for (let i = 0; i < SR * 2; i += 1) {
      ;[l] = delay.process(0, 0)
      peak = Math.max(peak, Math.abs(l))
      expect(Number.isFinite(l)).toBe(true)
    }
    // Bounded: never runs away past a generous ceiling.
    expect(peak).toBeLessThan(4)
  })

  it('tone at 1 (dark) yields less HF in the echoes than tone 0', () => {
    const timeSeconds = 0.004
    const tail = Math.round(timeSeconds * SR) * 6 + 10

    const bright = new TempoDelay(SR)
    bright.setParams({ timeSeconds, feedback: 0.6, tone: 0, width: 0 })
    const brightOut = renderImpulse(bright, tail)

    const dark = new TempoDelay(SR)
    dark.setParams({ timeSeconds, feedback: 0.6, tone: 1, width: 0 })
    const darkOut = renderImpulse(dark, tail)

    expect(hfEnergy(darkOut)).toBeLessThan(hfEnergy(brightOut))
  })

  it('reset() clears the buffer to match a fresh instance', () => {
    const params = {
      timeSeconds: 0.004,
      feedback: 0.6,
      tone: 0.3,
      width: 0.4,
    }
    const used = new TempoDelay(SR)
    used.setParams(params)
    for (let i = 0; i < 500; i += 1) {
      used.process(Math.sin(i * 0.1), Math.cos(i * 0.1))
    }
    used.reset()
    used.setParams(params)

    const fresh = new TempoDelay(SR)
    fresh.setParams(params)

    for (let i = 0; i < 200; i += 1) {
      const input = Math.sin(i * 0.07)
      const a = used.process(input, input)
      const b = fresh.process(input, input)
      expect(a[0]).toBeCloseTo(b[0], 10)
      expect(a[1]).toBeCloseTo(b[1], 10)
    }
  })

  it('is deterministic for identical input and params', () => {
    const params = {
      timeSeconds: 0.006,
      feedback: 0.7,
      tone: 0.5,
      width: 0.6,
    }
    const a = new TempoDelay(SR)
    const b = new TempoDelay(SR)
    a.setParams(params)
    b.setParams(params)

    for (let i = 0; i < 1000; i += 1) {
      const left = Math.sin(i * 0.05)
      const right = Math.sin(i * 0.05 + 1)
      const outA = a.process(left, right)
      const outB = b.process(left, right)
      expect(outA[0]).toBe(outB[0])
      expect(outA[1]).toBe(outB[1])
    }
  })

  it('crossfades the read head on a warm delay-time change (no click)', () => {
    // A steady sine through a no-feedback delay yields a delayed sine (smooth).
    // Changing the time jumps the integer read tap; here 0.02 s -> 0.005 s shifts
    // the 300 Hz tap by ~half a period, i.e. nearly antiphase — a hard click
    // without the read-head crossfade.
    const delay = new TempoDelay(SR)
    delay.setParams({ timeSeconds: 0.02, feedback: 0, tone: 0, width: 0 })
    const sine = sineSource(SR, 300, SR, 0.8)
    const wet = new Float32Array(sine.length)
    const change = SR >> 1
    for (let i = 0; i < change; i += 1) wet[i] = delay.process(sine[i], sine[i])[0]
    delay.setParams({ timeSeconds: 0.005, feedback: 0, tone: 0, width: 0 })
    for (let i = change; i < sine.length; i += 1) wet[i] = delay.process(sine[i], sine[i])[0]

    expect(detectDiscontinuities(wet)).toHaveLength(0)
  })

  it('snaps (no crossfade) when the time is set on a cold line', () => {
    // Cold instance: time set before any audio. Must match a reference that never
    // changes time — i.e. the crossfade machinery is inert until the line warms.
    const a = new TempoDelay(SR)
    a.setParams({ timeSeconds: 0.5, feedback: 0.4, tone: 0.2, width: 0.3 })
    a.setParams({ timeSeconds: 0.004, feedback: 0.4, tone: 0.2, width: 0.3 })
    const b = new TempoDelay(SR)
    b.setParams({ timeSeconds: 0.004, feedback: 0.4, tone: 0.2, width: 0.3 })
    for (let i = 0; i < 1000; i += 1) {
      const x = Math.sin(i * 0.05)
      expect(a.process(x, x)[0]).toBeCloseTo(b.process(x, x)[0], 10)
    }
  })

  it('produces a stereo offset (ping-pong) when width > 0', () => {
    const delay = new TempoDelay(SR)
    delay.setParams({ timeSeconds: 0.005, feedback: 0.5, tone: 0, width: 1 })
    // Impulse on the left only; with width the energy should cross channels
    // over time rather than staying purely on the left.
    let crossEnergy = 0
    delay.process(1, 0)
    for (let i = 0; i < SR; i += 1) {
      const [, r] = delay.process(0, 0)
      crossEnergy += Math.abs(r)
    }
    expect(crossEnergy).toBeGreaterThan(0.01)
  })
})
