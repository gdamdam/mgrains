// Tuned resonant comb FX, mirrored from mdrone's COMB insert (a DelayNode with
// a feedback gain and a feedback-path lowpass — see mdrone wireComb()). Pure,
// deterministic, DOM-free: it operates on plain numbers so it can be unit
// tested and dropped straight into an AudioWorklet. No AudioContext, no
// Date.now / Math.random.
//
// Topology (per channel): a feedback comb whose delay length is set from the
// tuning frequency (delay = sampleRate / frequency). The delayed signal is
// rolled off by a gentle one-pole lowpass before being scaled by the feedback
// gain and summed back into the line — the damping keeps higher harmonics from
// piling up on the comb's resonance peaks at 2x, 3x, ... the fundamental. The
// comb therefore rings at `frequency` and its harmonics and decays for any
// feedback < 1.

import { DelayLine, OnePole } from './effects'

export interface CombParams {
  /** Tuning frequency in Hz. Sets the comb delay = sampleRate / frequency. */
  frequency: number
  /** Feedback amount 0..0.95. Higher => longer ring. Clamped < 1 for stability. */
  resonance: number
}

// Frequency clamp. The low bound caps the delay length (and thus the buffer
// size); the high bound keeps the period at least a couple of samples long.
const MIN_FREQ = 20
const MAX_FREQ = 4000

// Resonance is clamped strictly below 1 so the feedback loop always decays.
// 0.95 matches the documented upper bound of the param range.
const MAX_RESONANCE = 0.95

// Normalized cutoff for the feedback-path damping lowpass. Mirrors mdrone's
// ~3 kHz feedback lowpass in spirit: gentle HF roll-off per pass so the comb
// stays musical instead of accumulating bright energy on every harmonic peak.
// OnePole.setCutoff expects a normalized 0..1 value; 0.3 is a soft roll-off.
const DAMP_CUTOFF = 0.3

// Sub-audible floor injected into the feedback path so denormals can't park in
// the loop and burn CPU. Matches the DENORM idiom used in reverb.ts.
const DENORM = 1e-25

// Retuning while the line rings would jump the read tap to a different point
// in the ring buffer — an audible step. Crossfade old→new tap over 5 ms
// instead (same idiom as tempoDelay.ts).
const RETUNE_XFADE_SECONDS = 0.005
const HALF_PI = Math.PI / 2

/**
 * One tuned feedback comb channel: a delay line with a one-pole lowpass in the
 * feedback path. `setDelay` retunes the integer delay length; `setFeedback`
 * sets the (already-clamped) loop gain.
 */
class CombChannel {
  private readonly delay: DelayLine
  private readonly damp = new OnePole()
  private delaySamples: number
  private previousDelaySamples: number
  private readonly fadeLength: number
  private fadeRemaining = 0
  private feedback = 0
  // True once the line carries signal. A retune of a silent line snaps
  // instead of fading — fading there would ghost-echo the incoming signal
  // at the previous period for 5 ms.
  private lineLive = false

  constructor(maxDelaySamples: number, fadeLength: number) {
    this.delay = new DelayLine(maxDelaySamples)
    this.delaySamples = maxDelaySamples
    this.previousDelaySamples = maxDelaySamples
    this.fadeLength = Math.max(1, fadeLength)
    this.damp.setCutoff(DAMP_CUTOFF, 'lowpass')
  }

  setDelay(samples: number): void {
    if (samples === this.delaySamples) return
    this.previousDelaySamples = this.delaySamples
    this.delaySamples = samples
    this.fadeRemaining = this.lineLive ? this.fadeLength : 0
  }

  setFeedback(value: number): void {
    this.feedback = value
  }

  process(input: number): number {
    // Read the sample one period ago, damp it, scale by feedback, sum back in.
    let delayed = this.delay.read(this.delaySamples)
    if (this.fadeRemaining > 0) {
      // Equal-power crossfade from the old tap so retunes never step.
      const t = this.fadeRemaining / this.fadeLength
      delayed = this.delay.read(this.previousDelaySamples) * Math.sin(t * HALF_PI)
        + delayed * Math.cos(t * HALF_PI)
      this.fadeRemaining -= 1
    }
    const damped = this.damp.process(delayed)
    const output = input + damped * this.feedback + DENORM
    if (this.lineLive === false && Math.abs(output) > 1e-12) this.lineLive = true
    this.delay.write(output)
    return output
  }

  reset(): void {
    this.delay.reset()
    this.damp.reset()
    this.fadeRemaining = 0
    this.previousDelaySamples = this.delaySamples
    this.lineLive = false
  }
}

export class Comb {
  private readonly left: CombChannel
  private readonly right: CombChannel
  private readonly sampleRate: number
  // Reused output for the allocation-free processInto path (audio-thread safe).
  private readonly scratch = new Float64Array(2)

  constructor(sampleRate: number) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000
    // The longest possible delay (at MIN_FREQ) sizes the ring buffer once, so
    // retuning never reallocates. +1 guards the read tap.
    const maxDelay = Math.ceil(this.sampleRate / MIN_FREQ) + 1
    const fadeLength = Math.round(this.sampleRate * RETUNE_XFADE_SECONDS)
    this.left = new CombChannel(maxDelay, fadeLength)
    this.right = new CombChannel(maxDelay, fadeLength)
    // Sensible defaults until setParams is called.
    this.setParams({ frequency: 220, resonance: 0.5 })
  }

  setParams({ frequency, resonance }: CombParams): void {
    const freq = clamp(frequency, MIN_FREQ, MAX_FREQ)
    // Integer delay length sets the fundamental: longer delay => lower pitch.
    const delaySamples = Math.max(1, Math.round(this.sampleRate / freq))
    const feedback = clamp(resonance, 0, MAX_RESONANCE)

    this.left.setDelay(delaySamples)
    this.right.setDelay(delaySamples)
    this.left.setFeedback(feedback)
    this.right.setFeedback(feedback)
  }

  /**
   * Process one stereo sample pair into `out` ([left, right]) with no
   * allocation — the delay lines reuse their preallocated buffers, so this is
   * safe to call per sample on the audio thread.
   */
  processInto(left: number, right: number, out: Float64Array): void {
    const inL = Number.isFinite(left) ? left : 0
    const inR = Number.isFinite(right) ? right : 0
    out[0] = this.left.process(inL)
    out[1] = this.right.process(inR)
  }

  /** Convenience wrapper returning a fresh [left, right] tuple (used in tests). */
  process(left: number, right: number): [number, number] {
    this.processInto(left, right, this.scratch)
    return [this.scratch[0], this.scratch[1]]
  }

  reset(): void {
    this.left.reset()
    this.right.reset()
  }
}

function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo
  return Math.min(hi, Math.max(lo, value))
}
