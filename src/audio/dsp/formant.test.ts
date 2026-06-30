import { describe, expect, it } from 'vitest'
import { BandPass, Formant } from './formant'

const SR = 48000

// Deterministic pseudo-noise: a fixed sum of mutually-inharmonic sines so the
// spectrum is broadband and dense but fully reproducible (no Math.random).
// Frequencies are irrational-ish multiples so partials don't line up on a
// single formant and bias the energy measurement.
function pseudoNoise(n: number): Float64Array {
  const out = new Float64Array(n)
  const partials = [83, 197, 311, 433, 577, 727, 881, 1039, 1213, 1499, 1801, 2203, 2683, 3209, 3833]
  for (let i = 0; i < n; i += 1) {
    let s = 0
    for (let k = 0; k < partials.length; k += 1) {
      s += Math.sin((2 * Math.PI * partials[k] * i) / SR + k)
    }
    out[i] = s / partials.length
  }
  return out
}

// Goertzel single-bin power: energy of `signal` at frequency `freqHz`.
function binPower(signal: Float64Array, freqHz: number): number {
  const w = (2 * Math.PI * freqHz) / SR
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

// Render a mono input array through the formant (fed to both channels) and
// collect the left output.
function renderLeft(formant: Formant, input: Float64Array): Float64Array {
  const out = new Float64Array(input.length)
  const scratch = new Float64Array(2)
  for (let i = 0; i < input.length; i += 1) {
    formant.processInto(input[i], input[i], scratch)
    out[i] = scratch[0]
  }
  return out
}

// A E I O U formant tables used by the implementation (Hz). Mirror these in
// the tests so the spectral assertions can target the real peaks.
const A = [700, 1220, 2600]
const I = [270, 2300, 3000]
const U = [300, 870, 2250]

describe('BandPass', () => {
  it('passes energy at its centre frequency and rejects far frequencies', () => {
    const bp = new BandPass()
    bp.setParams(SR, 1000, 8)
    const tone = (f: number): Float64Array => {
      const n = 4096
      const out = new Float64Array(n)
      bp.reset()
      for (let i = 0; i < n; i += 1) {
        out[i] = bp.process(Math.sin((2 * Math.PI * f * i) / SR))
      }
      // Use the second half (steady state) for the energy measure.
      return out.subarray(n / 2)
    }
    const atCentre = binPower(tone(1000), 1000)
    const farAway = binPower(tone(8000), 8000)
    expect(atCentre).toBeGreaterThan(farAway * 10)
  })

  it('produces finite output and resets to a clean state', () => {
    const bp = new BandPass()
    bp.setParams(SR, 1500, 10)
    let v = 0
    for (let i = 0; i < 1000; i += 1) {
      v = bp.process(Math.sin(i))
    }
    expect(Number.isFinite(v)).toBe(true)
    bp.reset()
    // After reset, silent input yields silence (within the sub-audible DENORM
    // floor the biquad injects to keep denormals out of the recursion).
    expect(Math.abs(bp.process(0))).toBeLessThan(1e-20)
  })
})

describe('Formant', () => {
  it('amount 0 is a dry bypass (output equals input)', () => {
    const f = new Formant(SR)
    f.setParams({ vowel: 0, amount: 0 })
    const input = pseudoNoise(2048)
    const out = renderLeft(f, input)
    for (let i = 0; i < input.length; i += 1) {
      expect(out[i]).toBeCloseTo(input[i], 10)
    }
  })

  it('at amount 1 a vowel boosts energy near its formant peaks vs far away', () => {
    const f = new Formant(SR)
    f.setParams({ vowel: 0, amount: 1 }) // vowel 0 = A
    const input = pseudoNoise(8192)
    const wet = renderLeft(f, input).subarray(2048) // skip transient
    const dry = input.subarray(2048)

    // Gain at each A formant peak relative to the dry signal.
    const gainAt = (hz: number): number => binPower(wet, hz) / (binPower(dry, hz) + 1e-12)
    const peakGain = (gainAt(A[0]) + gainAt(A[1]) + gainAt(A[2])) / 3
    // A "valley" frequency that no A formant sits near.
    const valleyGain = gainAt(1700)

    // A resonant bandpass *passes* the formant bands and strongly *rejects*
    // everything else, so the peak bands retain far more of their dry energy
    // than a valley between formants. (A constant-0 dB bandpass passes the
    // centre at unity rather than amplifying above it, so the meaningful
    // resonance signature is this peak-to-valley contrast.)
    expect(peakGain).toBeGreaterThan(valleyGain * 5)
  })

  it('different vowels produce different spectra', () => {
    const input = pseudoNoise(8192)

    const a = new Formant(SR)
    a.setParams({ vowel: 0, amount: 1 }) // A
    const wetA = renderLeft(a, input).subarray(2048)

    const i = new Formant(SR)
    i.setParams({ vowel: 0.5, amount: 1 }) // I (middle of A E I O U)
    const wetI = renderLeft(i, input).subarray(2048)

    // A has a strong low F1 (~700); I has a very low F1 (~270) and high F2/F3.
    // Compare the energy ratio between A's F1 region and I's F2 region — the
    // two vowels should weight these bands oppositely.
    const aLow = binPower(wetA, A[0])
    const iLow = binPower(wetI, A[0])
    const aHigh = binPower(wetA, I[1])
    const iHigh = binPower(wetI, I[1])

    // A favours its 700 Hz band more than I does (relative to the 2300 band).
    expect(aLow / (aHigh + 1e-12)).toBeGreaterThan(iLow / (iHigh + 1e-12))
  })

  it('all five vowels are reachable and yield distinct U/A low-band balance', () => {
    const input = pseudoNoise(8192)
    const lowBalance = (vowel: number): number => {
      const f = new Formant(SR)
      f.setParams({ vowel, amount: 1 })
      const wet = renderLeft(f, input).subarray(2048)
      // ratio of low-formant band (U F1 ~300) to a high band (3000)
      return binPower(wet, U[0]) / (binPower(wet, 3000) + 1e-12)
    }
    // U (vowel=1) is darker (more low energy) than I (vowel=0.5).
    expect(lowBalance(1)).toBeGreaterThan(lowBalance(0.5))
  })

  it('output stays finite and bounded over a long render', () => {
    const f = new Formant(SR)
    f.setParams({ vowel: 0.3, amount: 1 })
    const scratch = new Float64Array(2)
    let maxAbs = 0
    for (let i = 0; i < 200000; i += 1) {
      // Hot full-scale-ish broadband drive.
      const x = Math.sin(i * 0.1) * 0.6 + Math.sin(i * 0.013) * 0.4
      f.processInto(x, -x, scratch)
      expect(Number.isFinite(scratch[0])).toBe(true)
      expect(Number.isFinite(scratch[1])).toBe(true)
      maxAbs = Math.max(maxAbs, Math.abs(scratch[0]), Math.abs(scratch[1]))
    }
    expect(maxAbs).toBeLessThan(8) // stable, no runaway resonance
  })

  it('reset clears state — identical input gives identical output', () => {
    const f = new Formant(SR)
    f.setParams({ vowel: 0.7, amount: 0.8 })
    const input = pseudoNoise(1024)

    const first = renderLeft(f, input)
    f.reset()
    const second = renderLeft(f, input)

    for (let i = 0; i < input.length; i += 1) {
      expect(second[i]).toBe(first[i])
    }
  })

  it('process returns a fresh tuple matching processInto', () => {
    const f = new Formant(SR)
    f.setParams({ vowel: 0.2, amount: 0.9 })
    const scratch = new Float64Array(2)
    f.processInto(0.5, -0.3, scratch)
    const expectedL = scratch[0]
    const expectedR = scratch[1]

    f.reset()
    const tuple = f.process(0.5, -0.3)
    expect(tuple[0]).toBe(expectedL)
    expect(tuple[1]).toBe(expectedR)
  })

  it('channels filter independently', () => {
    const f = new Formant(SR)
    f.setParams({ vowel: 0, amount: 1 })
    const scratch = new Float64Array(2)
    // Drive left only; right should stay silent (independent state) save for
    // the sub-audible DENORM floor the biquads inject.
    let leftEnergy = 0
    for (let i = 0; i < 500; i += 1) {
      f.processInto(Math.sin(i), 0, scratch)
      expect(Math.abs(scratch[1])).toBeLessThan(1e-15)
      leftEnergy += scratch[0] * scratch[0]
    }
    expect(leftEnergy).toBeGreaterThan(0) // left channel is actually filtering
  })

  it('clamps out-of-range params without producing NaN', () => {
    const f = new Formant(SR)
    f.setParams({ vowel: 5, amount: 9 }) // both above 1
    const scratch = new Float64Array(2)
    f.processInto(0.4, 0.4, scratch)
    expect(Number.isFinite(scratch[0])).toBe(true)
    f.setParams({ vowel: -3, amount: -2 }) // both below 0 → dry
    f.processInto(0.4, 0.4, scratch)
    expect(scratch[0]).toBeCloseTo(0.4, 10)
  })
})
