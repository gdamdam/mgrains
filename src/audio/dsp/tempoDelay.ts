// Stereo tempo-synced feedback delay — the DSP behind the "Repeat" performance
// macro. Pure, deterministic and DOM-free so it can be unit tested and dropped
// into an AudioWorklet. It mirrors the feel of the mdrone DELAY insert: the
// feedback path runs through a low-pass (damping) and a soft saturator, so the
// repeats darken and gently compress as they recirculate rather than ringing
// harshly. Ping-pong cross-feed gives the stereo image its width.
//
// The musical-division math lives in the caller; this module takes the delay
// length in seconds directly. `divisionToSeconds` is offered as a convenience.

import { DelayLine, OnePole, softClipDrive } from './effects'

export interface TempoDelayParams {
  // Delay length in seconds. Clamped to the allocated buffer.
  timeSeconds: number
  // Feedback amount 0..0.95. Kept strictly below 1 so the loop always decays.
  feedback: number
  // 0 = bright (open feedback LPF), 1 = dark (heavily damped feedback).
  tone: number
  // 0 = mono/parallel repeats, 1 = full ping-pong cross-feed between channels.
  width: number
}

// Highest feedback we allow. Below 1 guarantees a geometric decay; leaving a
// little headroom (0.95) keeps the loop comfortably stable once the in-loop
// saturator and LPF are accounted for.
const MAX_FEEDBACK = 0.95

// Default maximum delay length. 2.5 s matches the mdrone delay's allocation and
// covers slow tempos / long divisions.
const DEFAULT_MAX_SECONDS = 2.5

// Drive for the in-loop soft saturation. Light, like a tape-style curve: it
// only bites once echoes pile up, adding a touch of compression that further
// helps stability without obviously distorting a single repeat.
const LOOP_DRIVE = 0.15
const LOOP_DRIVE_GAIN = 1 + LOOP_DRIVE * 9

const HALF_PI = Math.PI / 2

// Read-head crossfade length when the delay time changes. The wet tap is read by
// an integer sample index, so retuning the time (e.g. a BPM change while Repeat
// is engaged) jumps the read head and clicks. Equal-power-crossfading from the
// old tap to the new one over a few ms removes the step without smearing the
// echo. ~5 ms is short enough to stay imperceptible as a time glide.
const DELAY_XFADE_SECONDS = 0.005

/**
 * Convert a musical division (as a fraction of a whole note, e.g. 1/4 for a
 * quarter note) plus a tempo in BPM into a delay length in seconds. A whole
 * note spans four beats, so seconds = division * 4 * (60 / bpm).
 */
export function divisionToSeconds(division: number, bpm: number): number {
  if (!Number.isFinite(division) || !Number.isFinite(bpm) || bpm <= 0) return 0
  const safeDivision = Math.max(0, division)
  return safeDivision * 4 * (60 / bpm)
}

export class TempoDelay {
  private readonly sampleRate: number
  private readonly maxSamples: number
  private readonly left: DelayLine
  private readonly right: DelayLine
  // One feedback-damping low-pass per channel. Mirrors the mdrone fbFilter.
  private readonly toneLeft = new OnePole()
  private readonly toneRight = new OnePole()

  private delaySamples = 1
  // Tap we crossfade FROM while a time change settles, and how many samples of
  // crossfade remain. `warmed` gates the crossfade so a time set on a cold delay
  // line (construction / post-reset, buffer all zeros) just snaps — there is no
  // signal to click and this keeps a reset instance bit-identical to a fresh one.
  private previousDelaySamples = 1
  private fadeRemaining = 0
  private readonly fadeLength: number
  private warmed = false
  private feedback = 0
  private width = 0
  // Reused output for the allocation-free processInto path (audio-thread safe).
  private readonly scratch = new Float64Array(2)

  constructor(sampleRate: number, maxSeconds: number = DEFAULT_MAX_SECONDS) {
    this.sampleRate = sampleRate > 0 ? sampleRate : 48000
    const seconds = maxSeconds > 0 ? maxSeconds : DEFAULT_MAX_SECONDS
    // +1 so a delay of exactly maxSeconds has a valid tap to read.
    this.maxSamples = Math.max(2, Math.floor(seconds * this.sampleRate) + 1)
    this.fadeLength = Math.max(1, Math.round(DELAY_XFADE_SECONDS * this.sampleRate))
    this.left = new DelayLine(this.maxSamples)
    this.right = new DelayLine(this.maxSamples)
    // Default tone = bright.
    this.setParams({ timeSeconds: 0.5, feedback: 0, tone: 0, width: 0 })
  }

  setParams({ timeSeconds, feedback, tone, width }: TempoDelayParams): void {
    const safeTime = Number.isFinite(timeSeconds) ? Math.max(0, timeSeconds) : 0
    // Clamp the tap to the allocated buffer; at least 1 sample so an echo is
    // always audibly later than the input.
    const requested = Math.min(this.maxSamples - 1, Math.max(1, Math.round(safeTime * this.sampleRate)))
    // Once the line carries signal, retuning the time crossfades read heads
    // instead of jumping. A change mid-fade restarts from the current target.
    if (this.warmed && requested !== this.delaySamples) {
      this.previousDelaySamples = this.delaySamples
      this.fadeRemaining = this.fadeLength
    }
    this.delaySamples = requested

    const safeFeedback = Number.isFinite(feedback) ? feedback : 0
    this.feedback = Math.min(MAX_FEEDBACK, Math.max(0, safeFeedback))

    this.width = Number.isFinite(width) ? Math.min(1, Math.max(0, width)) : 0

    // Map tone 0..1 to the feedback LPF cutoff. tone 0 = wide open (bright),
    // tone 1 = strongly damped (dark). OnePole's normalized cutoff is in [0, 1],
    // so invert tone and floor it slightly to keep the loop from becoming a pure
    // integrator at the dark extreme.
    const safeTone = Number.isFinite(tone) ? Math.min(1, Math.max(0, tone)) : 0
    const cutoff = Math.max(0.02, 1 - safeTone)
    this.toneLeft.setCutoff(cutoff, 'lowpass')
    this.toneRight.setCutoff(cutoff, 'lowpass')
  }

  /**
   * Process one stereo sample pair into `out` ([left, right]) with no
   * allocation — DelayLine/OnePole reuse their buffers, so this is safe to call
   * per sample on the audio thread.
   */
  processInto(left: number, right: number, out: Float64Array): void {
    const inL = Number.isFinite(left) ? left : 0
    const inR = Number.isFinite(right) ? right : 0
    this.warmed = true

    // Read the delayed taps (the wet repeats). While a time change settles,
    // equal-power-crossfade from the old read head to the new one so the tap
    // jump never clicks.
    let delayedL = this.left.read(this.delaySamples)
    let delayedR = this.right.read(this.delaySamples)
    if (this.fadeRemaining > 0) {
      const oldL = this.left.read(this.previousDelaySamples)
      const oldR = this.right.read(this.previousDelaySamples)
      const t = this.fadeRemaining / this.fadeLength
      const gOld = Math.sin(t * HALF_PI)
      const gNew = Math.cos(t * HALF_PI)
      delayedL = delayedL * gNew + oldL * gOld
      delayedR = delayedR * gNew + oldR * gOld
      this.fadeRemaining -= 1
    }

    // Feedback path: damp (LPF) then soft-saturate, mirroring mdrone's
    // fbFilter → fbSat loop. Normalize by the saturator's small-signal gain so
    // feedback below 1 always decays instead of settling into self-oscillation.
    const fbL = softClipDrive(this.toneLeft.process(delayedL), LOOP_DRIVE) / LOOP_DRIVE_GAIN
    const fbR = softClipDrive(this.toneRight.process(delayedR), LOOP_DRIVE) / LOOP_DRIVE_GAIN

    // Ping-pong: at width 0 each channel feeds straight back into itself; at
    // width 1 the feedback crosses fully to the opposite channel, bouncing the
    // echoes between speakers. crossfeed blends the two.
    const cross = this.width
    const direct = 1 - cross
    this.left.write(inL + this.feedback * (fbL * direct + fbR * cross))
    this.right.write(inR + this.feedback * (fbR * direct + fbL * cross))

    // The wet output is the delayed tap (pre-feedback-mix), matching the
    // mdrone topology where the wet send taps the delay node directly.
    out[0] = delayedL
    out[1] = delayedR
  }

  /** Convenience wrapper returning a fresh [left, right] tuple (used in tests). */
  process(left: number, right: number): [number, number] {
    this.processInto(left, right, this.scratch)
    return [this.scratch[0], this.scratch[1]]
  }

  reset(): void {
    this.left.reset()
    this.right.reset()
    this.toneLeft.reset()
    this.toneRight.reset()
    // Back to cold: no in-flight crossfade, and the next time set snaps rather
    // than fading, so a reset instance matches a freshly constructed one.
    this.fadeRemaining = 0
    this.previousDelaySamples = this.delaySamples
    this.warmed = false
  }
}
