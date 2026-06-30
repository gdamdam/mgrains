// Pure, allocation-light DSP building blocks operating on plain numbers and
// Float32Array. No AudioContext, no DOM, no Date.now / Math.random — everything
// here is deterministic so it can be unit tested and reused inside a worklet.

const TWO_PI = Math.PI * 2

/**
 * tanh-style saturation. `drive` 0..1 scales the input into the nonlinear
 * region: at drive 0 the curve is ~unity for small signals, while higher drive
 * pushes large inputs harder into compression. Output stays bounded near
 * [-1, 1] because tanh asymptotes there.
 */
export function softClipDrive(sample: number, drive: number): number {
  if (!Number.isFinite(sample)) return 0
  // Clamp drive to its valid range, then map to a gain >= 1 so drive 0 keeps
  // small signals unaffected and drive 1 yields strong saturation.
  const amount = Math.min(1, Math.max(0, drive))
  const gain = 1 + amount * 9
  // No output normalization: a higher gain drives the input further up the
  // tanh curve, so larger drive genuinely compresses large inputs more while
  // tanh(x) ~= x keeps small signals near unity at drive 0.
  return Math.tanh(sample * gain)
}

/**
 * Quantize amplitude to `bits` resolution (1..16). Fewer bits => coarser steps
 * and harder quantization; more bits => closer to the original sample.
 */
export function bitcrush(sample: number, bits: number): number {
  if (!Number.isFinite(sample)) return 0
  const clampedBits = Math.min(16, Math.max(1, Math.floor(bits)))
  // Number of discrete steps the [-1, 1] range is divided into.
  const levels = Math.pow(2, clampedBits)
  const step = 2 / levels
  return Math.round(sample / step) * step
}

/**
 * Sample-and-hold downsampler. Holds the most recent input for `factor`
 * consecutive samples, emulating a reduced sample rate.
 */
export class SampleRateReducer {
  private readonly factor: number
  private counter = 0
  private held = 0

  constructor(factor: number) {
    // A factor < 1 makes no sense for a downsampler; clamp to pass-through.
    this.factor = Math.max(1, Math.floor(factor))
  }

  process(sample: number): number {
    if (this.counter === 0) {
      this.held = sample
    }
    this.counter += 1
    if (this.counter >= this.factor) {
      this.counter = 0
    }
    return this.held
  }

  reset(): void {
    this.counter = 0
    this.held = 0
  }
}

type FilterType = 'lowpass' | 'highpass'

/**
 * One-pole IIR filter. Stable for every cutoff because the coefficient stays in
 * [0, 1]. Lowpass passes DC (a steady input converges to it); highpass removes
 * DC by subtracting the lowpass output from the input.
 */
export class OnePole {
  private coefficient = 0
  private type: FilterType = 'lowpass'
  private state = 0

  setCutoff(normalizedFreq: number, type: FilterType): void {
    const clamped = Math.min(1, Math.max(0, normalizedFreq))
    // Standard one-pole smoothing coefficient derived from the normalized
    // cutoff; bounded in [0, 1] so the recursion can never grow unbounded.
    const raw = 1 - Math.exp(-TWO_PI * clamped * 0.5)
    this.coefficient = Math.min(1, Math.max(0, raw))
    this.type = type
  }

  process(sample: number): number {
    const input = Number.isFinite(sample) ? sample : 0
    this.state += this.coefficient * (input - this.state)
    if (this.type === 'highpass') {
      return input - this.state
    }
    return this.state
  }

  reset(): void {
    this.state = 0
  }
}

/**
 * Fixed-size ring buffer delay line backed by a single Float32Array. No
 * allocation happens after construction.
 */
export class DelayLine {
  private readonly buffer: Float32Array
  private readonly size: number
  private writeIndex = 0

  constructor(maxSamples: number) {
    this.size = Math.max(1, Math.floor(maxSamples))
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
   * Read the sample written `delaySamples` ago. read(0) returns the most
   * recently written sample.
   */
  read(delaySamples: number): number {
    const delay = Math.min(this.size - 1, Math.max(0, Math.floor(delaySamples)))
    // writeIndex already points one past the last write, so step back by
    // delay + 1 to reach the requested tap.
    let index = this.writeIndex - 1 - delay
    while (index < 0) {
      index += this.size
    }
    return this.buffer[index]
  }

  /**
   * Feed-back delay helper: reads the delayed sample, mixes it back into the
   * input scaled by `feedback`, and writes the result. Stable for feedback < 1
   * because each pass through the loop attenuates the signal.
   */
  processFeedback(sample: number, delaySamples: number, feedback: number): number {
    const fb = Math.min(0.999, Math.max(-0.999, feedback))
    const delayed = this.read(delaySamples)
    const output = sample + delayed * fb
    this.write(output)
    // Return the wet feedback signal so an input impulse is heard immediately
    // and then decays geometrically (stable comb filter for |feedback| < 1).
    return output
  }

  reset(): void {
    this.buffer.fill(0)
    this.writeIndex = 0
  }
}
