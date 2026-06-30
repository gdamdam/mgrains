import { describe, expect, it } from 'vitest'
import { createDemoSource, createWaveformPeaks, DEMO_VARIANT_COUNT } from './demoSource'

const SAMPLE_RATE = 8_000

function maxAbs(samples: Float32Array): number {
  let peak = 0
  for (const value of samples) peak = Math.max(peak, Math.abs(value))
  return peak
}

// Channels are decorrelated when their correlation is well below 1, i.e. the
// stereo image is not a mono duplicate.
function correlation(left: Float32Array, right: Float32Array): number {
  let dot = 0
  let leftEnergy = 0
  let rightEnergy = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]
    leftEnergy += left[index] * left[index]
    rightEnergy += right[index] * right[index]
  }
  const denominator = Math.sqrt(leftEnergy * rightEnergy)
  return denominator === 0 ? 1 : dot / denominator
}

describe('audio source utilities', () => {
  it('exposes three demo variants', () => {
    expect(DEMO_VARIANT_COUNT).toBe(3)
  })

  it('createDemoSource(sr) returns a valid source', () => {
    const source = createDemoSource(SAMPLE_RATE)
    expect(source.left.length).toBeGreaterThan(0)
    expect(source.left.length).toBe(source.right.length)
    expect(source.peaks.length).toBe(320)
    expect(source.durationSeconds).toBeGreaterThan(0)
    expect(typeof source.label).toBe('string')
    expect(source.label.length).toBeGreaterThan(0)
  })

  it('selects generator i for createDemoSource(sr, i)', () => {
    const labels = Array.from(
      { length: DEMO_VARIANT_COUNT },
      (_, variant) => createDemoSource(SAMPLE_RATE, variant).label,
    )
    expect(new Set(labels).size).toBe(DEMO_VARIANT_COUNT)
    // Out-of-range variants wrap around to a valid generator.
    expect(createDemoSource(SAMPLE_RATE, DEMO_VARIANT_COUNT).label).toBe(labels[0])
    expect(createDemoSource(SAMPLE_RATE, -1).label).toBe(labels[DEMO_VARIANT_COUNT - 1])
  })

  for (let variant = 0; variant < 3; variant += 1) {
    describe(`variant ${variant}`, () => {
      it('is deterministic for a fixed variant', () => {
        const first = createDemoSource(SAMPLE_RATE, variant)
        const second = createDemoSource(SAMPLE_RATE, variant)
        expect(first.label).toBe(second.label)
        expect(first.left).toEqual(second.left)
        expect(first.right).toEqual(second.right)
      })

      it('is non-silent stereo with decorrelated channels', () => {
        const source = createDemoSource(SAMPLE_RATE, variant)
        expect(maxAbs(source.left)).toBeGreaterThan(0.05)
        expect(maxAbs(source.right)).toBeGreaterThan(0.05)
        expect(source.left).not.toEqual(source.right)
        // Real decorrelation, not a mono duplicate.
        expect(Math.abs(correlation(source.left, source.right))).toBeLessThan(0.98)
      })

      it('stays within bounds and finite', () => {
        const source = createDemoSource(SAMPLE_RATE, variant)
        expect(maxAbs(source.left)).toBeLessThanOrEqual(1)
        expect(maxAbs(source.right)).toBeLessThanOrEqual(1)
        expect(source.left.every(Number.isFinite)).toBe(true)
        expect(source.right.every(Number.isFinite)).toBe(true)
      })

      it('produces a peaks array of the expected length', () => {
        const source = createDemoSource(SAMPLE_RATE, variant)
        expect(source.peaks.length).toBe(320)
        expect(source.peaks.every(Number.isFinite)).toBe(true)
      })
    })
  }

  it('creates finite bounded waveform peaks', () => {
    const left = Float32Array.from([0, -0.5, 1, 0.25])
    const right = Float32Array.from([0.1, 0.2, -0.75, 0])
    const peaks = createWaveformPeaks(left, right, 2)

    expect([...peaks]).toEqual([0.5, 1])
    expect(peaks.every(Number.isFinite)).toBe(true)
  })
})
