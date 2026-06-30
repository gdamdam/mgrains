import { describe, expect, it } from 'vitest'
import { Wow } from './wow'

const SR = 48000

/**
 * Push a steady sine through the Wow processor and collect `length` output
 * samples for both channels. A pure sine is the cleanest probe for pitch
 * wobble: any modulation of the read position warps its instantaneous phase,
 * so the wet output drifts away from the dry sine.
 */
function runSine(
  wow: Wow,
  length: number,
  freqHz: number,
): { left: Float32Array; right: Float32Array; dry: Float32Array } {
  const left = new Float32Array(length)
  const right = new Float32Array(length)
  const dry = new Float32Array(length)
  const w = (2 * Math.PI * freqHz) / SR
  for (let i = 0; i < length; i += 1) {
    const x = Math.sin(i * w)
    dry[i] = x
    const [l, r] = wow.process(x, x)
    left[i] = l
    right[i] = r
  }
  return { left, right, dry }
}

/** RMS over a slice [start, end) of a signal. */
function rms(signal: Float32Array, start: number, end: number): number {
  let sum = 0
  for (let i = start; i < end; i += 1) {
    sum += signal[i] * signal[i]
  }
  return Math.sqrt(sum / (end - start))
}

/** RMS difference between two signals over [start, end). */
function rmsDiff(a: Float32Array, b: Float32Array, start: number, end: number): number {
  let sum = 0
  for (let i = start; i < end; i += 1) {
    const d = a[i] - b[i]
    sum += d * d
  }
  return Math.sqrt(sum / (end - start))
}

describe('Wow', () => {
  it('produces finite, bounded output for all params', () => {
    for (const rate of [0, 0.1, 1, 4, 8, 100]) {
      for (const depth of [0, 0.5, 1, 5]) {
        const wow = new Wow(SR)
        wow.setParams({ rate, depth })
        const { left, right } = runSine(wow, 8000, 220)
        // Aggregate the per-sample checks into one assertion per signal: a
        // per-sample expect() over 24 param combos was ~768k calls and pushed
        // this test near Vitest's 5 s limit. The coverage is identical.
        let bad = false
        for (let i = 0; i < left.length && !bad; i += 1) {
          bad = !Number.isFinite(left[i]) || !Number.isFinite(right[i])
            || Math.abs(left[i]) >= 4 || Math.abs(right[i]) >= 4
        }
        expect(bad, `rate=${rate} depth=${depth}`).toBe(false)
      }
    }
  })

  it('handles non-finite input safely', () => {
    const wow = new Wow(SR)
    wow.setParams({ rate: 2, depth: 0.6 })
    const out = new Float64Array(2)
    wow.processInto(Number.NaN, Number.POSITIVE_INFINITY, out)
    expect(Number.isFinite(out[0])).toBe(true)
    expect(Number.isFinite(out[1])).toBe(true)
  })

  it('with depth > 0 wobbles a steady input away from the dry signal', () => {
    const wow = new Wow(SR)
    wow.setParams({ rate: 5, depth: 0.9 })
    // Let the delay line prime, then compare wet vs dry well past the base
    // delay so the deviation is the modulation, not the initial fill.
    const { left, dry } = runSine(wow, 24000, 220)
    const deviation = rmsDiff(left, dry, 8000, 24000)
    // A wobbled sine genuinely departs from the steady reference.
    expect(deviation).toBeGreaterThan(0.05)
  })

  it('wobble is periodic — it varies window-to-window over the LFO cycle', () => {
    const rate = 4
    const wow = new Wow(SR)
    wow.setParams({ rate, depth: 0.9 })
    const { left } = runSine(wow, 48000, 220)
    // One LFO period in samples. Quarter-cycle windows land at different
    // points of the wobble, so their deviation from each other is non-trivial;
    // a full period later the motion repeats and the windows realign.
    const period = Math.round(SR / rate)
    const q = Math.round(period / 4)
    const winA = (start: number): Float32Array => left.subarray(start, start + q) as Float32Array
    // Windows at different phases of one cycle should differ...
    const base = 8000
    const phase0 = winA(base)
    const phase1 = winA(base + q)
    let crossDiff = 0
    for (let i = 0; i < q; i += 1) crossDiff += (phase0[i] - phase1[i]) ** 2
    crossDiff = Math.sqrt(crossDiff / q)
    expect(crossDiff).toBeGreaterThan(0.01)

    // ...but a full LFO period later the same phase window roughly repeats.
    const repeat = winA(base + period)
    let repeatDiff = 0
    for (let i = 0; i < q; i += 1) repeatDiff += (phase0[i] - repeat[i]) ** 2
    repeatDiff = Math.sqrt(repeatDiff / q)
    expect(repeatDiff).toBeLessThan(crossDiff)
  })

  it('depth 0 leaves a steady input essentially unmodulated', () => {
    const dryWow = new Wow(SR)
    dryWow.setParams({ rate: 5, depth: 0 })
    const { left, dry } = runSine(dryWow, 24000, 220)
    // With no modulation the output is just the dry signal delayed by the
    // fixed base delay; its deviation from dry stays tiny relative to a
    // depth>0 run.
    const deviation = rmsDiff(left, dry, 8000, 24000)

    const wetWow = new Wow(SR)
    wetWow.setParams({ rate: 5, depth: 0.9 })
    const wet = runSine(wetWow, 24000, 220)
    const wetDeviation = rmsDiff(wet.left, wet.dry, 8000, 24000)

    expect(deviation).toBeLessThan(wetDeviation)
  })

  it('rate 0 (no LFO motion) leaves a steady input essentially unmodulated', () => {
    const wow = new Wow(SR)
    wow.setParams({ rate: 0, depth: 0.9 })
    const { left, dry } = runSine(wow, 24000, 220)
    const deviation = rmsDiff(left, dry, 8000, 24000)

    const wetWow = new Wow(SR)
    wetWow.setParams({ rate: 5, depth: 0.9 })
    const wet = runSine(wetWow, 24000, 220)
    const wetDeviation = rmsDiff(wet.left, wet.dry, 8000, 24000)

    expect(deviation).toBeLessThan(wetDeviation)
  })

  it('preserves signal energy (the wet output is not silent)', () => {
    const wow = new Wow(SR)
    wow.setParams({ rate: 3, depth: 0.7 })
    const { left } = runSine(wow, 16000, 220)
    expect(rms(left, 4000, 16000)).toBeGreaterThan(0.1)
  })

  it('applies a slight L/R LFO phase offset for stereo motion', () => {
    const wow = new Wow(SR)
    wow.setParams({ rate: 5, depth: 0.9 })
    const { left, right } = runSine(wow, 24000, 220)
    // The two channels are modulated by phase-shifted LFOs, so they
    // decorrelate over the run rather than tracking identically.
    const channelDiff = rmsDiff(left, right, 8000, 24000)
    expect(channelDiff).toBeGreaterThan(0)
  })

  it('reset() clears state so the same input reproduces output', () => {
    const wow = new Wow(SR)
    wow.setParams({ rate: 4, depth: 0.8 })
    const first = runSine(wow, 8000, 220)
    wow.reset()
    const second = runSine(wow, 8000, 220)
    for (let i = 0; i < first.left.length; i += 1) {
      expect(second.left[i]).toBe(first.left[i])
      expect(second.right[i]).toBe(first.right[i])
    }
  })

  it('is deterministic: same input and params produce identical output', () => {
    const a = new Wow(SR)
    a.setParams({ rate: 3.5, depth: 0.6 })
    const b = new Wow(SR)
    b.setParams({ rate: 3.5, depth: 0.6 })
    const w = (2 * Math.PI * 220) / SR
    for (let i = 0; i < 5000; i += 1) {
      const x = Math.sin(i * w) * 0.5
      const [al, ar] = a.process(x, x)
      const [bl, br] = b.process(x, x)
      expect(bl).toBe(al)
      expect(br).toBe(ar)
    }
  })

  it('processInto writes into the supplied buffer without allocating a tuple', () => {
    const wow = new Wow(SR)
    wow.setParams({ rate: 2, depth: 0.5 })
    const out = new Float64Array(2)
    wow.processInto(0.5, -0.5, out)
    expect(Number.isFinite(out[0])).toBe(true)
    expect(Number.isFinite(out[1])).toBe(true)
  })
})
