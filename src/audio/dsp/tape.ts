// Stereo TAPE saturation FX. Pure, deterministic, DOM-free — operates on
// plain numbers so it can be unit tested and dropped into an AudioWorklet.
// No AudioContext, no Date.now / Math.random.
//
// Mirrors the feel of mdrone's TAPE insert (FxChain.wireTape): a soft
// saturation/compression stage followed by a gentle tone tilt. There the
// tilt is a high-shelf cut that rolls off the top; here we get the same
// "darker vs. open" character with a one-pole lowpass blended against the
// dry signal, so the module stays self-contained and worklet-cheap.
//
// Building blocks are reused from effects.ts:
//   - softClipDrive: the tanh-based saturator (drive 0 ~unity for small
//     signals, higher drive compresses large inputs harder).
//   - OnePole: the tone-tilt lowpass, one instance per channel so the
//     stereo filter state stays independent (no cross-channel bleed).

import { OnePole, softClipDrive } from './effects'

export interface TapeParams {
  /** Saturation amount, 0..1 (clamped). 0 ~unity for small signals. */
  drive: number
  /** Tone tilt, 0..1 (clamped). 0 = darker (more low-pass), 1 = open/bright. */
  tone: number
}

// Tone maps to a normalized one-pole cutoff. Even at tone 1 we keep the
// cutoff just below 1 so the filter is well-defined; the dry/wet blend
// (below) is what actually makes tone 1 transparent.
const MIN_CUTOFF = 0.02
const MAX_CUTOFF = 0.99

// Default until setParams is called: near-transparent (no drive, open tone).
const DEFAULT_PARAMS: TapeParams = { drive: 0, tone: 1 }

export class Tape {
  private readonly lpL = new OnePole()
  private readonly lpR = new OnePole()
  private drive = 0
  // Tilt blend: 0 = fully lowpassed (dark), 1 = fully dry (open).
  private toneMix = 1
  // Reused output for the allocation-free processInto path (audio-thread
  // safe). `process` returns a fresh tuple instead, for test convenience —
  // mirrors reverb.ts exactly.
  private readonly scratch = new Float64Array(2)

  // sampleRate is stored for API symmetry with the other DSP classes
  // (Reverb scales its delay lengths by it); the one-pole tilt already
  // works in normalized frequency, so nothing here depends on the rate.
  constructor(readonly sampleRate: number) {
    this.setParams(DEFAULT_PARAMS)
  }

  setParams({ drive, tone }: TapeParams): void {
    this.drive = clamp01(drive)
    const clampedTone = clamp01(tone)

    // Cutoff rises with tone so a brighter setting lets more highs pass
    // before the blend; bounded in (0, 1) so OnePole stays stable.
    const cutoff = MIN_CUTOFF + clampedTone * (MAX_CUTOFF - MIN_CUTOFF)
    this.lpL.setCutoff(cutoff, 'lowpass')
    this.lpR.setCutoff(cutoff, 'lowpass')

    // Blend toward dry as tone opens up. tone 1 => fully dry (transparent
    // tilt, so drive 0 + tone 1 is near-unity); tone 0 => fully lowpassed
    // (darkest). The cutoff sweep and the blend reinforce each other so the
    // HF rolloff is monotonic across the whole tone range.
    this.toneMix = clampedTone
  }

  /**
   * Process one stereo sample pair into `out` ([left, right]) with no
   * allocation — the per-channel OnePole filters carry their own state, so
   * this is safe to call per sample on the audio thread.
   */
  processInto(left: number, right: number, out: Float64Array): void {
    out[0] = this.processChannel(left, this.lpL)
    out[1] = this.processChannel(right, this.lpR)
  }

  /** Convenience wrapper returning a fresh [left, right] tuple (used in tests). */
  process(left: number, right: number): [number, number] {
    this.processInto(left, right, this.scratch)
    return [this.scratch[0], this.scratch[1]]
  }

  reset(): void {
    this.lpL.reset()
    this.lpR.reset()
  }

  private processChannel(sample: number, filter: OnePole): number {
    const input = Number.isFinite(sample) ? sample : 0
    // Saturate first (tape head non-linearity), then tilt the tone. tanh
    // keeps the output bounded near [-1, 1]; the dry/wet tilt blend is a
    // convex combination of two bounded signals, so it can't exceed that.
    const saturated = softClipDrive(input, this.drive)
    const dark = filter.process(saturated)
    return dark + (saturated - dark) * this.toneMix
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}
