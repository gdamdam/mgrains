import { describe, expect, it } from 'vitest'
import { createDemoSource, createWaveformPeaks } from './demoSource'

describe('audio source utilities', () => {
  it('creates a deterministic stereo demo source', () => {
    const first = createDemoSource(8_000, 0.25)
    const second = createDemoSource(8_000, 0.25)

    expect(first.left).toEqual(second.left)
    expect(first.right).toEqual(second.right)
    expect(first.left.length).toBe(2_000)
    expect(first.peaks.length).toBe(320)
  })

  it('creates finite bounded waveform peaks', () => {
    const left = Float32Array.from([0, -0.5, 1, 0.25])
    const right = Float32Array.from([0.1, 0.2, -0.75, 0])
    const peaks = createWaveformPeaks(left, right, 2)

    expect([...peaks]).toEqual([0.5, 1])
    expect(peaks.every(Number.isFinite)).toBe(true)
  })
})
