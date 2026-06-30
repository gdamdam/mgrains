// Stereo ring modulator. Pure, deterministic, DOM-free — operates on plain
// numbers so it can be unit tested and dropped into an AudioWorklet. No
// AudioContext, no Date.now / Math.random.
//
// Mirrors mdrone's RINGMOD (a GainNode whose .gain is driven by a zero-offset
// audio-rate oscillator, i.e. signal × sin(2π f t)) but runs the carrier
// inline so the whole effect is a single self-contained class with the same
// class/processInto idiom as reverb.ts.
//
// Both channels share ONE sine carrier so L/R stay phase-coherent; the wet
// path multiplies each channel by that carrier and the output crossfades
// dry↔wet by `amount`. Since |sin| <= 1 and the mix is convex, the output
// magnitude never exceeds the input magnitude.

const TWO_PI = Math.PI * 2

// Carrier frequency clamp. Below ~1 Hz the modulation is sub-audible/DC-ish;
// above 4 kHz the inharmonic sidebands get harsh and alias-prone, matching
// the musical range mdrone's industrial RINGMOD targets.
const MIN_FREQ = 1
const MAX_FREQ = 4000

export interface RingModParams {
  /** Carrier frequency in Hz. Clamped to [1, 4000]. */
  frequency: number
  /** Dry/wet mix, 0..1. 0 = dry bypass, 1 = fully ring-modulated. */
  amount: number
}

export class RingMod {
  private readonly sampleRate: number
  // Per-sample phase increment in radians for the shared sine carrier.
  private phaseInc = 0
  // Current carrier phase in radians. Advanced AFTER each sample so the very
  // first sample multiplies by sin(0); sample n uses sin(2π f n / sr).
  private phase = 0
  private amount = 0
  // Reused output for the allocation-free process() path (audio-thread safe).
  private readonly scratch = new Float64Array(2)

  constructor(sampleRate: number) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100
    this.setParams({ frequency: 440, amount: 0 })
  }

  setParams({ frequency, amount }: RingModParams): void {
    const f = clamp(frequency, MIN_FREQ, MAX_FREQ)
    this.phaseInc = (TWO_PI * f) / this.sampleRate
    this.amount = clamp(amount, 0, 1)
  }

  /**
   * Process one stereo sample pair into `out` ([left, right]) with no
   * allocation, so it is safe to call per sample on the audio thread.
   */
  processInto(left: number, right: number, out: Float64Array): void {
    const inL = Number.isFinite(left) ? left : 0
    const inR = Number.isFinite(right) ? right : 0
    const carrier = Math.sin(this.phase)
    const dry = 1 - this.amount
    out[0] = inL * dry + inL * carrier * this.amount
    out[1] = inR * dry + inR * carrier * this.amount
    // Advance and wrap the phase to keep it bounded over long runs.
    this.phase += this.phaseInc
    if (this.phase >= TWO_PI) this.phase -= TWO_PI
  }

  /** Convenience wrapper returning a fresh [left, right] tuple (used in tests). */
  process(left: number, right: number): [number, number] {
    this.processInto(left, right, this.scratch)
    return [this.scratch[0], this.scratch[1]]
  }

  reset(): void {
    this.phase = 0
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}
