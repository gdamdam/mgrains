/// <reference types="node" />
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { DEFAULT_PATCH, PATCH_RANGES, type GrainPatch, type ShatterStep } from '../contracts'

const GRAIN_FILTER_OFF_HZ = PATCH_RANGES.grainFilterHz[1] // range max = Off sentinel
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
    positionOffset: 0,
    sizeScale: 1,
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

  it('gates spawning to held notes when gateToNotes is on', () => {
    const source = makeSource()
    const core = new GranularCore({ sampleRate: 48_000, maxGrains: 16 })
    core.setSource(source, source)
    core.setGateToNotes(true)

    // No note held → the autonomous drone is muted, output is pure silence.
    expect(render(core).every((sample) => sample === 0)).toBe(true)

    // Holding a note re-enables sound on the same gated core.
    core.setActiveNotes([{ offset: 0, velocity: 1 }])
    expect(render(core).some((sample) => sample !== 0)).toBe(true)
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

  it('applies Tape, Formant and RingMod only when engaged and stays bounded', () => {
    const source = makeSource()
    const dry = new GranularCore({ sampleRate: 48_000, maxGrains: 16 })
    const wet = new GranularCore({ sampleRate: 48_000, maxGrains: 16 })
    dry.setPatch({ ...DEFAULT_PATCH })
    wet.setPatch({ ...DEFAULT_PATCH, tapeAmount: 1, formantAmount: 1, ringModAmount: 1, ringModHz: 200 })
    dry.setSource(source, source)
    wet.setSource(source, source)

    const dryOut = render(dry)
    const wetOut = render(wet)

    expect(wetOut).not.toEqual(dryOut)
    expect(wetOut.every(Number.isFinite)).toBe(true)
    expect(Math.max(...wetOut.map(Math.abs))).toBeLessThanOrEqual(1)
  })

  it('plays held notes as polyphonic voices', () => {
    const source = makeSource()
    const mono = new GranularCore({ sampleRate: 48_000, maxGrains: 32 })
    const poly = new GranularCore({ sampleRate: 48_000, maxGrains: 32 })
    mono.setPatch({ ...DEFAULT_PATCH })
    poly.setPatch({ ...DEFAULT_PATCH })
    mono.setSource(source, source)
    poly.setSource(source, source)
    poly.setActiveNotes([{ offset: 0, velocity: 1 }, { offset: 7, velocity: 1 }])

    const monoOut = render(mono)
    const polyOut = render(poly)

    expect(polyOut).not.toEqual(monoOut)
    expect(polyOut.every(Number.isFinite)).toBe(true)
    expect(poly.activeGrainCount).toBeGreaterThanOrEqual(mono.activeGrainCount)
  })

  it('responds promptly when Bloom density increases from a sparse setting', () => {
    const source = makeSource()
    const core = new GranularCore({ sampleRate: 1_000, maxGrains: 8 })
    const sparse = {
      ...DEFAULT_PATCH,
      mode: 'bloom' as const,
      densityHz: 0.5, // one grain every 2 s (2000 frames @1 kHz)
      grainSizeMs: 5,
      timingJitter: 0,
      spray: 0,
      scanSpeed: 0,
    }
    core.setPatch(sparse)
    core.setSource(source, source)

    // First grain spawns at frame 0 and queues the next one ~2 s out.
    core.process(new Float32Array(64), new Float32Array(64))

    // Jump to dense: the next grain must arrive within roughly one new interval
    // (1000 / 40 = 25 frames), not wait out the previously scheduled 2000-frame gap.
    core.setPatch({ ...sparse, densityHz: 40 })
    const spawned = countSpawned(core, 200)

    // Without prompt rescheduling this stays 0 (next grain is ~2000 frames away).
    expect(spawned).toBeGreaterThan(1)
  })

  it('does not double-trigger or reset phase on a density decrease', () => {
    const source = makeSource()
    const core = new GranularCore({ sampleRate: 1_000, maxGrains: 8 })
    const dense = {
      ...DEFAULT_PATCH,
      mode: 'bloom' as const,
      densityHz: 40, // interval 25 frames
      grainSizeMs: 5,
      timingJitter: 0,
      spray: 0,
      scanSpeed: 0,
    }
    core.setPatch(dense)
    core.setSource(source, source)
    core.process(new Float32Array(10), new Float32Array(10))

    // Lowering density must not pull the next grain earlier (no double-trigger):
    // the grain already scheduled ~25 frames out stays put.
    core.setPatch({ ...dense, densityHz: 0.5 })
    expect(countSpawned(core, 20)).toBe(1)
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

describe('GranularCore shatter Link bar alignment', () => {
  // Drive one frame at a time so a catch-up burst cannot hide inside a block:
  // the scheduler fires at most one step per frame, so a burst would appear as
  // spawnedGrains > 1 or extra fired frames.
  function driveShatter(core: GranularCore, frames: number) {
    const events: { frame: number; step: number; spawned: number }[] = []
    for (let i = 0; i < frames; i += 1) {
      const startFrame = core.currentFrame
      const result = core.process(new Float32Array(1), new Float32Array(1))
      if (result.spawnedGrains > 0) {
        events.push({ frame: startFrame, step: result.currentStep, spawned: result.spawnedGrains })
      }
    }
    return events
  }

  function makeShatterCore() {
    // 1000 Hz, 120 BPM, 1/16 (0.25 beat) => 125 frames per step, all steps fire.
    const core = new GranularCore({ sampleRate: 1_000, maxGrains: 8 })
    core.setPatch({
      ...DEFAULT_PATCH,
      mode: 'shatter',
      bpm: 120,
      shatterDivision: '1/16',
      shatterSteps: shatterSteps(),
    })
    const source = makeSource(256)
    core.setSource(source, source)
    return core
  }

  it('free-runs on a fixed grid when no Link anchor is set (disconnected unchanged)', () => {
    const events = driveShatter(makeShatterCore(), 400)
    expect(events.map((e) => e.frame)).toEqual([0, 125, 250, 375])
    expect(events.map((e) => e.step)).toEqual([0, 1, 2, 3])
    expect(events.every((e) => e.spawned === 1)).toBe(true)
  })

  it('anchors step 0 to a shared downbeat, skipping missed steps with no catch-up burst', () => {
    const core = makeShatterCore()

    // Free-run: fires at 0/125/250, next natural step is queued for frame 375.
    const before = driveShatter(core, 300)
    expect(before.map((e) => e.frame)).toEqual([0, 125, 250])
    expect(before[before.length - 1].step).toBe(2)

    // Shared downbeat lands at frame 360 — before the queued 375 step.
    core.alignShatterAtFrame(360)
    const after = driveShatter(core, 200) // frames 300..499

    // Exactly one step fires at the downbeat, and it is step 0.
    expect(after[0]).toEqual({ frame: 360, step: 0, spawned: 1 })
    // The step that would have fired at 375 is skipped, not replayed.
    expect(after.some((e) => e.frame === 375)).toBe(false)
    // Sequence continues forward from the anchor (next step one interval later).
    expect(after[1]).toEqual({ frame: 485, step: 1, spawned: 1 })
    // No frame ever fires more than a single step (no burst).
    expect(after.every((e) => e.spawned === 1)).toBe(true)
  })

  it('ignores a Link anchor in the past — forward-only, never retroactive', () => {
    const core = makeShatterCore()
    driveShatter(core, 300) // advance to frame 300, next natural step at 375

    core.alignShatterAtFrame(100) // already elapsed
    const after = driveShatter(core, 130) // frames 300..429

    // No reset to step 0: the sequence keeps going as if no anchor arrived.
    expect(after[0]).toEqual({ frame: 375, step: 3, spawned: 1 })
  })

  it('holds a single pending downbeat even when re-anchored every frame (no per-tick restart)', () => {
    const core = makeShatterCore()
    // Simulate 20Hz ticks all pointing at the same upcoming downbeat frame.
    for (let k = 0; k < 12; k += 1) core.alignShatterAtFrame(200)

    const events = driveShatter(core, 300)
    const atAnchor = events.filter((e) => e.frame === 200)
    expect(atAnchor).toEqual([{ frame: 200, step: 0, spawned: 1 }]) // fired exactly once
  })
})

describe('GranularCore audit fixes', () => {
  const CLEAN_OVERRIDES = {
    spray: 0,
    timingJitter: 0,
    scanSpeed: 0,
    pitchSpreadSemitones: 0,
    reverseProbability: 0,
    stereoSpread: 0,
  } as const

  function dcSource(length = 8192): Float32Array {
    return new Float32Array(length).fill(1)
  }

  it('fades out a stolen grain instead of hard-cutting it', () => {
    const core = new GranularCore({ sampleRate: 48_000, maxGrains: 1 })
    const source = dcSource(48_000)
    core.setSource(source, source)
    core.setPatch({
      ...DEFAULT_PATCH,
      ...CLEAN_OVERRIDES,
      grainSizeMs: 500,
      densityHz: 10, // steals every 4 800 frames while the grain is mid-envelope
      inputGain: 1,
      outputGain: 1,
    })

    const output = render(core, 80)
    let maxJump = 0
    for (let index = 1; index < output.length; index += 1) {
      maxJump = Math.max(maxJump, Math.abs(output[index] - output[index - 1]))
    }

    // A hard cut at hann(0.2) ≈ 0.35 × gain ≈ 0.15/sample; a 2-5 ms fade keeps
    // consecutive-sample deltas well under 0.02.
    expect(maxJump).toBeLessThan(0.02)
  })

  it('keeps shatter loudness independent of the (inactive) density control', () => {
    const source = dcSource()
    const dense = new GranularCore({ sampleRate: 48_000, maxGrains: 16 })
    const sparse = new GranularCore({ sampleRate: 48_000, maxGrains: 16 })
    for (const [core, densityHz] of [[dense, 40], [sparse, 2]] as const) {
      core.setSource(source, source)
      core.setPatch({
        ...DEFAULT_PATCH,
        ...CLEAN_OVERRIDES,
        mode: 'shatter',
        shatterSteps: shatterSteps(),
        densityHz,
      })
    }

    // 140 blocks ≈ 0.37 s: long enough to pass the bloom→shatter mode
    // transition (0.09 s fade) AND reach spawns that read the new density.
    expect(render(dense, 140)).toEqual(render(sparse, 140))
  })

  it('normalizes chord loudness by the square root of the held-note count', () => {
    const source = dcSource()
    const solo = new GranularCore({ sampleRate: 48_000, maxGrains: 64 })
    const chord = new GranularCore({ sampleRate: 48_000, maxGrains: 64 })
    for (const core of [solo, chord]) {
      core.setSource(source, source)
      core.setPatch({ ...DEFAULT_PATCH, ...CLEAN_OVERRIDES, outputGain: 0.1 })
    }
    solo.setActiveNotes([{ offset: 0, velocity: 1 }])
    chord.setActiveNotes([
      { offset: 0, velocity: 1 },
      { offset: 3, velocity: 1 },
      { offset: 7, velocity: 1 },
      { offset: 12, velocity: 1 },
    ])

    const soloPeak = Math.max(...render(solo, 60).map(Math.abs))
    const chordPeak = Math.max(...render(chord, 60).map(Math.abs))

    // 4 summed voices must scale like √4 = 2×, not 4× (power-correct summing).
    expect(chordPeak / soloPeak).toBeGreaterThan(1.7)
    expect(chordPeak / soloPeak).toBeLessThan(2.3)
  })

  it('preserves shatter phase across a tempo change instead of re-firing step 0', () => {
    const core = new GranularCore({ sampleRate: 48_000, maxGrains: 16 })
    const source = dcSource()
    core.setSource(source, source)
    const patch = {
      ...DEFAULT_PATCH,
      ...CLEAN_OVERRIDES,
      mode: 'shatter' as const,
      shatterDivision: '1/4' as const,
      shatterSteps: shatterSteps(),
    }
    core.setPatch(patch)

    // Ride out the bloom→shatter mode transition: 2 bloom spawns during the
    // 0.09 s fade-out, then shatter step 0 at ≈ frame 4 320. Step length at
    // 120 bpm, 1/4 = 24 000 frames → next step ≈ frame 28 320; frame 16 000
    // is mid-step.
    expect(countSpawned(core, 16_000, 128)).toBe(3)
    core.setPatch({ ...patch, bpm: 121 })

    // A tempo nudge must not re-fire step 0 immediately…
    expect(countSpawned(core, 512, 128)).toBe(0)
    // …and the next step still arrives roughly where the rescaled wait says.
    expect(countSpawned(core, 13_000, 128)).toBe(1)
  })
})

describe('GranularCore shatter per-step position/size', () => {
  // A normalized ramp source: sample[i] ≈ i/(len-1), so a grain's first output
  // sample reveals the read position directly (hard window = no fade, gain 1).
  function rampSource(length = 4096): Float32Array {
    return Float32Array.from({ length }, (_, i) => i / (length - 1))
  }
  const CLEAN = {
    mode: 'shatter' as const,
    bpm: 120,
    shatterDivision: '1/16' as const,
    position: 0,
    regionStart: 0,
    regionEnd: 1,
    spray: 0,
    timingJitter: 0,
    scanSpeed: 0,
    pitchSemitones: 0,
    pitchSpreadSemitones: 0,
    reverseProbability: 0,
    stereoSpread: 0,
    window: 'hard' as const,
    outputGain: 1,
    // Keep the grain shorter than the 1/16-step interval (125 frames at
    // 120bpm/1kHz) so expectedOverlap floors to 1 and normalizedGain is
    // exactly 1 — otherwise DEFAULT_PATCH's 180 ms grain overlaps the step
    // clock and the read-position assertions below pick up an amplitude
    // scale-down that has nothing to do with positionOffset.
    grainSizeMs: 20,
  }

  it('per-step positionOffset shifts the grain read position after spray, before wrap', () => {
    // The hard window is exactly 0 at phase<=0 (windows.ts), so a freshly
    // spawned grain's very first output sample is always silent — render 2
    // samples and read index 1, the first audible one.
    const source = rampSource()
    const base = new GranularCore({ sampleRate: 1_000, maxGrains: 1 })
    base.setPatch({ ...DEFAULT_PATCH, ...CLEAN, shatterSteps: shatterSteps({ positionOffset: 0 }) })
    base.setSource(source, source)
    const b = new Float32Array(2); base.process(b, new Float32Array(2))

    const shifted = new GranularCore({ sampleRate: 1_000, maxGrains: 1 })
    shifted.setPatch({ ...DEFAULT_PATCH, ...CLEAN, shatterSteps: shatterSteps({ positionOffset: 0.25 }) })
    shifted.setSource(source, source)
    const s = new Float32Array(2); shifted.process(s, new Float32Array(2))

    expect(b[1]).toBeCloseTo(0, 3)        // position 0 → reads sample ~0
    expect(s[1]).toBeCloseTo(0.25, 2)     // +0.25 offset → reads a quarter in
  })

  it('per-step sizeScale scales grain duration and lowers per-grain gain accordingly', () => {
    // DC source = 1, hard window: every in-grain output sample == normalizedGain.
    const source = new Float32Array(8192).fill(1)

    // Duration: the hard window is exactly 0 at phase<=0 and phase>=1
    // (windows.ts), so a durationFrames-frame grain reads back as
    // durationFrames-1 audible samples. Buffer length 100 stays under the
    // 125-frame 1/16-step interval at 120bpm/1kHz, so only one step (one
    // grain) fires — a clean, uncontaminated frame count.
    function renderDuration(sizeScale: number): number {
      const core = new GranularCore({ sampleRate: 1_000, maxGrains: 1 })
      core.setPatch({ ...DEFAULT_PATCH, ...CLEAN, grainSizeMs: 20, shatterSteps: shatterSteps({ sizeScale }) })
      core.setSource(source, source)
      const out = new Float32Array(100)
      core.process(out, new Float32Array(100))
      return out.filter((v) => v > 1e-6).length
    }
    const d1 = renderDuration(1) // 20 ms @ 1000 Hz → 20 frames → 19 audible samples
    const d4 = renderDuration(4) // 80 ms → 80 frames → 79 audible samples
    expect(d1).toBe(19)
    expect(d4).toBe(79)

    // Gain: expectedOverlap = durationFrames / spawnIntervalFrames only departs
    // from its floor of 1 once the grain outlasts the step interval, so use a
    // fast step clock (240bpm, 1/64 ≈ 15.6-frame interval) where even the
    // unscaled 20 ms grain already overlaps the next step. Read just the first
    // audible sample — fixed at spawn time, unaffected by later voice-stealing —
    // from a buffer far shorter than the interval, so no second step pollutes it.
    function renderGain(sizeScale: number): number {
      const core = new GranularCore({ sampleRate: 1_000, maxGrains: 1 })
      core.setPatch({
        ...DEFAULT_PATCH, ...CLEAN, bpm: 240, shatterDivision: '1/64',
        grainSizeMs: 20, shatterSteps: shatterSteps({ sizeScale }),
      })
      core.setSource(source, source)
      const out = new Float32Array(5)
      core.process(out, new Float32Array(5))
      return out.find((v) => v > 1e-6) ?? 0
    }
    const g1 = renderGain(1)
    const g4 = renderGain(4)
    // Overlap grows ×4 (duration and interval scale identically), so the
    // power-normalized gain falls by 1/sqrt(4) = 0.5.
    expect(g4).toBeCloseTo(g1 * 0.5, 3)
  })
})

describe('GranularCore shatter swing', () => {
  // Local copy of the frame-accurate driver used by the Link-alignment suite.
  function driveShatter(core: GranularCore, frames: number) {
    const events: { frame: number; step: number }[] = []
    for (let i = 0; i < frames; i += 1) {
      const startFrame = core.currentFrame
      const result = core.process(new Float32Array(1), new Float32Array(1))
      if (result.spawnedGrains > 0) events.push({ frame: startFrame, step: result.currentStep })
    }
    return events
  }
  function swingCore(overrides: Partial<import('../contracts').GrainPatch> = {}) {
    const core = new GranularCore({ sampleRate: 1_000, maxGrains: 8 })
    core.setPatch({
      ...DEFAULT_PATCH, mode: 'shatter', bpm: 120, shatterDivision: '1/16',
      shatterSteps: shatterSteps(), ...overrides,
    })
    const source = makeSource(256)
    core.setSource(source, source)
    return core
  }

  it('swing=0 keeps the fixed 125-frame grid (regression)', () => {
    const events = driveShatter(swingCore({ shatterSwing: 0 }), 400)
    expect(events.map((e) => e.frame)).toEqual([0, 125, 250, 375])
  })

  it('delays odd steps by exactly delta = swing × stepFrames / 2 and returns evens to grid', () => {
    // swing 0.4, stepFrames 125 → delta = 25. Onsets: 0, 150, 250, 400, 500.
    const events = driveShatter(swingCore({ shatterSwing: 0.4 }), 520)
    expect(events.map((e) => e.frame)).toEqual([0, 150, 250, 400, 500])
    expect(events.map((e) => e.step)).toEqual([0, 1, 2, 3, 4])
    // Step 0 never swung; odd onsets are +25 vs the 125-grid; evens back on grid.
  })

  it('subdivides the SWUNG interval with ratchets', () => {
    // Step 0 ratchet 2, swing 0.4 → step-0 interval 150, split into 75 + 75;
    // step 1 onset at 150.
    const core = swingCore({ shatterSwing: 0.4, shatterSteps: shatterSteps({ ratchet: 1 }) })
    const steps = shatterSteps({ ratchet: 1 })
    steps[0] = { ...steps[0], ratchet: 2 }
    core.setPatch({ ...DEFAULT_PATCH, mode: 'shatter', bpm: 120, shatterDivision: '1/16', shatterSwing: 0.4, shatterSteps: steps })
    const events = driveShatter(core, 260)
    expect(events.map((e) => e.frame)).toEqual([0, 75, 150, 275 - 25]) // 0,75 (step0 ratchets), 150 (step1), 250 (step2)
    expect(events.map((e) => e.step)).toEqual([0, 0, 1, 2])
  })

  it('swing survives a tempo rescale (no machine-gun reset to step 0)', () => {
    // Advance past step 0 at 120 BPM, then halve tempo mid-wait to 60 BPM
    // (stepFrames 125 → 250, delta 25 → 50). Sequence must NOT restart at step 0,
    // and the next odd onset must be swung by the NEW delta.
    const core = swingCore({ shatterSwing: 0.4 })
    driveShatter(core, 60) // fire step 0 at frame 0; next (step 1) queued for 150
    core.setPatch({ ...DEFAULT_PATCH, mode: 'shatter', bpm: 60, shatterDivision: '1/16', shatterSwing: 0.4, shatterSteps: shatterSteps() })
    const after = driveShatter(core, 900)
    expect(after[0].step).toBe(1)            // continues forward, no reset to 0
    // remaining wait (150-60=90) rescaled ×2 → 180; step-1 onset = 60+180 = 240
    expect(after[0].frame).toBe(240)
    // step 2 (even) returns to grid at the NEW step: 240 + (250-50) = 440
    expect(after[1]).toEqual({ frame: 440, step: 2 })
  })

  it('never swings step 0 under a Link anchor', () => {
    const core = swingCore({ shatterSwing: 0.6 })
    driveShatter(core, 300)          // free-run a while
    core.alignShatterAtFrame(600)    // shared downbeat
    const after = driveShatter(core, 200) // frames 300..499 then anchor at 600
    // Advance until the anchor frame to confirm step 0 lands exactly on 600.
    const more = driveShatter(core, 200) // frames 500..699
    const atAnchor = [...after, ...more].find((e) => e.frame === 600)
    expect(atAnchor).toEqual({ frame: 600, step: 0 })
  })
})

describe('GranularCore per-grain filter (v1.8.0)', () => {
  // ---- Exact Off bypass ----------------------------------------------------
  // Golden digest of a fixed seeded render captured on the UNMODIFIED v1.7 tree
  // (f267680). grainFilterHz defaults to Off, so this render must stay
  // byte-identical after the filter lands. If it ever fails on different
  // hardware (libm variance), regenerate by checking out f267680 and running
  // this test with the digest console.logged.
  const V17_GOLDEN_SHA256 = '037dea60588da9c25bcca546277c10ae9b93bf5ce73c8b911e103c3b8ee452a5'

  function goldenRender(): Buffer {
    const source = makeSource(4096)
    const core = new GranularCore({ sampleRate: 48_000, maxGrains: 32 })
    core.setPatch({ ...DEFAULT_PATCH }) // grainFilterHz: 8000 = Off (default)
    core.setSource(source, source)
    const left = new Float32Array(48_000)
    const right = new Float32Array(48_000)
    for (let o = 0; o < 48_000; o += 128) {
      core.process(left.subarray(o, o + 128), right.subarray(o, o + 128))
    }
    return Buffer.concat([Buffer.from(left.buffer), Buffer.from(right.buffer)])
  }

  it('renders byte-identically to v1.7 when the filter is Off (default)', () => {
    const digest = createHash('sha256').update(goldenRender()).digest('hex')
    expect(digest).toBe(V17_GOLDEN_SHA256)
  })

  it('at Off, spread is inert: renders are identical for any grainFilterSpread (no RNG draw)', () => {
    const source = makeSource()
    const a = new GranularCore({ sampleRate: 48_000 })
    const b = new GranularCore({ sampleRate: 48_000 })
    a.setPatch({ ...DEFAULT_PATCH, grainFilterHz: GRAIN_FILTER_OFF_HZ, grainFilterSpread: 0 })
    b.setPatch({ ...DEFAULT_PATCH, grainFilterHz: GRAIN_FILTER_OFF_HZ, grainFilterSpread: 3 })
    a.setSource(source, source)
    b.setSource(source, source)
    expect(render(a)).toEqual(render(b))
  })

  // ---- Engaged filter ------------------------------------------------------
  it('an engaged filter changes the render (and output stays finite/bounded)', () => {
    const source = makeSource()
    const off = new GranularCore({ sampleRate: 48_000 })
    const on = new GranularCore({ sampleRate: 48_000 })
    off.setPatch({ ...DEFAULT_PATCH })
    on.setPatch({ ...DEFAULT_PATCH, grainFilterHz: 500, grainFilterSpread: 0 })
    off.setSource(source, source)
    on.setSource(source, source)
    const filtered = render(on)
    expect(filtered).not.toEqual(render(off))
    expect(filtered.every(Number.isFinite)).toBe(true)
  })

  // ---- Spawn draw ----------------------------------------------------------
  function drawnCutoffs(patch: Partial<GrainPatch>): number[] {
    const source = makeSource()
    const core = new GranularCore({ sampleRate: 48_000, maxGrains: 32 })
    core.setPatch({ ...DEFAULT_PATCH, densityHz: 40, grainSizeMs: 400, ...patch })
    core.setSource(source, source)
    // 8192 frames @48k, densityHz 40 => ~7 spawns; 400 ms grains all stay live.
    core.process(new Float32Array(8192), new Float32Array(8192))
    const cutoffs: number[] = []
    for (let slot = 0; slot < 32; slot += 1) {
      const hz = core.grainFilterCutoffHz(slot)
    if (hz > 0) cutoffs.push(hz)
    }
    return cutoffs
  }

  it('draws cutoffs within center +/- spread octaves (uniform in octaves)', () => {
    const cutoffs = drawnCutoffs({ grainFilterHz: 1_000, grainFilterSpread: 2 })
    expect(cutoffs.length).toBeGreaterThan(4)
    for (const hz of cutoffs) {
      expect(hz).toBeGreaterThanOrEqual(250)   // 1000 / 2^2
      expect(hz).toBeLessThanOrEqual(4_000)    // 1000 * 2^2
    }
    expect(new Set(cutoffs.map((hz) => hz.toFixed(3))).size).toBeGreaterThan(1) // actually random
  })

  it('spread 0 pins every grain to the exact center', () => {
    const cutoffs = drawnCutoffs({ grainFilterHz: 1_000, grainFilterSpread: 0 })
    expect(cutoffs.length).toBeGreaterThan(4)
    for (const hz of cutoffs) expect(hz).toBeCloseTo(1_000, 6)
  })

  it('same seed => same drawn cutoffs and same render (within-1.8 determinism)', () => {
    const source = makeSource()
    const patch = { ...DEFAULT_PATCH, grainFilterHz: 1_200, grainFilterSpread: 2 }
    const first = new GranularCore({ sampleRate: 44_100 })
    const second = new GranularCore({ sampleRate: 44_100 })
    first.setPatch(patch)
    second.setPatch(patch)
    first.setSource(source, source)
    second.setSource(source, source)
    expect(render(first)).toEqual(render(second))
  })

  it('zeroes filter state on reset()', () => {
    const source = makeSource()
    const core = new GranularCore({ sampleRate: 48_000 })
    core.setPatch({ ...DEFAULT_PATCH, grainFilterHz: 400, grainFilterSpread: 1 })
    core.setSource(source, source)
    const before = render(core)
    core.reset()
    expect(render(core)).toEqual(before) // reset => identical replay incl. filter state
  })
})
