import { describe, expect, it } from 'vitest'
import { DEFAULT_PATCH, type ShatterStep } from '../contracts'
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

function countSpawned(core: GranularCore, frames: number, blockSize = 64): number {
  let spawned = 0
  for (let offset = 0; offset < frames; offset += blockSize) {
    const length = Math.min(blockSize, frames - offset)
    const result = core.process(new Float32Array(length), new Float32Array(length))
    spawned += result.spawnedGrains
  }
  return spawned
}

function shatterSteps(overrides: Partial<ShatterStep> = {}): ShatterStep[] {
  return Array.from({ length: 16 }, () => ({
    enabled: true,
    probability: 1,
    pitchOffsetSemitones: 0,
    reverse: false,
    ratchet: 1,
    ...overrides,
  }))
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

  it('reads a circular source view from its chronological offset', () => {
    const physical = Float32Array.from([0.05, 0.02, 0.03, 0.04])
    const core = new GranularCore({ sampleRate: 1_000, maxGrains: 1 })
    core.setPatch({
      ...DEFAULT_PATCH,
      grainSizeMs: 5,
      densityHz: 80,
      position: 0,
      regionStart: 0,
      regionEnd: 1,
      spray: 0,
      timingJitter: 0,
      pitchSpreadSemitones: 0,
      reverseProbability: 0,
      stereoSpread: 0,
      window: 'hard',
      outputGain: 1,
    })
    core.setSourceView(physical, physical, 4, 1)

    const left = new Float32Array(4)
    const right = new Float32Array(4)
    core.process(left, right)

    expect(left[1]).toBeCloseTo(0.03)
    expect(right[1]).toBeCloseTo(0.03)
  })

  it('schedules Shatter steps at sample-frame divisions', () => {
    const core = new GranularCore({ sampleRate: 1_000, maxGrains: 8 })
    core.setPatch({
      ...DEFAULT_PATCH,
      mode: 'shatter',
      bpm: 60,
      shatterDivision: '1/16',
      shatterSteps: shatterSteps(),
      grainSizeMs: 5,
    })
    const source = makeSource()
    core.setSource(source, source)

    expect(countSpawned(core, 1_000)).toBe(4)
  })

  it('honors Shatter gates, probability, and ratchets deterministically', () => {
    const steps = shatterSteps({ enabled: false })
    steps[0] = { ...steps[0], enabled: true, ratchet: 2 }
    steps[1] = { ...steps[1], enabled: true, probability: 0 }
    const core = new GranularCore({ sampleRate: 1_000, maxGrains: 8 })
    core.setPatch({
      ...DEFAULT_PATCH,
      mode: 'shatter',
      bpm: 60,
      shatterDivision: '1/16',
      shatterSteps: steps,
      grainSizeMs: 5,
    })
    const source = makeSource()
    core.setSource(source, source)

    expect(countSpawned(core, 500)).toBe(2)
  })

  it('produces silence without a source', () => {
    const core = new GranularCore({ sampleRate: 48_000 })
    const left = new Float32Array(128).fill(1)
    const right = new Float32Array(128).fill(1)
    const result = core.process(left, right)

    expect(left.every((sample) => sample === 0)).toBe(true)
    expect(right.every((sample) => sample === 0)).toBe(true)
    expect(result).toEqual({
      activeGrains: 0,
      peak: 0,
      spawnedGrains: 0,
      currentStep: 0,
    })
  })
})
