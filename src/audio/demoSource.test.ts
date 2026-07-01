import { describe, expect, it } from 'vitest'
import { createDemoSource, createWaveformPeaks, DEMO_SOURCES } from './demoSource'

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
  it('exposes ten demo sources with unique ids and labels', () => {
    expect(DEMO_SOURCES.length).toBe(10)
    expect(new Set(DEMO_SOURCES.map((source) => source.id)).size).toBe(10)
    expect(new Set(DEMO_SOURCES.map((source) => source.label)).size).toBe(10)
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

  it('defaults to the first registry entry, deterministically', () => {
    const a = createDemoSource(48000)
    const b = createDemoSource(48000)
    expect(a.label).toBe(DEMO_SOURCES[0].label)
    expect(Array.from(a.left.slice(0, 64))).toEqual(Array.from(b.left.slice(0, 64)))
  })

  it('selects by id', () => {
    expect(createDemoSource(48000, 'mallet-pulse').label).toBe('Mallet pulse texture')
  })

  it('falls back to the first entry for an unknown id', () => {
    expect(createDemoSource(SAMPLE_RATE, 'not-a-real-id').label).toBe(DEMO_SOURCES[0].label)
  })

  for (const { id } of DEMO_SOURCES) {
    describe(`source ${id}`, () => {
      it('is deterministic for a fixed id', () => {
        const first = createDemoSource(SAMPLE_RATE, id)
        const second = createDemoSource(SAMPLE_RATE, id)
        expect(second.label).toBe(first.label)
        expect(first.left).toEqual(second.left)
        expect(first.right).toEqual(second.right)
      })

      it('is non-silent stereo with decorrelated channels', () => {
        const source = createDemoSource(SAMPLE_RATE, id)
        expect(maxAbs(source.left)).toBeGreaterThan(0.05)
        expect(maxAbs(source.right)).toBeGreaterThan(0.05)
        expect(source.left).not.toEqual(source.right)
        // Real decorrelation, not a mono duplicate.
        expect(Math.abs(correlation(source.left, source.right))).toBeLessThan(0.98)
      })

      it('stays within bounds and finite', () => {
        const source = createDemoSource(SAMPLE_RATE, id)
        expect(maxAbs(source.left)).toBeLessThanOrEqual(1)
        expect(maxAbs(source.right)).toBeLessThanOrEqual(1)
        expect(source.left.every(Number.isFinite)).toBe(true)
        expect(source.right.every(Number.isFinite)).toBe(true)
      })

      it('produces a peaks array of the expected length', () => {
        const source = createDemoSource(SAMPLE_RATE, id)
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

describe('curated source registry (10)', () => {
  it('has 10 sources with unique ids', () => {
    expect(DEMO_SOURCES).toHaveLength(10)
    expect(new Set(DEMO_SOURCES.map((s) => s.id)).size).toBe(10)
  })

  it.each(DEMO_SOURCES.map((s) => s.id))('%s: deterministic + valid shape', (id) => {
    const a = createDemoSource(48000, id)
    const b = createDemoSource(48000, id)
    expect(a.left.length).toBeGreaterThan(48000) // > 1 s
    expect(a.right.length).toBe(a.left.length)
    expect(a.peaks.length).toBe(320)
    expect(Array.from(a.left.slice(0, 128))).toEqual(Array.from(b.left.slice(0, 128)))
  })

  it.each(DEMO_SOURCES.map((s) => s.id))('%s: label matches registry entry (label-authoritative)', (id) => {
    const entry = DEMO_SOURCES.find((s) => s.id === id)!
    const source = createDemoSource(48000, id)
    expect(source.label).toBe(entry.label)
  })

  it.each(DEMO_SOURCES.map((s) => s.id))('%s: peaks are non-silent and within full scale', (id) => {
    const source = createDemoSource(48000, id)
    const peak = Math.max(...source.peaks)
    expect(peak).toBeGreaterThan(0.05)
    expect(peak).toBeLessThanOrEqual(1.0)
  })
})
