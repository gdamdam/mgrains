// Deterministic audio-artifact detection utilities for the offline click/crackle
// audit. Pure, DOM-free, allocation-tolerant (analysis runs offline, never on the
// audio thread) so the whole harness can run under Vitest.
//
// The detector deliberately does NOT use one universal adjacent-sample delta
// threshold: a valid transient (a hard-window grain onset, an impulse source, a
// Shatter hit) has a large delta that is perfectly legitimate. A *click* is a
// step discontinuity that is anomalous *relative to its local neighbourhood* —
// far larger than the surrounding sample-to-sample motion and significant
// relative to the local signal energy. So detection is local and ratio-based.

import { XorShift32 } from './rng'

export interface SignalStats {
  peak: number
  rms: number
  dcOffset: number
  nonFiniteCount: number
  // Largest |x[n] - x[n-1]| and where it occurred (raw, not click-classified).
  maxAdjacentDelta: number
  maxAdjacentDeltaFrame: number
  length: number
}

export function analyzeSignal(signal: ArrayLike<number>): SignalStats {
  let peak = 0
  let sumSquares = 0
  let sum = 0
  let nonFiniteCount = 0
  let maxAdjacentDelta = 0
  let maxAdjacentDeltaFrame = 0
  let previous = 0

  for (let index = 0; index < signal.length; index += 1) {
    const value = signal[index]
    if (!Number.isFinite(value)) {
      nonFiniteCount += 1
      // Treat a non-finite sample as 0 for the running aggregates so one NaN
      // doesn't poison peak/rms; it is still counted above.
      previous = 0
      continue
    }
    const magnitude = Math.abs(value)
    if (magnitude > peak) peak = magnitude
    sumSquares += value * value
    sum += value
    if (index > 0) {
      const delta = Math.abs(value - previous)
      if (delta > maxAdjacentDelta) {
        maxAdjacentDelta = delta
        maxAdjacentDeltaFrame = index
      }
    }
    previous = value
  }

  const length = signal.length
  return {
    peak,
    rms: length > 0 ? Math.sqrt(sumSquares / length) : 0,
    dcOffset: length > 0 ? sum / length : 0,
    nonFiniteCount,
    maxAdjacentDelta,
    maxAdjacentDeltaFrame,
    length,
  }
}

export interface Discontinuity {
  frame: number
  delta: number
  localRms: number
  localMedianDelta: number
  // How many times bigger this step is than the typical local step. A click is
  // a large isolated value here; a transient buried in busy material is small.
  ratioToMedian: number
}

export interface DiscontinuityOptions {
  // Samples each side used to characterise the local neighbourhood.
  windowRadius?: number
  // The step must exceed this multiple of the local *median* step to count as
  // an isolated discontinuity (robust to a few neighbouring clicks).
  isolationRatio?: number
  // ...and exceed this fraction of the local RMS, tying it to local energy so a
  // tiny step in a near-silent passage isn't flagged unless it dwarfs the signal.
  energyRatio?: number
  // ...and exceed this absolute floor, so dither/denormal-scale noise is ignored.
  absoluteFloor?: number
}

const DEFAULTS: Required<DiscontinuityOptions> = {
  windowRadius: 128,
  isolationRatio: 8,
  energyRatio: 0.5,
  absoluteFloor: 2e-3,
}

// Find isolated step discontinuities ("clicks"). Returns one entry per click,
// de-duplicated so a single step that smears across 1–2 samples reports once
// (its largest sample). Candidates are pre-filtered by the absolute floor so the
// O(window) local statistics are only computed where something actually jumps.
export function detectDiscontinuities(
  signal: ArrayLike<number>,
  options: DiscontinuityOptions = {},
): Discontinuity[] {
  const { windowRadius, isolationRatio, energyRatio, absoluteFloor } = { ...DEFAULTS, ...options }
  const found: Discontinuity[] = []
  let lastFlaggedFrame = -Infinity

  for (let index = 1; index < signal.length; index += 1) {
    const current = signal[index]
    const previous = signal[index - 1]
    if (!Number.isFinite(current) || !Number.isFinite(previous)) continue
    const delta = Math.abs(current - previous)
    if (delta <= absoluteFloor) continue

    const start = Math.max(1, index - windowRadius)
    const end = Math.min(signal.length - 1, index + windowRadius)
    const deltas: number[] = []
    let sumSquares = 0
    let energyCount = 0
    for (let j = start; j <= end; j += 1) {
      const a = signal[j]
      const b = signal[j - 1]
      if (Number.isFinite(a) && Number.isFinite(b)) deltas.push(Math.abs(a - b))
      if (Number.isFinite(a)) {
        sumSquares += a * a
        energyCount += 1
      }
    }
    const localMedianDelta = median(deltas)
    const localRms = energyCount > 0 ? Math.sqrt(sumSquares / energyCount) : 0
    const ratioToMedian = localMedianDelta > 0 ? delta / localMedianDelta : Infinity

    const isIsolated = delta > isolationRatio * localMedianDelta
    const isEnergetic = delta > energyRatio * localRms
    if (!isIsolated || !isEnergetic) continue

    // De-dupe: if the previous flag is within a couple of samples, keep the
    // larger one (a step shows up as one big delta, occasionally two).
    if (index - lastFlaggedFrame <= 2 && found.length > 0) {
      const previousFlag = found[found.length - 1]
      if (delta > previousFlag.delta) {
        found[found.length - 1] = { frame: index, delta, localRms, localMedianDelta, ratioToMedian }
      }
    } else {
      found.push({ frame: index, delta, localRms, localMedianDelta, ratioToMedian })
    }
    lastFlaggedFrame = index
  }

  return found
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

// ---------------------------------------------------------------------------
// Deterministic test sources. Each returns a mono Float32Array; the harness
// feeds the same buffer to both channels unless a test needs L≠R.
// ---------------------------------------------------------------------------

export function silenceSource(length: number): Float32Array {
  return new Float32Array(length)
}

export function dcSource(length: number, level = 0.5): Float32Array {
  return new Float32Array(length).fill(level)
}

export function sineSource(length: number, freqHz: number, sampleRate: number, amp = 0.7): Float32Array {
  const out = new Float32Array(length)
  const w = (2 * Math.PI * freqHz) / sampleRate
  for (let n = 0; n < length; n += 1) out[n] = amp * Math.sin(w * n)
  return out
}

// A single full-scale impulse in an otherwise silent buffer — the canonical
// "valid transient" the detector must not mistake for a click elsewhere.
export function impulseSource(length: number, position = 0): Float32Array {
  const out = new Float32Array(length)
  out[Math.min(length - 1, Math.max(0, position))] = 1
  return out
}

// Deterministic white-ish noise from the project RNG so runs are reproducible.
export function noiseSource(length: number, seed = 0x1234abcd, amp = 0.5): Float32Array {
  const rng = new XorShift32(seed)
  const out = new Float32Array(length)
  for (let n = 0; n < length; n += 1) out[n] = rng.nextBipolar() * amp
  return out
}
