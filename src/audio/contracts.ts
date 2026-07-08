export type GrainMode = 'bloom' | 'shatter'

export type AudioSourceMode = 'sample' | 'live'

export type GrainWindow = 'hann' | 'percussive' | 'hard' | 'reverse' | 'morph'

// Scale mask for per-grain pitch scatter. 'off' leaves the chromatic-random
// spread untouched; every other value snaps each grain's random offset to the
// nearest degree of that scale, turning detuned smear into harmony.
export type PitchScale =
  | 'off'
  | 'octaves'
  | 'fifths'
  | 'major'
  | 'minor'
  | 'majorPent'
  | 'minorPent'

// Pitch classes (semitone offsets within an octave) for each scale mask. Frozen
// so the engine can read them allocation-free on the audio thread.
export const SCALE_MASKS: Readonly<Record<Exclude<PitchScale, 'off'>, readonly number[]>> =
  Object.freeze({
    octaves: [0],
    fifths: [0, 7],
    major: [0, 2, 4, 5, 7, 9, 11],
    minor: [0, 2, 3, 5, 7, 8, 10],
    majorPent: [0, 2, 4, 7, 9],
    minorPent: [0, 3, 5, 7, 10],
  })

export const PITCH_SCALES = ['off', 'octaves', 'fifths', 'major', 'minor', 'majorPent', 'minorPent'] as const

export type LfoShape = 'sine' | 'tri' | 'saw' | 'sh' | 'drift'
export type LfoSync = 'free' | 'link'
export type LfoTarget =
  | 'none'
  | 'position'
  | 'grainSizeMs'
  | 'densityHz'
  | 'spray'
  | 'pitchSpreadSemitones'

export const LFO_SHAPES = ['sine', 'tri', 'saw', 'sh', 'drift'] as const
export const LFO_TARGETS = ['none', 'position', 'grainSizeMs', 'densityHz', 'spray', 'pitchSpreadSemitones'] as const

// One assignable low-frequency modulator. `depth` is a normalized 0..1 fraction
// of the target parameter's full range; `bipolar` centers the swing on the base
// value, otherwise it only adds. `sync` picks between a free rate in Hz and a
// tempo division (from SHATTER_DIVISIONS) locked to the patch BPM.
export interface LfoConfig {
  shape: LfoShape
  sync: LfoSync
  rateHz: number
  division: ShatterDivision
  depth: number
  target: LfoTarget
  bipolar: boolean
  phase: number
}

export const LFO_COUNT = 2

export const SHATTER_DIVISIONS = [
  '1/4',
  '1/8D',
  '1/8',
  '1/8T',
  '1/16D',
  '1/16',
  '1/16T',
  '1/32',
  '1/32T',
  '1/64',
] as const

export type ShatterDivision = typeof SHATTER_DIVISIONS[number]

export interface ShatterStep {
  enabled: boolean
  probability: number
  pitchOffsetSemitones: number
  reverse: boolean
  ratchet: 1 | 2 | 3 | 4
  // v1.7.0 slice fields — RELATIVE to the live dials:
  // positionOffset offsets the live Position dial (−0.5..+0.5), applied after
  // spray and before region wrap. sizeScale multiplies the live Size dial
  // (0.25..4), applied before durationFrames so gain normalization stays honest.
  positionOffset: number
  sizeScale: number
}

export interface GrainPatch {
  schemaVersion: 1
  mode: GrainMode
  grainSizeMs: number
  densityHz: number
  position: number
  regionStart: number
  regionEnd: number
  spray: number
  timingJitter: number
  scanSpeed: number
  pitchSemitones: number
  pitchSpreadSemitones: number
  pitchQuantize: PitchScale
  pitchBendRange: number
  glideTime: number
  reverseProbability: number
  stereoSpread: number
  window: GrainWindow
  windowSkew: number
  windowHardness: number
  inputGain: number
  outputGain: number
  drive: number
  crush: number
  damp: number
  space: number
  repeat: number
  repeatDivision: ShatterDivision
  repeatFeedback: number
  tapeAmount: number
  tapeTone: number
  formantAmount: number
  formantVowel: number
  ringModAmount: number
  ringModHz: number
  wowAmount: number
  wowRate: number
  combAmount: number
  combFreq: number
  subAmount: number
  subTune: number
  seed: number
  bpm: number
  shatterDivision: ShatterDivision
  shatterSwing: number
  shatterSteps: ShatterStep[]
  lfos: LfoConfig[]
}

export const DEFAULT_LFO: Readonly<LfoConfig> = Object.freeze({
  shape: 'sine',
  sync: 'free',
  rateHz: 0.25,
  division: '1/4',
  depth: 0,
  target: 'none',
  bipolar: true,
  phase: 0,
})

export const DEFAULT_SHATTER_STEPS: ReadonlyArray<Readonly<ShatterStep>> = Object.freeze(
  Array.from({ length: 16 }, (_, index): Readonly<ShatterStep> => Object.freeze({
    enabled: ![2, 5, 7, 10, 12, 15].includes(index),
    probability: index === 14 ? 0.65 : 1,
    pitchOffsetSemitones: index === 6 ? 12 : index === 11 ? -12 : 0,
    reverse: index === 3 || index === 13,
    ratchet: index === 9 ? 2 : 1,
    positionOffset: 0,
    sizeScale: 1,
  })),
)

export const DEFAULT_PATCH: GrainPatch = Object.freeze({
  schemaVersion: 1,
  mode: 'bloom',
  grainSizeMs: 180,
  densityHz: 14,
  position: 0.42,
  regionStart: 0.08,
  regionEnd: 0.92,
  spray: 0.12,
  timingJitter: 0.06,
  scanSpeed: 0.01,
  pitchSemitones: 0,
  pitchSpreadSemitones: 0.12,
  pitchQuantize: 'off',
  pitchBendRange: 2,
  glideTime: 0,
  reverseProbability: 0.08,
  stereoSpread: 0.72,
  window: 'hann',
  windowSkew: 0,
  windowHardness: 0,
  inputGain: 1,
  outputGain: 0.72,
  drive: 0,
  crush: 0,
  damp: 0,
  space: 0,
  repeat: 0,
  repeatDivision: '1/8D',
  repeatFeedback: 0.5,
  tapeAmount: 0,
  tapeTone: 0.5,
  formantAmount: 0,
  formantVowel: 0,
  ringModAmount: 0,
  ringModHz: 440,
  wowAmount: 0,
  wowRate: 5,
  combAmount: 0,
  combFreq: 220,
  subAmount: 0,
  subTune: 55,
  seed: 0x6d677261,
  bpm: 120,
  shatterDivision: '1/16',
  shatterSwing: 0,
  shatterSteps: DEFAULT_SHATTER_STEPS.map((step) => ({ ...step })),
  lfos: [{ ...DEFAULT_LFO }, { ...DEFAULT_LFO }],
})

export const PATCH_RANGES = Object.freeze({
  grainSizeMs: [5, 4000] as const,
  densityHz: [0.25, 80] as const,
  position: [0, 1] as const,
  spray: [0, 1] as const,
  timingJitter: [0, 1] as const,
  scanSpeed: [-2, 2] as const,
  pitchSemitones: [-36, 36] as const,
  pitchSpreadSemitones: [0, 24] as const,
  pitchBendRange: [0, 24] as const,
  glideTime: [0, 2] as const,
  reverseProbability: [0, 1] as const,
  stereoSpread: [0, 1] as const,
  windowSkew: [-1, 1] as const,
  windowHardness: [0, 1] as const,
  inputGain: [0, 2] as const,
  outputGain: [0, 1] as const,
  drive: [0, 1] as const,
  crush: [0, 1] as const,
  damp: [0, 1] as const,
  space: [0, 1] as const,
  repeat: [0, 1] as const,
  repeatFeedback: [0, 1] as const,
  tapeAmount: [0, 1] as const,
  tapeTone: [0, 1] as const,
  formantAmount: [0, 1] as const,
  formantVowel: [0, 1] as const,
  ringModAmount: [0, 1] as const,
  ringModHz: [1, 4000] as const,
  wowAmount: [0, 1] as const,
  wowRate: [0.1, 8] as const,
  combAmount: [0, 1] as const,
  combFreq: [20, 4000] as const,
  subAmount: [0, 1] as const,
  subTune: [30, 120] as const,
  bpm: [30, 300] as const,
  shatterSwing: [0, 0.6] as const,
})

// LFO field ranges are kept out of PATCH_RANGES because they are per-LFO, not
// top-level patch fields (tooling treats every PATCH_RANGES key as a patch key).
export const LFO_RANGES = Object.freeze({
  rateHz: [0.01, 20] as const,
  depth: [0, 1] as const,
})

// Parameters surfaced in the Advanced panel rather than on the main performance
// surface. A single source of truth so the panel and its reset never drift apart.
export const ADVANCED_PARAM_KEYS = [
  'regionStart',
  'regionEnd',
  'timingJitter',
  'scanSpeed',
  'pitchSemitones',
  'pitchSpreadSemitones',
  'reverseProbability',
  'stereoSpread',
  'window',
  'outputGain',
] as const satisfies ReadonlyArray<keyof GrainPatch>

export interface EngineTelemetry {
  type: 'telemetry'
  frame: number
  activeGrains: number
  peak: number
  sourceMode: AudioSourceMode
  liveBufferSeconds: number
  frozen: boolean
  shatterStep: number
  visualGrainCount: number
  grainPositions: Float32Array
  grainIntensities: Float32Array
}

export type EngineToMainMessage = EngineTelemetry

export type MainToEngineMessage =
  | { type: 'set-patch'; patch: GrainPatch }
  | { type: 'set-source'; channels: [Float32Array, Float32Array] }
  | { type: 'set-source-mode'; mode: AudioSourceMode }
  | { type: 'set-freeze'; frozen: boolean }
  | { type: 'clear-live-buffer' }
  | { type: 'clear-source' }
  | { type: 'set-notes'; notes: { offset: number; velocity: number }[] }
  | { type: 'set-pitch-bend'; semitones: number }
  // When gated, grains only spawn while a note is held (no autonomous drone).
  | { type: 'set-gate-to-notes'; gated: boolean }
  | { type: 'reset'; seed?: number }
  // Ableton Link bar alignment: land shatter step 0 on the shared downbeat at this
  // AudioContext timestamp (the shared audio clock). The worklet maps it to the
  // engine's frame counter via its own currentTime.
  | { type: 'align-shatter'; time: number }

export function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum
  return Math.min(maximum, Math.max(minimum, value))
}

export function sanitizePatch(candidate: GrainPatch): GrainPatch {
  const regionStart = clamp(candidate.regionStart, 0, 0.999)
  const regionEnd = clamp(candidate.regionEnd, regionStart + 0.001, 1)

  return {
    schemaVersion: 1,
    mode: candidate.mode === 'shatter' ? 'shatter' : 'bloom',
    grainSizeMs: clamp(candidate.grainSizeMs, ...PATCH_RANGES.grainSizeMs),
    densityHz: clamp(candidate.densityHz, ...PATCH_RANGES.densityHz),
    position: clamp(candidate.position, ...PATCH_RANGES.position),
    regionStart,
    regionEnd,
    spray: clamp(candidate.spray, ...PATCH_RANGES.spray),
    timingJitter: clamp(candidate.timingJitter, ...PATCH_RANGES.timingJitter),
    scanSpeed: clamp(candidate.scanSpeed, ...PATCH_RANGES.scanSpeed),
    pitchSemitones: clamp(candidate.pitchSemitones, ...PATCH_RANGES.pitchSemitones),
    pitchSpreadSemitones: clamp(
      candidate.pitchSpreadSemitones,
      ...PATCH_RANGES.pitchSpreadSemitones,
    ),
    pitchQuantize: PITCH_SCALES.includes(candidate.pitchQuantize)
      ? candidate.pitchQuantize
      : 'off',
    pitchBendRange: Number.isFinite(candidate.pitchBendRange)
      ? clamp(candidate.pitchBendRange, ...PATCH_RANGES.pitchBendRange)
      : DEFAULT_PATCH.pitchBendRange,
    glideTime: clamp(candidate.glideTime, ...PATCH_RANGES.glideTime),
    reverseProbability: clamp(candidate.reverseProbability, ...PATCH_RANGES.reverseProbability),
    stereoSpread: clamp(candidate.stereoSpread, ...PATCH_RANGES.stereoSpread),
    window: ['hann', 'percussive', 'hard', 'reverse', 'morph'].includes(candidate.window)
      ? candidate.window
      : 'hann',
    windowSkew: clamp(candidate.windowSkew, ...PATCH_RANGES.windowSkew),
    windowHardness: clamp(candidate.windowHardness, ...PATCH_RANGES.windowHardness),
    // Missing (old preset) → unity so the source is unchanged.
    inputGain: Number.isFinite(candidate.inputGain)
      ? clamp(candidate.inputGain, ...PATCH_RANGES.inputGain)
      : DEFAULT_PATCH.inputGain,
    outputGain: clamp(candidate.outputGain, ...PATCH_RANGES.outputGain),
    drive: clamp(candidate.drive, ...PATCH_RANGES.drive),
    crush: clamp(candidate.crush, ...PATCH_RANGES.crush),
    damp: clamp(candidate.damp, ...PATCH_RANGES.damp),
    space: clamp(candidate.space, ...PATCH_RANGES.space),
    repeat: clamp(candidate.repeat, ...PATCH_RANGES.repeat),
    repeatDivision: SHATTER_DIVISIONS.includes(candidate.repeatDivision)
      ? candidate.repeatDivision
      : DEFAULT_PATCH.repeatDivision,
    // Back-compat: presets from before the send/feedback split carry only
    // `repeat`, which conflated both. Reproduce their exact loop gain
    // (repeat * 0.85, capped) so old patches sound identical.
    repeatFeedback: Number.isFinite(candidate.repeatFeedback)
      ? clamp(candidate.repeatFeedback, ...PATCH_RANGES.repeatFeedback)
      : Math.min(0.95, clamp(candidate.repeat, ...PATCH_RANGES.repeat) * 0.85),
    tapeAmount: clamp(candidate.tapeAmount, ...PATCH_RANGES.tapeAmount),
    tapeTone: clamp(candidate.tapeTone, ...PATCH_RANGES.tapeTone),
    formantAmount: clamp(candidate.formantAmount, ...PATCH_RANGES.formantAmount),
    formantVowel: clamp(candidate.formantVowel, ...PATCH_RANGES.formantVowel),
    ringModAmount: clamp(candidate.ringModAmount, ...PATCH_RANGES.ringModAmount),
    ringModHz: clamp(candidate.ringModHz, ...PATCH_RANGES.ringModHz),
    wowAmount: clamp(candidate.wowAmount, ...PATCH_RANGES.wowAmount),
    wowRate: clamp(candidate.wowRate, ...PATCH_RANGES.wowRate),
    combAmount: clamp(candidate.combAmount, ...PATCH_RANGES.combAmount),
    combFreq: clamp(candidate.combFreq, ...PATCH_RANGES.combFreq),
    subAmount: clamp(candidate.subAmount, ...PATCH_RANGES.subAmount),
    subTune: clamp(candidate.subTune, ...PATCH_RANGES.subTune),
    seed: Number.isFinite(candidate.seed) ? candidate.seed >>> 0 : DEFAULT_PATCH.seed,
    bpm: clamp(candidate.bpm, ...PATCH_RANGES.bpm),
    shatterDivision: SHATTER_DIVISIONS.includes(candidate.shatterDivision)
      ? candidate.shatterDivision
      : DEFAULT_PATCH.shatterDivision,
    shatterSwing: Number.isFinite(candidate.shatterSwing)
      ? clamp(candidate.shatterSwing, ...PATCH_RANGES.shatterSwing)
      : DEFAULT_PATCH.shatterSwing,
    shatterSteps: sanitizeShatterSteps(candidate.shatterSteps),
    lfos: sanitizeLfos(candidate.lfos),
  }
}

function sanitizeLfos(candidate: LfoConfig[] | undefined): LfoConfig[] {
  const source = Array.isArray(candidate) ? candidate : []
  return Array.from({ length: LFO_COUNT }, (_, index) => {
    const lfo = source[index]
    if (!lfo) return { ...DEFAULT_LFO }
    return {
      shape: LFO_SHAPES.includes(lfo.shape) ? lfo.shape : DEFAULT_LFO.shape,
      sync: lfo.sync === 'link' ? 'link' : 'free',
      rateHz: clamp(lfo.rateHz, ...LFO_RANGES.rateHz),
      division: SHATTER_DIVISIONS.includes(lfo.division) ? lfo.division : DEFAULT_LFO.division,
      depth: clamp(lfo.depth, ...LFO_RANGES.depth),
      target: LFO_TARGETS.includes(lfo.target) ? lfo.target : 'none',
      bipolar: lfo.bipolar !== false,
      phase: Number.isFinite(lfo.phase) ? ((lfo.phase % 1) + 1) % 1 : 0,
    }
  })
}

// Reset only the advanced parameters to their defaults, leaving the main
// performance controls (mode, grain size, density, position, spray, transport,
// and the Shatter lane) untouched. Sanitized so region ordering stays valid.
export function resetAdvancedToDefault(patch: GrainPatch): GrainPatch {
  const next: GrainPatch = { ...patch }
  for (const key of ADVANCED_PARAM_KEYS) {
    Object.assign(next, { [key]: DEFAULT_PATCH[key] })
  }
  return sanitizePatch(next)
}

function sanitizeShatterSteps(candidate: ShatterStep[]): ShatterStep[] {
  const steps = Array.isArray(candidate) ? candidate : DEFAULT_SHATTER_STEPS
  return Array.from({ length: 16 }, (_, index) => {
    const fallback = DEFAULT_SHATTER_STEPS[index]
    const step = steps[index] ?? fallback
    const ratchet = Number.isFinite(step.ratchet)
      ? Math.round(clamp(step.ratchet, 1, 4)) as ShatterStep['ratchet']
      : fallback.ratchet
    return {
      enabled: step.enabled === true,
      probability: clamp(step.probability, 0, 1),
      pitchOffsetSemitones: Math.round(clamp(step.pitchOffsetSemitones, -24, 24)),
      reverse: step.reverse === true,
      ratchet,
      positionOffset: Number.isFinite(step.positionOffset)
        ? clamp(step.positionOffset, -0.5, 0.5)
        : 0,
      sizeScale: Number.isFinite(step.sizeScale)
        ? clamp(step.sizeScale, 0.25, 4)
        : 1,
    }
  })
}
