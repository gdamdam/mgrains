// Sub — deterministic, DOM-free stereo sub-bass enhancer. Pure numbers, no
// AudioContext, no Date.now / Math.random, so it unit-tests cleanly and drops
// straight into an AudioWorklet.
//
// Approach (mirrors mdrone's SUB in FxChain.ts / fxChainProcessor.js): the
// input is mono-summed and full-wave rectified into an envelope follower
// (one-pole with separate attack/release time constants). A low oscillator
// at `tune` Hz is scaled by that envelope to synthesise a sub tone that
// tracks the input's dynamics — louder input => louder sub, silence => the
// envelope releases and the sub fades out.
//
// ADDITIVE: processInto writes out = input + sub, with the SAME mono sub
// added to both channels (stereo input preserved, mono sub on top). The
// caller can dry/wet by scaling the added sub upstream.

// Sub oscillator frequency is clamped to the audible sub-bass band so a stray
// param can't park the oscillator at DC or up in the mids.
const TUNE_MIN = 30
const TUNE_MAX = 120

// Default oscillator frequency until setParams is called.
const DEFAULT_TUNE = 55

// Envelope follower time constants (seconds). A fast attack lets the sub
// bloom with the input transient; a slower release gives the sub-octave a
// natural decay tail (and is what makes the "decays to silence" test pass).
const ATTACK_SEC = 0.005
const RELEASE_SEC = 0.12

// Output trim — calibrate the synthesised sub level relative to the rectified
// input envelope. Matches the spirit of mdrone's subTrim (~0.6).
const SUB_TRIM = 0.6

// Sub-audible floor so denormals can't park in the envelope's one-pole state
// and burn CPU. Matches reverb.ts's DENORM idiom.
const DENORM = 1e-25

export interface SubParams {
  /** Sub oscillator frequency in Hz. Clamped to ~30..120 (sub-bass band). */
  tune: number
}

export class Sub {
  private readonly sampleRate: number
  // Oscillator phase increment per sample (radians), derived from `tune`.
  private phaseInc: number
  private phase = 0
  // Envelope follower state (smoothed rectified input level).
  private env = 0
  // One-pole coefficients for the attack/release smoothing.
  private readonly attackCoef: number
  private readonly releaseCoef: number
  // Reused output for the allocation-free process() wrapper (audio-thread safe).
  private readonly scratch = new Float64Array(2)

  constructor(sampleRate: number) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000
    // exp(-1 / (tau * sr)) — standard one-pole smoothing coefficient.
    this.attackCoef = Math.exp(-1 / (ATTACK_SEC * this.sampleRate))
    this.releaseCoef = Math.exp(-1 / (RELEASE_SEC * this.sampleRate))
    this.phaseInc = (2 * Math.PI * DEFAULT_TUNE) / this.sampleRate
  }

  setParams({ tune }: SubParams): void {
    const clamped = clampTune(tune)
    this.phaseInc = (2 * Math.PI * clamped) / this.sampleRate
  }

  /**
   * Process one stereo sample pair into `out` ([left, right]) with no
   * allocation. Writes out = input + sub, with the same mono sub added to
   * both channels. Safe to call per sample on the audio thread.
   */
  processInto(left: number, right: number, out: Float64Array): void {
    const inL = Number.isFinite(left) ? left : 0
    const inR = Number.isFinite(right) ? right : 0

    // Mono-sum the input and full-wave rectify for the envelope follower.
    const mono = (inL + inR) * 0.5
    const level = Math.abs(mono)

    // One-pole envelope with attack/release: rise fast, fall slow.
    const coef = level > this.env ? this.attackCoef : this.releaseCoef
    this.env = level + (this.env - level) * coef + DENORM

    // Sine oscillator at `tune`, amplitude-modulated by the envelope.
    const sub = Math.sin(this.phase) * this.env * SUB_TRIM
    this.phase += this.phaseInc
    if (this.phase >= 2 * Math.PI) {
      this.phase -= 2 * Math.PI
    }

    // Additive: same mono sub onto both channels, stereo input preserved.
    out[0] = inL + sub
    out[1] = inR + sub
  }

  /** Convenience wrapper returning a fresh [left, right] tuple (used in tests). */
  process(left: number, right: number): [number, number] {
    this.processInto(left, right, this.scratch)
    return [this.scratch[0], this.scratch[1]]
  }

  reset(): void {
    this.phase = 0
    this.env = 0
  }
}

function clampTune(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TUNE
  return Math.min(TUNE_MAX, Math.max(TUNE_MIN, value))
}
