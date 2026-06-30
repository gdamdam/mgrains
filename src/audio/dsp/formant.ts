// Stereo vocal FORMANT filter. Pure, deterministic, DOM-free — operates on
// plain numbers so it can be unit tested and dropped into an AudioWorklet.
// No AudioContext, no Date.now / Math.random.
//
// Topology (mirrors mdrone's FORMANT effect — three parallel bandpasses at a
// vowel's F1/F2/F3, summed — but implemented as standalone RBJ biquads here
// rather than native BiquadFilterNodes so it is sample-accurate and testable):
//
//   per channel: input → [ BP(F1), BP(F2), BP(F3) ] summed → vowel colour
//   out = dry*(1-amount) + vowelSum*amount        (amount 0 = dry bypass)
//
// `vowel` (0..1) morphs across A E I O U; each is a triple of formant
// frequencies. `amount` (0..1) is the dry/wet mix.

// Vowel formant frequency triples (Hz), F1/F2/F3, in canonical A E I O U order.
// Values taken from mdrone's FxChain.VOWELS table (ah/eh/ee/oh/oo), reordered
// to spell A E I O U:
//   A = ah, E = eh, I = ee, O = oh, U = oo
const VOWELS: readonly (readonly [number, number, number])[] = [
  [700, 1220, 2600], // A (ah)
  [530, 1850, 2500], // E (eh)
  [270, 2300, 3000], // I (ee)
  [400, 800, 2600], // O (oh)
  [300, 870, 2250], // U (oo)
]

// Per-formant resonance (Q). F1 is widest, higher formants narrower — matches
// mdrone's Q ramp (8 / 10 / 12) so the vowel reads without the upper formants
// smearing into noise.
const FORMANT_Q: readonly [number, number, number] = [8, 10, 12]

// Per-formant amplitude weights — upper formants are rolled down so the vowel
// lands near unity overall (mirrors mdrone's 1.0 / 0.85 / 0.55 band gains).
const FORMANT_GAIN: readonly [number, number, number] = [1.0, 0.85, 0.55]

// Output trim on the summed vowel so a hot broadband input doesn't push the
// wet path far above the dry level.
const WET_TRIM = 1.0

// Sub-audible floor injected into the biquad state so denormals can't park in
// the recursion and burn CPU. Matches reverb.ts's DENORM idiom.
const DENORM = 1e-25

const FALLBACK_SR = 44100

/**
 * RBJ cookbook resonant bandpass biquad (constant 0 dB peak gain variant).
 * Direct-form I. `setParams` recomputes the coefficients; state persists so a
 * live parameter change doesn't reset the filter.
 */
export class BandPass {
  private b0 = 1
  private b1 = 0
  private b2 = 0
  private a1 = 0
  private a2 = 0
  // Direct-form I state.
  private x1 = 0
  private x2 = 0
  private y1 = 0
  private y2 = 0

  setParams(sampleRate: number, freqHz: number, q: number): void {
    const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : FALLBACK_SR
    // Keep the centre frequency safely inside (0, Nyquist) so the cosine/sine
    // stay well-conditioned.
    const nyquist = sr * 0.5
    const f = Math.min(Math.max(Number.isFinite(freqHz) ? freqHz : 1, 1), nyquist * 0.99)
    const qq = Number.isFinite(q) && q > 0 ? q : 0.5

    const w0 = (2 * Math.PI * f) / sr
    const cosw0 = Math.cos(w0)
    const sinw0 = Math.sin(w0)
    const alpha = sinw0 / (2 * qq)

    // RBJ bandpass, constant 0 dB peak gain (the "BPF (constant 0 dB)" form).
    const b0 = alpha
    const b1 = 0
    const b2 = -alpha
    const a0 = 1 + alpha
    const a1 = -2 * cosw0
    const a2 = 1 - alpha

    const inv = 1 / a0
    this.b0 = b0 * inv
    this.b1 = b1 * inv
    this.b2 = b2 * inv
    this.a1 = a1 * inv
    this.a2 = a2 * inv
  }

  process(x: number): number {
    const y =
      this.b0 * x +
      this.b1 * this.x1 +
      this.b2 * this.x2 -
      this.a1 * this.y1 -
      this.a2 * this.y2 +
      DENORM
    this.x2 = this.x1
    this.x1 = x
    this.y2 = this.y1
    this.y1 = y
    return y
  }

  reset(): void {
    this.x1 = 0
    this.x2 = 0
    this.y1 = 0
    this.y2 = 0
  }
}

export interface FormantParams {
  /** Vowel position 0..1, morphs across A E I O U (clamped). */
  vowel: number
  /** Dry/wet mix 0..1 — 0 is a dry bypass, 1 is fully wet (clamped). */
  amount: number
}

export class Formant {
  private readonly sampleRate: number
  // Three parallel bandpasses per channel, independent state.
  private readonly bpL: [BandPass, BandPass, BandPass]
  private readonly bpR: [BandPass, BandPass, BandPass]
  private amount = 0
  // Reused output for the allocation-free processInto path (audio-thread safe).
  private readonly scratch = new Float64Array(2)

  constructor(sampleRate: number) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : FALLBACK_SR
    this.bpL = [new BandPass(), new BandPass(), new BandPass()]
    this.bpR = [new BandPass(), new BandPass(), new BandPass()]
    // Sensible default until setParams is called: vowel A, dry.
    this.setParams({ vowel: 0, amount: 0 })
  }

  setParams({ vowel, amount }: FormantParams): void {
    this.amount = clamp01(amount)
    const v = clamp01(vowel)

    // Map v∈[0,1] onto the vowel table and linearly morph between the two
    // bracketing vowels so the colour glides rather than stepping.
    const pos = v * (VOWELS.length - 1)
    const lo = Math.floor(pos)
    const hi = Math.min(lo + 1, VOWELS.length - 1)
    const frac = pos - lo
    const a = VOWELS[lo]
    const b = VOWELS[hi]

    for (let i = 0; i < 3; i += 1) {
      const freq = a[i] + (b[i] - a[i]) * frac
      this.bpL[i].setParams(this.sampleRate, freq, FORMANT_Q[i])
      this.bpR[i].setParams(this.sampleRate, freq, FORMANT_Q[i])
    }
  }

  /**
   * Process one stereo sample pair into `out` ([left, right]) with no
   * allocation — safe to call per sample on the audio thread. Each channel
   * runs its own three-bandpass bank, summed and crossfaded against the dry.
   */
  processInto(left: number, right: number, out: Float64Array): void {
    const inL = Number.isFinite(left) ? left : 0
    const inR = Number.isFinite(right) ? right : 0

    // Dry bypass shortcut — also keeps the filter state cold so toggling the
    // effect on later starts from silence rather than a stale tail.
    if (this.amount <= 0) {
      out[0] = inL
      out[1] = inR
      return
    }

    let wetL = 0
    let wetR = 0
    for (let i = 0; i < 3; i += 1) {
      wetL += this.bpL[i].process(inL) * FORMANT_GAIN[i]
      wetR += this.bpR[i].process(inR) * FORMANT_GAIN[i]
    }
    wetL *= WET_TRIM
    wetR *= WET_TRIM

    const dryMix = 1 - this.amount
    out[0] = inL * dryMix + wetL * this.amount
    out[1] = inR * dryMix + wetR * this.amount
  }

  /** Convenience wrapper returning a fresh [left, right] tuple (used in tests). */
  process(left: number, right: number): [number, number] {
    this.processInto(left, right, this.scratch)
    return [this.scratch[0], this.scratch[1]]
  }

  reset(): void {
    for (let i = 0; i < 3; i += 1) {
      this.bpL[i].reset()
      this.bpR[i].reset()
    }
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}
