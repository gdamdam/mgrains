// Stereo WOW — pitch/time wobble (vibrato / tape-wow) effect. Pure,
// deterministic, DOM-free: it operates on plain numbers and its own
// Float32Array buffers so it can be unit tested and dropped straight into an
// AudioWorklet. No AudioContext, no Date.now / Math.random.
//
// Topology (mirrored from mdrone's FxChain.wireWow, which modulated a
// native DelayNode with sine LFOs — see FxChain.ts):
//   each channel feeds a short delay line; a sine LFO at `rate` Hz sweeps the
//   read position around a small base delay (~10 ms). Sweeping the read tap
//   stretches and compresses the signal in time, which warps its instantaneous
//   phase — i.e. the pitch wobbles. The two channels read with a slight LFO
//   phase offset so the wobble drifts across the stereo field.
//
// Why a hand-rolled interpolating read: effects.ts DelayLine.read floors the
// delay to an integer sample, so a smoothly swept tap would step between
// whole samples and produce zipper noise instead of clean pitch mod. We keep
// our own Float32Array ring per channel and do a fractional (linear)
// interpolated read, which is what makes the wobble musical.

const TWO_PI = Math.PI * 2

// LFO rate is clamped to a slow-wobble range. Below ~0.1 Hz the motion is
// imperceptible; above ~8 Hz it stops reading as "wow/flutter" and turns into
// audible FM sidebands. Matches the spirit of mdrone's 0.42 Hz wow LFO.
const MIN_RATE = 0.1
const MAX_RATE = 8

// Base read delay in seconds. The LFO swings the read tap symmetrically about
// this point, so it must be large enough that the deepest negative swing never
// crosses the write head (delay 0). 10 ms at 48 kHz is 480 samples of
// headroom — comfortably more than the max modulation depth below.
const BASE_DELAY_SEC = 0.01

// Peak modulation swing in seconds at depth = 1. Kept well under BASE_DELAY_SEC
// so the swept tap stays strictly inside (0, 2*base) and the interpolation
// never wraps past the write head. ~6 ms gives an obvious tape-style wobble.
const MAX_DEPTH_SEC = 0.006

// Right-channel LFO phase offset (fraction of a full cycle). A quarter cycle
// decorrelates the two channels for stereo motion without sounding like two
// unrelated effects.
const STEREO_PHASE_OFFSET = 0.25

const DEFAULT_SR = 48000

export interface WowParams {
  /** LFO rate in Hz. Clamped to ~0.1..8. Higher => faster wobble. */
  rate: number
  /** Modulation amount, 0..1. 0 => no wobble (fixed delay), 1 => full swing. */
  depth: number
}

/**
 * One modulated, fractionally-interpolated delay line. Owns its own ring
 * buffer so reads can land between samples for smooth pitch modulation.
 */
class ModDelay {
  private readonly buffer: Float32Array
  private readonly size: number
  private writeIndex = 0

  constructor(sizeSamples: number) {
    this.size = Math.max(2, Math.floor(sizeSamples))
    this.buffer = new Float32Array(this.size)
  }

  write(sample: number): void {
    this.buffer[this.writeIndex] = Number.isFinite(sample) ? sample : 0
    this.writeIndex += 1
    if (this.writeIndex >= this.size) {
      this.writeIndex = 0
    }
  }

  /**
   * Read `delaySamples` (a fractional number of samples) ago, linearly
   * interpolating between the two bracketing taps. delaySamples is clamped to
   * the buffer so a runaway modulation can never read out of bounds.
   */
  readFractional(delaySamples: number): number {
    let delay = delaySamples
    if (!Number.isFinite(delay)) delay = 0
    // Leave one sample of headroom for the +1 interpolation neighbour.
    const maxDelay = this.size - 2
    if (delay < 0) delay = 0
    if (delay > maxDelay) delay = maxDelay

    const intPart = Math.floor(delay)
    const frac = delay - intPart

    // writeIndex points one past the most recent write, so step back by
    // delay + 1 to reach the requested tap (read(0) => last written sample).
    let i0 = this.writeIndex - 1 - intPart
    while (i0 < 0) i0 += this.size
    let i1 = i0 - 1
    while (i1 < 0) i1 += this.size

    const a = this.buffer[i0]
    const b = this.buffer[i1]
    return a + (b - a) * frac
  }

  reset(): void {
    this.buffer.fill(0)
    this.writeIndex = 0
  }
}

export class Wow {
  private readonly sampleRate: number
  private readonly baseDelaySamples: number
  private readonly maxDepthSamples: number
  // LFO phase increment per sample, in radians. 0 when rate is 0.
  private phaseIncrement = 0
  // Current modulation swing in samples (depth scaled).
  private depthSamples = 0
  private phase = 0
  private readonly delayL: ModDelay
  private readonly delayR: ModDelay
  // Reused output for the allocation-free processInto path (audio-thread safe).
  private readonly scratch = new Float64Array(2)

  constructor(sampleRate: number) {
    this.sampleRate =
      Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : DEFAULT_SR
    this.baseDelaySamples = BASE_DELAY_SEC * this.sampleRate
    this.maxDepthSamples = MAX_DEPTH_SEC * this.sampleRate
    // Ring must hold base + full positive swing plus interpolation headroom.
    const maxNeeded = Math.ceil(this.baseDelaySamples + this.maxDepthSamples) + 4
    this.delayL = new ModDelay(maxNeeded)
    this.delayR = new ModDelay(maxNeeded)
    // Sensible defaults until setParams is called.
    this.setParams({ rate: 1, depth: 0.5 })
  }

  setParams({ rate, depth }: WowParams): void {
    const clampedDepth = clamp01(depth)
    this.depthSamples = clampedDepth * this.maxDepthSamples

    // rate 0 (or non-finite) parks the LFO so the delay is fixed — minimal
    // modulation. Otherwise clamp into the audible wow range.
    if (!Number.isFinite(rate) || rate <= 0) {
      this.phaseIncrement = 0
    } else {
      const clampedRate = Math.min(MAX_RATE, Math.max(MIN_RATE, rate))
      this.phaseIncrement = (TWO_PI * clampedRate) / this.sampleRate
    }
  }

  /**
   * Process one stereo sample pair into `out` ([left, right]) with no
   * allocation — both delay lines reuse their preallocated buffers, so this is
   * safe to call per sample on the audio thread.
   */
  processInto(left: number, right: number, out: Float64Array): void {
    const inL = Number.isFinite(left) ? left : 0
    const inR = Number.isFinite(right) ? right : 0

    this.delayL.write(inL)
    this.delayR.write(inR)

    // Two sine LFOs sharing one phase accumulator; the right channel is offset
    // a quarter cycle for stereo motion. The swing is symmetric about the base
    // delay, so at depth/rate 0 both taps sit exactly on the base delay.
    const lfoL = Math.sin(this.phase)
    const lfoR = Math.sin(this.phase + TWO_PI * STEREO_PHASE_OFFSET)

    const delayLSamples = this.baseDelaySamples + lfoL * this.depthSamples
    const delayRSamples = this.baseDelaySamples + lfoR * this.depthSamples

    out[0] = this.delayL.readFractional(delayLSamples)
    out[1] = this.delayR.readFractional(delayRSamples)

    // Advance and wrap the LFO phase. Wrapping keeps the accumulator bounded so
    // long runs stay precise and deterministic.
    this.phase += this.phaseIncrement
    if (this.phase >= TWO_PI) {
      this.phase -= TWO_PI
    }
  }

  /** Convenience wrapper returning a fresh [left, right] tuple (used in tests). */
  process(left: number, right: number): [number, number] {
    this.processInto(left, right, this.scratch)
    return [this.scratch[0], this.scratch[1]]
  }

  reset(): void {
    this.delayL.reset()
    this.delayR.reset()
    this.phase = 0
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}
