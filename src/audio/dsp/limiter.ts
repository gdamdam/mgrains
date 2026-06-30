// Stereo-linked peak limiter. Pure, deterministic, DOM-free — operates on plain
// numbers so it can be unit tested and dropped into an AudioWorklet. No
// AudioContext, no Date.now / Math.random.
//
// This is the final master stage, replacing GranularCore's per-sample soft
// clip at 0.95. It guarantees |out| <= ceiling for in-range params while
// staying transparent below the ceiling.
//
// Design — a classic feedforward peak limiter with stereo-linked gain:
//   - Detect the instantaneous stereo peak max(|L|, |R|).
//   - The target gain is ceiling / peak when the peak would exceed the
//     ceiling, else unity. This is the gain that places the peak exactly at
//     the ceiling.
//   - Attack is instant: if the target gain is below the current gain we drop
//     to it immediately (within the sample), so a spike can never overshoot —
//     no lookahead required.
//   - Release is smooth: when the target gain is above the current gain we
//     ease back toward unity with a one-pole coefficient derived from the
//     release time-constant, so gain recovers gradually after a loud burst.
//   - The SAME gain is applied to both channels, so the stereo image (the L/R
//     ratio) is never altered by the limiter.

const DEFAULT_SR = 48000

export interface LimiterParams {
  /** Peak target, 0..1 (e.g. 0.95). Output magnitude never exceeds this. */
  ceiling: number
  /** Release time in seconds (e.g. 0.05..0.5). Larger => slower recovery. */
  release: number
}

export class Limiter {
  private readonly sampleRate: number
  private ceiling = 0.95
  // Per-sample release coefficient in (0, 1]: gain += releaseCoef * (1 - gain).
  private releaseCoef = 1
  // Current applied gain; 1 == unity (transparent).
  private gain = 1
  // Reused output for the allocation-free process() wrapper (audio-thread safe).
  private readonly scratch = new Float64Array(2)

  constructor(sampleRate: number) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : DEFAULT_SR
    this.setParams({ ceiling: 0.95, release: 0.1 })
  }

  setParams({ ceiling, release }: LimiterParams): void {
    // Clamp ceiling into a strictly positive (0, 1] range; a non-positive
    // ceiling would make the target gain blow up or zero the signal.
    const c = Number.isFinite(ceiling) ? Math.min(1, Math.max(1e-6, ceiling)) : 0.95
    this.ceiling = c
    // Map release seconds to a one-pole coefficient. A larger release time
    // yields a smaller coefficient (slower recovery). Guard tiny/zero release
    // so the coefficient stays in (0, 1] and recovery is still well defined.
    const r = Number.isFinite(release) ? Math.max(0, release) : 0.1
    const samples = r * this.sampleRate
    this.releaseCoef = samples > 0 ? 1 - Math.exp(-1 / samples) : 1
  }

  /**
   * Process one stereo sample pair into `out` ([left, right]) with no
   * allocation, so it is safe to call per sample on the audio thread.
   */
  processInto(left: number, right: number, out: Float64Array): void {
    const inL = Number.isFinite(left) ? left : 0
    const inR = Number.isFinite(right) ? right : 0

    // Stereo-linked detector: drive the gain from the louder of the two
    // channels so the same reduction lands on both.
    const peak = Math.max(Math.abs(inL), Math.abs(inR))
    const targetGain = peak > this.ceiling ? this.ceiling / peak : 1

    if (targetGain < this.gain) {
      // Instant attack — clamp immediately so the output can't overshoot.
      this.gain = targetGain
    } else {
      // Smooth release back toward the (higher) target, easing to unity.
      this.gain += this.releaseCoef * (targetGain - this.gain)
    }

    out[0] = inL * this.gain
    out[1] = inR * this.gain
  }

  /** Convenience wrapper returning a fresh [left, right] tuple (used in tests). */
  process(left: number, right: number): [number, number] {
    this.processInto(left, right, this.scratch)
    return [this.scratch[0], this.scratch[1]]
  }

  reset(): void {
    this.gain = 1
  }
}
