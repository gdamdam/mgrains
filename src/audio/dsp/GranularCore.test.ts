import { describe, expect, it } from 'vitest'
import { DEFAULT_PATCH } from '../contracts'
import { GranularCore } from './GranularCore'

function makeSource(length = 2048): Float32Array {
  return Float32Array.from({ length }, (_, index) => Math.sin(index * 0.031))
}

function render(core: GranularCore, blocks = 40): Float32Array {
  const rendered = new Float32Array(blocks * 128)
  for (let block = 0; block < blocks; block += 1) {
    const left = rendered.subarray(block * 128, (block + 1) * 128)
    const right = new Float32Array(128)
    core.process(left, right)
  }
  return rendered
}

describe('GranularCore', () => {
  it('renders bounded finite output from a source', () => {
    const core = new GranularCore({ sampleRate: 48_000, maxGrains: 16 })
    const source = makeSource()
    core.setSource(source, source)
    const output = render(core)

    expect(output.some((sample) => sample !== 0)).toBe(true)
    expect(output.every(Number.isFinite)).toBe(true)
    expect(Math.max(...output.map(Math.abs))).toBeLessThanOrEqual(1)
    expect(core.activeGrainCount).toBeLessThanOrEqual(16)
  })

  it('renders deterministically for the same patch and seed', () => {
    const source = makeSource()
    const first = new GranularCore({ sampleRate: 44_100 })
    const second = new GranularCore({ sampleRate: 44_100 })
    first.setSource(source, source)
    second.setSource(source, source)

    expect(render(first)).toEqual(render(second))
  })

  it('keeps dense output finite and continuously bounded', () => {
    const source = new Float32Array(512).fill(8)
    const core = new GranularCore({ sampleRate: 48_000, maxGrains: 8 })
    core.setPatch({
      ...DEFAULT_PATCH,
      grainSizeMs: 4000,
      densityHz: 80,
      outputGain: 1,
    })
    core.setSource(source, source)

    const output = render(core, 120)
    expect(output.every(Number.isFinite)).toBe(true)
    expect(Math.max(...output)).toBeLessThanOrEqual(1)
  })

  it('wraps safely at a narrow region boundary with reverse grains', () => {
    const source = makeSource(64)
    const core = new GranularCore({ sampleRate: 48_000, maxGrains: 4 })
    core.setPatch({
      ...DEFAULT_PATCH,
      regionStart: 0.95,
      regionEnd: 1,
      position: 1,
      reverseProbability: 1,
      grainSizeMs: 5,
      densityHz: 80,
    })
    core.setSource(source, source)

    const output = render(core, 12)
    expect(output.every(Number.isFinite)).toBe(true)
    expect(core.activeGrainCount).toBeLessThanOrEqual(4)
  })

  it('produces silence without a source', () => {
    const core = new GranularCore({ sampleRate: 48_000 })
    const left = new Float32Array(128).fill(1)
    const right = new Float32Array(128).fill(1)
    const result = core.process(left, right)

    expect(left.every((sample) => sample === 0)).toBe(true)
    expect(right.every((sample) => sample === 0)).toBe(true)
    expect(result).toEqual({ activeGrains: 0, peak: 0 })
  })
})
