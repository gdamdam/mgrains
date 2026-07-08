// Offline click/crackle/artifact audit for the granular signal chain. Renders
// representative and adversarial patches and transitions through GranularCore and
// asserts:
//   1. transitions that SHOULD be click-free are (mode/gain/position/density/FX
//      toggle/BPM-with-delay) — these are regression tests, several guarding a fix;
//   2. finite / bounded / no-NaN / sane-DC invariants across 44.1/48/96 kHz and
//      across silence/DC/sine/impulse/noise sources;
//   3. KNOWN, currently-unfixed artifacts are characterized so a future fix (or
//      regression) is detected and this file updated.
//
// Steady-state click detection uses a "clean" patch (grain shorter than the
// region, no spray/jitter/spread/reverse) so the only discontinuities are the
// transition under test — see the region-loop characterization below for why a
// default-shaped patch is NOT steady-state clean.

/// <reference types="node" />
import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { DEFAULT_PATCH, type GrainPatch } from '../contracts'
import { GranularCore } from './GranularCore'
import {
  analyzeSignal,
  detectDiscontinuities,
  dcSource,
  impulseSource,
  noiseSource,
  silenceSource,
  sineSource,
} from './artifactDetection'
import { renderTimeline } from './artifactHarness'

const RATES = [44_100, 48_000, 96_000]

// A patch whose grains are shorter than the region (no intra-grain region wrap)
// and free of randomisation, so steady-state output is click-free and any
// detected discontinuity is attributable to the transition under test.
function cleanBloom(sr: number, overrides: Partial<GrainPatch> = {}): GrainPatch {
  return {
    ...DEFAULT_PATCH,
    mode: 'bloom',
    grainSizeMs: 80,
    densityHz: 14,
    spray: 0,
    timingJitter: 0,
    pitchSpreadSemitones: 0,
    reverseProbability: 0,
    stereoSpread: 0,
    scanSpeed: 0,
    regionStart: 0,
    regionEnd: 1,
    outputGain: 1,
    ...overrides,
  }
  // sr is accepted for symmetry / future per-rate tuning; region is full source.
  void sr
}

function makeCore(sr: number, patch: GrainPatch, source: Float32Array): GranularCore {
  const core = new GranularCore({ sampleRate: sr, maxGrains: 64 })
  core.setPatch(patch)
  core.setSource(source.slice(), source.slice())
  return core
}

function renderSteady(core: GranularCore, frames: number): { left: Float32Array; right: Float32Array } {
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  for (let o = 0; o < frames; o += 128) {
    const n = Math.min(128, frames - o)
    core.process(left.subarray(o, o + n), right.subarray(o, o + n))
  }
  return { left, right }
}

describe('artifact audit — steady state is click-free for a clean patch', () => {
  it('clean bloom over a sine renders without isolated discontinuities (all rates)', () => {
    for (const sr of RATES) {
      const core = makeCore(sr, cleanBloom(sr), sineSource(sr, 220, sr))
      const { left, right } = renderSteady(core, sr) // 1 second
      expect(detectDiscontinuities(left), `left @${sr}`).toHaveLength(0)
      expect(detectDiscontinuities(right), `right @${sr}`).toHaveLength(0)
    }
  }, 30_000)

  it('voice stealing under sustained over-demand fades the stolen grain (no steps)', () => {
    // A full pool of mid-envelope grains forces every spawn to steal a
    // non-silent grain. beginStealFade() ramps the stolen grain out over
    // ~3 ms instead of hard-cutting it, so the render stays step-free.
    const SR = 48_000
    const core = makeCore(SR, cleanBloom(SR, { densityHz: 40, grainSizeMs: 500 }), sineSource(SR, 220, SR))
    core.setActiveNotes([0, 2, 4, 5, 7, 9, 11, 12].map((offset) => ({ offset, velocity: 1 })))
    const { left } = renderSteady(core, SR)
    expect(detectDiscontinuities(left)).toHaveLength(0)
  })
})

describe('artifact audit — transitions that must be click-free', () => {
  const SR = 48_000
  const sine = () => sineSource(SR, 220, SR)

  function transitionClicks(before: GrainPatch, after: (c: GranularCore) => void): number {
    const core = makeCore(SR, before, sine())
    const { left } = renderTimeline(core, [
      { label: 'before', frames: 24_000 },
      { label: 'after', frames: 24_000, before: after },
    ])
    return detectDiscontinuities(left).length
  }

  it('output gain jump is smoothed (no click)', () => {
    expect(transitionClicks(cleanBloom(SR, { outputGain: 1 }), (c) => c.setPatch(cleanBloom(SR, { outputGain: 0 })))).toBe(0)
  })

  it('position jump only affects new grains (no click)', () => {
    expect(transitionClicks(cleanBloom(SR, { position: 0.1 }), (c) => c.setPatch(cleanBloom(SR, { position: 0.9 })))).toBe(0)
  })

  it('density sparse -> dense responds without a burst click', () => {
    expect(transitionClicks(cleanBloom(SR, { densityHz: 0.5 }), (c) => c.setPatch(cleanBloom(SR, { densityHz: 60 })))).toBe(0)
  })

  it('mode bloom -> shatter fades through silence (no click)', () => {
    expect(transitionClicks(cleanBloom(SR), (c) => c.setPatch(cleanBloom(SR, { mode: 'shatter', bpm: 140 })))).toBe(0)
  })

  it('space (reverb) toggle off resets at ~0 wet (no click)', () => {
    expect(transitionClicks(cleanBloom(SR, { space: 1 }), (c) => c.setPatch(cleanBloom(SR, { space: 0 })))).toBe(0)
  })

  it('seed change does not click', () => {
    expect(transitionClicks(cleanBloom(SR, { seed: 1 }), (c) => c.setPatch(cleanBloom(SR, { seed: 999 })))).toBe(0)
  })

  it('BPM change with Repeat engaged crossfades the delay read head (no click) [delay fix]', () => {
    // Regression for the TempoDelay read-head crossfade: before the fix the
    // delay tap jumped on the BPM-driven time change and clicked.
    expect(transitionClicks(
      cleanBloom(SR, { repeat: 0.85, bpm: 60 }),
      (c) => c.setPatch(cleanBloom(SR, { repeat: 0.85, bpm: 180 })),
    )).toBe(0)
  })
})

describe('artifact audit — finite / bounded / sane invariants', () => {
  it('stays finite, bounded and DC-light across rates, sources and adversarial FX', () => {
    for (const sr of RATES) {
      const sources: [string, Float32Array][] = [
        ['silence', silenceSource(sr)],
        ['dc', dcSource(sr, 0.6)],
        ['sine', sineSource(sr, 220, sr)],
        ['impulse', impulseSource(sr, 8)],
        ['noise', noiseSource(sr)],
      ]
      for (const [name, src] of sources) {
        const core = makeCore(sr, {
          ...DEFAULT_PATCH,
          densityHz: 60,
          grainSizeMs: 400,
          drive: 1, crush: 1, damp: 1, space: 1, repeat: 0.85,
          tapeAmount: 1, formantAmount: 1, ringModAmount: 1, ringModHz: 300,
          wowAmount: 1, combAmount: 1, combFreq: 300, subAmount: 1,
          outputGain: 1,
        }, src)
        core.setActiveNotes([0, 4, 7, 12, 16, 19, 24, 28].map((offset) => ({ offset, velocity: 1 })))
        const { left, right } = renderSteady(core, sr >> 1)
        const sL = analyzeSignal(left)
        const sR = analyzeSignal(right)
        const tag = `${name} @${sr}`
        expect(sL.nonFiniteCount, tag).toBe(0)
        expect(sR.nonFiniteCount, tag).toBe(0)
        // Master limiter ceiling is 0.95; allow a hair for float math.
        expect(sL.peak, tag).toBeLessThanOrEqual(0.96)
        expect(sR.peak, tag).toBeLessThanOrEqual(0.96)
        // No runaway DC from the additive sub / rectifiers.
        expect(Math.abs(sL.dcOffset), tag).toBeLessThan(0.05)
        expect(core.activeGrainCount, tag).toBeLessThanOrEqual(64)
      }
    }
  }, 30_000)

  it('pool stays bounded under extreme polyphonic over-demand', () => {
    const sr = 48_000
    const core = makeCore(sr, cleanBloom(sr, { densityHz: 80, grainSizeMs: 2000 }), sineSource(sr, 220, sr))
    core.setActiveNotes([0, 2, 4, 5, 7, 9, 11, 12].map((offset) => ({ offset, velocity: 1 })))
    const { left } = renderSteady(core, sr)
    expect(analyzeSignal(left).nonFiniteCount).toBe(0)
    expect(core.activeGrainCount).toBeLessThanOrEqual(64)
  })
})

describe('artifact audit — KNOWN unfixed artifacts (characterized)', () => {
  const SR = 48_000

  it('region-loop seam: a grain longer than the region steps at the loop point', () => {
    // ROOT CAUSE: grains confined to [regionStart, regionEnd) loop the region when
    // their duration*pitch exceeds the region length. The source value at the seam
    // differs and is generally not at an envelope zero, so hann/smooth windows
    // step (~0.2 raw delta). This is the dominant steady-state crackle on
    // default-shaped patches and is MASKED by reverb. FIX (deferred, musical
    // tradeoff): equal-power loop crossfade or contiguous reads (region as
    // start-window only). If a fix lands, this expectation flips and must update.
    // Short (8000-frame) source so the default region is small enough to wrap a
    // long grain; grain 200 ms (9600 fr) > region (~6720 fr), grain 60 ms does not.
    const src = sineSource(8_000, 220, SR)
    const wrap = makeCore(SR, {
      ...cleanBloom(SR), grainSizeMs: 200, regionStart: 0.08, regionEnd: 0.92,
    }, src)
    const noWrap = makeCore(SR, {
      ...cleanBloom(SR), grainSizeMs: 60, regionStart: 0.08, regionEnd: 0.92,
    }, src)
    const wrapDelta = analyzeSignal(renderSteady(wrap, 96_000).left).maxAdjacentDelta
    const noWrapDelta = analyzeSignal(renderSteady(noWrap, 96_000).left).maxAdjacentDelta
    expect(wrapDelta).toBeGreaterThan(4 * noWrapDelta)
  })

  it('source reset: clearSource() cuts active grains/tails instantly (discontinuity)', () => {
    // ROOT CAUSE: setSource()/clearSource() call GranularCore.reset(), which zeroes
    // active grains and all FX state with no fade-through-silence (unlike the mode
    // switch). Cutting an audible cloud + reverb tail steps the output. FIX
    // (deferred, structural): defer reset until output reaches silence, or fade
    // out before swapping the source.
    const core = makeCore(SR, cleanBloom(SR, { space: 1 }), sineSource(SR, 220, SR))
    const { left } = renderTimeline(core, [
      { label: 'render', frames: 24_000 },
      { label: 'clearSource', frames: 6_000, before: (c) => c.clearSource() },
    ])
    const clicks = detectDiscontinuities(left)
    expect(clicks.some((d) => Math.abs(d.frame - 24_000) <= 4)).toBe(true)
  })
})

describe('artifact audit — intentional transients (documented, NOT clicks to fix)', () => {
  const SR = 48_000

  it('hard window onset/offset steps are intentional character', () => {
    // The "hard" (rectangular) window deliberately jumps 0->1 at onset and 1->0 at
    // offset — a percussive, lo-fi character. These steps are by design.
    const core = makeCore(SR, cleanBloom(SR, { window: 'hard' }), sineSource(SR, 220, SR))
    const clicks = detectDiscontinuities(renderSteady(core, SR).left)
    expect(clicks.length).toBeGreaterThan(0)
  })
})

// Optional: dump diagnostic WAVs for listening. Opt-in via MGRAINS_AUDIT_WAV=1 so
// the normal test run never writes files. Output under /tmp/mgrains-artifact-audit.
describe('artifact audit — optional WAV dump', () => {
  it('writes diagnostic stereo WAVs when MGRAINS_AUDIT_WAV is set', () => {
    if (!process.env.MGRAINS_AUDIT_WAV) return
    const sr = 48_000
    // Default to /tmp/mgrains-artifact-audit; override with MGRAINS_AUDIT_DIR for
    // sandboxes that disallow /tmp. Best-effort: a write failure must not fail the
    // suite (this is a listening aid, not an assertion).
    const dir = process.env.MGRAINS_AUDIT_DIR ?? '/tmp/mgrains-artifact-audit'
    const cases: [string, GranularCore][] = [
      ['default-bloom', makeCore(sr, { ...DEFAULT_PATCH, outputGain: 1 }, sineSource(8_000, 220, sr))],
      ['clean-bloom', makeCore(sr, cleanBloom(sr), sineSource(sr, 220, sr))],
      ['region-wrap', makeCore(sr, { ...cleanBloom(sr), grainSizeMs: 400 }, sineSource(8_000, 220, sr))],
    ]
    try {
      mkdirSync(dir, { recursive: true })
      for (const [name, core] of cases) {
        const { left, right } = renderSteady(core, sr * 2)
        writeFileSync(`${dir}/${name}.wav`, encodeWavStereo(left, right, sr))
      }
    } catch (error) {
      console.warn(`[artifact-audit] WAV dump skipped (${(error as Error).message}). Set MGRAINS_AUDIT_DIR to a writable path.`)
    }
  })
})

// Minimal 16-bit PCM stereo WAV encoder (test-only; never imported by the app).
function encodeWavStereo(left: Float32Array, right: Float32Array, sampleRate: number): Buffer {
  const frames = Math.min(left.length, right.length)
  const blockAlign = 4 // 2 channels * 16-bit
  const dataBytes = frames * blockAlign
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20) // PCM
  buffer.writeUInt16LE(2, 22) // channels
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * blockAlign, 28)
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataBytes, 40)
  let offset = 44
  for (let i = 0; i < frames; i += 1) {
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(left[i] * 32767))), offset)
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(right[i] * 32767))), offset + 2)
    offset += 4
  }
  return buffer
}

describe('artifact audit — per-grain filter engaged', () => {
  it('clean bloom with the filter on renders click-free and bounded (all rates)', () => {
    for (const sr of RATES) {
      const core = makeCore(
        sr,
        cleanBloom(sr, { grainFilterHz: 800, grainFilterSpread: 1 }),
        noiseSource(sr, sr),
      )
      const { left, right } = renderSteady(core, sr)
      expect(detectDiscontinuities(left), `left @${sr}`).toHaveLength(0)
      expect(detectDiscontinuities(right), `right @${sr}`).toHaveLength(0)
      const stats = analyzeSignal(left)
      expect(stats.nonFiniteCount).toBe(0)
      expect(stats.peak).toBeLessThanOrEqual(1)
    }
  }, 30_000)
})
