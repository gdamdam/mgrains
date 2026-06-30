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

  it('writes bounded normalized visual telemetry without allocating grain events', () => {
    const source = makeSource()
    const core = new GranularCore({ sampleRate: 48_000, maxGrains: 16 })
    core.setSource(source, source)
    core.process(new Float32Array(256), new Float32Array(256))
    const positions = new Float32Array(1)
    const intensities = new Float32Array(1)

    const count = core.writeVisualState(positions, intensities)

    expect(count).toBe(1)
    expect(positions[0]).toBeGreaterThanOrEqual(0)
    expect(positions[0]).toBeLessThanOrEqual(1)
    expect(intensities[0]).toBeGreaterThanOrEqual(0)
    expect(intensities[0]).toBeLessThanOrEqual(1)
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

  it('smooths output gain changes instead of applying a sample discontinuity', () => {
    const source = new Float32Array(512).fill(0.25)
    const core = new GranularCore({ sampleRate: 1_000, maxGrains: 4 })
    const patch = {
      ...DEFAULT_PATCH,
      grainSizeMs: 100,
      densityHz: 10,
      spray: 0,
      timingJitter: 0,
      pitchSpreadSemitones: 0,
      stereoSpread: 0,
      window: 'hard' as const,
      outputGain: 0.8,
    }
    core.setPatch(patch)
    core.setSource(source, source)

    core.setPatch({ ...patch, outputGain: 0 })
    core.process(new Float32Array(1), new Float32Array(1))

    expect(core.outputGain).toBeGreaterThan(0)
    expect(core.outputGain).toBeLessThan(0.8)

    core.process(new Float32Array(240), new Float32Array(240))
    expect(core.outputGain).toBeLessThan(0.001)
  })

  it('keeps active-grain window and region parameters stable across patch edits', () => {
    const source = Float32Array.from({ length: 128 }, (_, index) => index < 64 ? 0.1 : 0.8)
    const core = new GranularCore({ sampleRate: 1_000, maxGrains: 2 })
    const patch = {
      ...DEFAULT_PATCH,
      grainSizeMs: 100,
      densityHz: 0.25,
      position: 0,
      regionStart: 0,
      regionEnd: 0.25,
      spray: 0,
      timingJitter: 0,
      scanSpeed: 0,
      pitchSemitones: 0,
      pitchSpreadSemitones: 0,
      reverseProbability: 0,
      stereoSpread: 0,
      window: 'hard' as const,
      outputGain: 1,
    }
    core.setPatch(patch)
    core.setSource(source, source)
    core.process(new Float32Array(4), new Float32Array(4))

    core.setPatch({
      ...patch,
      regionStart: 0.75,
      regionEnd: 1,
      window: 'hann',
    })
    const left = new Float32Array(1)
    core.process(left, new Float32Array(1))

    expect(left[0]).toBeCloseTo(0.1)
  })

  it('switches Bloom and Shatter through silence in less than 200 ms', () => {
    const source = new Float32Array(512).fill(0.25)
    const core = new GranularCore({ sampleRate: 1_000, maxGrains: 8 })
    const bloomPatch = {
      ...DEFAULT_PATCH,
      grainSizeMs: 100,
      densityHz: 20,
      spray: 0,
      timingJitter: 0,
      pitchSpreadSemitones: 0,
      stereoSpread: 0,
      window: 'hard' as const,
      outputGain: 1,
    }
    core.setPatch(bloomPatch)
    core.setSource(source, source)
    core.process(new Float32Array(16), new Float32Array(16))

    core.setPatch({
      ...bloomPatch,
      mode: 'shatter',
      bpm: 120,
      shatterSteps: shatterSteps(),
    })
    const fadeOut = new Float32Array(90)
    core.process(fadeOut, new Float32Array(90))

    expect(core.currentMode).toBe('shatter')
    expect(core.transitionGain).toBe(0)
    expect(fadeOut.at(-1)).toBe(0)

    core.process(new Float32Array(90), new Float32Array(90))
    expect(core.transitionGain).toBe(1)
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

  it('applies mode FX (drive/crush/damp) only when engaged and stays bounded', () => {
    const source = makeSource()
    const dry = new GranularCore({ sampleRate: 48_000, maxGrains: 16 })
    const wet = new GranularCore({ sampleRate: 48_000, maxGrains: 16 })
    dry.setPatch({ ...DEFAULT_PATCH })
    wet.setPatch({ ...DEFAULT_PATCH, drive: 1, crush: 1, damp: 1 })
    dry.setSource(source, source)
    wet.setSource(source, source)

    const dryOut = render(dry)
    const wetOut = render(wet)

    // The grain RNG sequence is identical, so any difference is the FX chain.
    expect(wetOut).not.toEqual(dryOut)
    expect(wetOut.every(Number.isFinite)).toBe(true)
    expect(Math.max(...wetOut.map(Math.abs))).toBeLessThanOrEqual(1)
  })

  it('leaves the dry signal untouched when FX are at zero', () => {
    const source = makeSource()
    const a = new GranularCore({ sampleRate: 48_000, maxGrains: 16 })
    const b = new GranularCore({ sampleRate: 48_000, maxGrains: 16 })
    a.setPatch({ ...DEFAULT_PATCH, drive: 0, crush: 0, damp: 0 })
    b.setPatch({ ...DEFAULT_PATCH })
    a.setSource(source, source)
    b.setSource(source, source)

    expect(render(a)).toEqual(render(b))
  })

  it('applies Space (reverb) and Repeat (delay) only when engaged and stays bounded', () => {
    const source = makeSource()
    const dry = new GranularCore({ sampleRate: 48_000, maxGrains: 16 })
    const wet = new GranularCore({ sampleRate: 48_000, maxGrains: 16 })
    dry.setPatch({ ...DEFAULT_PATCH })
    wet.setPatch({ ...DEFAULT_PATCH, space: 1, repeat: 0.8 })
    dry.setSource(source, source)
    wet.setSource(source, source)

    const dryOut = render(dry)
    const wetOut = render(wet)

    expect(wetOut).not.toEqual(dryOut)
    expect(wetOut.every(Number.isFinite)).toBe(true)
    expect(Math.max(...wetOut.map(Math.abs))).toBeLessThanOrEqual(1)
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
