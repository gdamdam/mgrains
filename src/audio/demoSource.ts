import { XorShift32 } from './dsp/rng'

export interface AudioSourceData {
  label: string
  left: Float32Array
  right: Float32Array
  peaks: Float32Array
  durationSeconds: number
}

export function createDemoSource(sampleRate: number, durationSeconds = 6): AudioSourceData {
  const length = Math.floor(sampleRate * durationSeconds)
  const left = new Float32Array(length)
  const right = new Float32Array(length)
  const rng = new XorShift32(0x6d677261)

  for (let index = 0; index < length; index += 1) {
    const time = index / sampleRate
    const drone =
      Math.sin(Math.PI * 2 * 110 * time) * 0.11
      + Math.sin(Math.PI * 2 * 164.81 * time + 0.7) * 0.07
      + Math.sin(Math.PI * 2 * 220.4 * time + 1.2) * 0.035
    const slowEnvelope = 0.62 + 0.38 * Math.sin(Math.PI * 2 * 0.09 * time - 0.8) ** 2
    const bellPhase = time % 1.5
    const bellEnvelope = Math.exp(-4.2 * bellPhase)
    const bell =
      Math.sin(Math.PI * 2 * 440 * time) * bellEnvelope * 0.21
      + Math.sin(Math.PI * 2 * 659.25 * time) * bellEnvelope * 0.09
    const air = rng.nextBipolar() * 0.012
    const panDrift = Math.sin(Math.PI * 2 * 0.07 * time)
    left[index] = (drone * slowEnvelope + bell + air) * (0.9 - panDrift * 0.1)
    right[index] = (drone * slowEnvelope + bell + air) * (0.9 + panDrift * 0.1)
  }

  return {
    label: 'Generated tone field',
    left,
    right,
    peaks: createWaveformPeaks(left, right),
    durationSeconds,
  }
}

export function createWaveformPeaks(
  left: Float32Array,
  right: Float32Array,
  bucketCount = 320,
): Float32Array {
  const length = Math.min(left.length, right.length)
  const peaks = new Float32Array(bucketCount)
  const bucketSize = Math.max(1, Math.floor(length / bucketCount))

  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = bucket * bucketSize
    const end = Math.min(length, start + bucketSize)
    let peak = 0
    for (let index = start; index < end; index += 1) {
      peak = Math.max(peak, Math.abs(left[index]), Math.abs(right[index]))
    }
    peaks[bucket] = peak
  }

  return peaks
}
