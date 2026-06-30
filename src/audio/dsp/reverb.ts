// Freeverb-style stereo reverb. Pure, deterministic, DOM-free — operates on
// plain numbers so it can be unit tested and dropped into an AudioWorklet.
// No AudioContext, no Date.now / Math.random.
//
// Topology (Jezar's classic Freeverb, mirrored from the comb-bank approach
// mdrone's HALL/CISTERN later replaced with a Jot FDN):
//   per channel: 8 parallel lowpass-feedback comb filters summed,
//                then 4 series allpass filters smear the result.
// The right channel's delay lengths are offset by a fixed stereo spread so
// the two channels decorrelate. `width` cross-mixes the two channels at the
// output for a narrow..wide stereo image.
//
// Stability/idioms borrowed from mdrone's FdnReverbProcessor:
//   - one-pole damping LP in each comb feedback path
//   - a sub-audible DENORM floor so denormals can't park in the feedback
//   - NaN/finite sanitation of state on reset
//   - IN/OUT loudness trims to keep the wet level sane

// Freeverb's tunings are specified at 44.1 kHz; scale to the real rate.
const FREEVERB_SR = 44100

// 8 comb delay lengths (samples @ 44.1 kHz), Jezar's original tuning.
const COMB_TUNING = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617]
// 4 allpass delay lengths (samples @ 44.1 kHz).
const ALLPASS_TUNING = [556, 441, 341, 225]
// Right channel offset so L/R combs/allpasses don't share modal series.
const STEREO_SPREAD = 23
// Fixed allpass feedback coefficient (Freeverb uses 0.5).
const ALLPASS_FEEDBACK = 0.5

// Map the `size` param (0..1) to comb feedback. Freeverb uses
// roomsize * scaleRoom + offsetRoom = roomsize * 0.28 + 0.7, so feedback
// runs ~0.70..0.98 — long but strictly < 1, hence stable and decaying.
const SCALE_ROOM = 0.28
const OFFSET_ROOM = 0.7

// `damp` 0..1 maps to the comb LP coefficient via scaleDamp (Freeverb 0.4).
const SCALE_DAMP = 0.4

// Input attenuation (Freeverb's fixedGain) keeps the dense comb sum bounded;
// output trim brings the wet signal to a sane operating level.
const FIXED_GAIN = 0.015
const OUT_GAIN = 1.0

// Sub-audible floor injected into feedback paths so denormals can't park and
// burn CPU. Matches mdrone's FDN DENORM.
const DENORM = 1e-25

/**
 * Lowpass-feedback comb filter: a delay line whose feedback is rolled off by
 * a one-pole lowpass. `damp` controls how much high frequency is lost on each
 * pass (more damp => darker, shorter HF tail); `feedback` (< 1) sets decay.
 */
class CombFilter {
  private readonly buffer: Float32Array
  private readonly size: number
  private index = 0
  private filterStore = 0
  private feedback = 0
  private damp1 = 0
  private damp2 = 1

  constructor(sizeSamples: number) {
    this.size = Math.max(1, Math.floor(sizeSamples))
    this.buffer = new Float32Array(this.size)
  }

  setFeedback(value: number): void {
    this.feedback = value
  }

  setDamp(value: number): void {
    // damp1 is the LP coefficient; damp2 = 1 - damp1 is the through-gain.
    this.damp1 = value
    this.damp2 = 1 - value
  }

  process(input: number): number {
    const output = this.buffer[this.index]
    // One-pole lowpass on the feedback path (the damping filter).
    this.filterStore = output * this.damp2 + this.filterStore * this.damp1 + DENORM
    this.buffer[this.index] = input + this.filterStore * this.feedback
    this.index += 1
    if (this.index >= this.size) {
      this.index = 0
    }
    return output
  }

  reset(): void {
    this.buffer.fill(0)
    this.filterStore = 0
    this.index = 0
  }
}

/**
 * Schroeder allpass filter as used in Freeverb. Diffuses without coloring the
 * magnitude response; the fixed feedback keeps it stable.
 */
class AllpassFilter {
  private readonly buffer: Float32Array
  private readonly size: number
  private index = 0
  private feedback = ALLPASS_FEEDBACK

  constructor(sizeSamples: number) {
    this.size = Math.max(1, Math.floor(sizeSamples))
    this.buffer = new Float32Array(this.size)
  }

  process(input: number): number {
    const bufout = this.buffer[this.index]
    const output = -input + bufout
    this.buffer[this.index] = input + bufout * this.feedback + DENORM
    this.index += 1
    if (this.index >= this.size) {
      this.index = 0
    }
    return output
  }

  reset(): void {
    this.buffer.fill(0)
    this.index = 0
  }
}

interface ReverbParams {
  /** Room size / decay length, 0..1. Larger => longer tail. */
  size: number
  /** High-frequency damping in the feedback, 0..1. Larger => darker tail. */
  damp: number
  /** Stereo spread, 0..1. 0 => mono-summed, 1 => fully decorrelated L/R. */
  width: number
}

export class Reverb {
  private readonly combsL: CombFilter[]
  private readonly combsR: CombFilter[]
  private readonly allpassesL: AllpassFilter[]
  private readonly allpassesR: AllpassFilter[]
  private wet1 = 1
  private wet2 = 0

  constructor(sampleRate: number) {
    const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : FREEVERB_SR
    const scale = sr / FREEVERB_SR

    this.combsL = COMB_TUNING.map((t) => new CombFilter(Math.round(t * scale)))
    this.combsR = COMB_TUNING.map((t) => new CombFilter(Math.round((t + STEREO_SPREAD) * scale)))
    this.allpassesL = ALLPASS_TUNING.map((t) => new AllpassFilter(Math.round(t * scale)))
    this.allpassesR = ALLPASS_TUNING.map(
      (t) => new AllpassFilter(Math.round((t + STEREO_SPREAD) * scale)),
    )

    // Sensible defaults until setParams is called.
    this.setParams({ size: 0.5, damp: 0.5, width: 1 })
  }

  setParams({ size, damp, width }: ReverbParams): void {
    const clampedSize = clamp01(size)
    const clampedDamp = clamp01(damp)
    const clampedWidth = clamp01(width)

    const feedback = clampedSize * SCALE_ROOM + OFFSET_ROOM
    const dampCoef = clampedDamp * SCALE_DAMP
    for (let i = 0; i < this.combsL.length; i += 1) {
      this.combsL[i].setFeedback(feedback)
      this.combsL[i].setDamp(dampCoef)
      this.combsR[i].setFeedback(feedback)
      this.combsR[i].setDamp(dampCoef)
    }

    // Width cross-mixes the two channels at the output. width 1 => fully
    // separate L/R (wet1=1, wet2=0); width 0 => identical mono sum.
    this.wet1 = clampedWidth * 0.5 + 0.5
    this.wet2 = (1 - clampedWidth) * 0.5
  }

  /**
   * Process one stereo sample pair. Returns a fresh 2-tuple [left, right].
   * The hot work happens in the comb/allpass filters which reuse their
   * preallocated buffers; only this tiny tuple is allocated per call.
   */
  process(left: number, right: number): [number, number] {
    const inL = Number.isFinite(left) ? left : 0
    const inR = Number.isFinite(right) ? right : 0
    // Mono fold-down scaled by fixedGain, like Freeverb's input stage.
    const input = (inL + inR) * FIXED_GAIN

    let outL = 0
    let outR = 0
    // Parallel comb bank — accumulate in parallel for each channel.
    for (let i = 0; i < this.combsL.length; i += 1) {
      outL += this.combsL[i].process(input)
      outR += this.combsR[i].process(input)
    }
    // Series allpass diffusers.
    for (let i = 0; i < this.allpassesL.length; i += 1) {
      outL = this.allpassesL[i].process(outL)
      outR = this.allpassesR[i].process(outR)
    }

    // Stereo width cross-mix.
    const wetL = outL * this.wet1 + outR * this.wet2
    const wetR = outR * this.wet1 + outL * this.wet2
    return [wetL * OUT_GAIN, wetR * OUT_GAIN]
  }

  reset(): void {
    for (let i = 0; i < this.combsL.length; i += 1) {
      this.combsL[i].reset()
      this.combsR[i].reset()
    }
    for (let i = 0; i < this.allpassesL.length; i += 1) {
      this.allpassesL[i].reset()
      this.allpassesR[i].reset()
    }
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}
