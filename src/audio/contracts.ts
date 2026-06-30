export type GrainMode = 'bloom' | 'shatter'

export type AudioSourceMode = 'sample' | 'live'

export type GrainWindow = 'hann' | 'percussive' | 'hard' | 'reverse'

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
  reverseProbability: number
  stereoSpread: number
  window: GrainWindow
  outputGain: number
  drive: number
  crush: number
  damp: number
  space: number
  repeat: number
  tapeAmount: number
  tapeTone: number
  formantAmount: number
  formantVowel: number
  ringModAmount: number
  ringModHz: number
  seed: number
  bpm: number
  shatterDivision: ShatterDivision
  shatterSteps: ShatterStep[]
}

export const DEFAULT_SHATTER_STEPS: ReadonlyArray<Readonly<ShatterStep>> = Object.freeze(
  Array.from({ length: 16 }, (_, index): Readonly<ShatterStep> => Object.freeze({
    enabled: ![2, 5, 7, 10, 12, 15].includes(index),
    probability: index === 14 ? 0.65 : 1,
    pitchOffsetSemitones: index === 6 ? 12 : index === 11 ? -12 : 0,
    reverse: index === 3 || index === 13,
    ratchet: index === 9 ? 2 : 1,
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
  reverseProbability: 0.08,
  stereoSpread: 0.72,
  window: 'hann',
  outputGain: 0.72,
  drive: 0,
  crush: 0,
  damp: 0,
  space: 0,
  repeat: 0,
  tapeAmount: 0,
  tapeTone: 0.5,
  formantAmount: 0,
  formantVowel: 0,
  ringModAmount: 0,
  ringModHz: 440,
  seed: 0x6d677261,
  bpm: 120,
  shatterDivision: '1/16',
  shatterSteps: DEFAULT_SHATTER_STEPS.map((step) => ({ ...step })),
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
  reverseProbability: [0, 1] as const,
  stereoSpread: [0, 1] as const,
  outputGain: [0, 1] as const,
  drive: [0, 1] as const,
  crush: [0, 1] as const,
  damp: [0, 1] as const,
  space: [0, 1] as const,
  repeat: [0, 1] as const,
  tapeAmount: [0, 1] as const,
  tapeTone: [0, 1] as const,
  formantAmount: [0, 1] as const,
  formantVowel: [0, 1] as const,
  ringModAmount: [0, 1] as const,
  ringModHz: [1, 4000] as const,
  bpm: [30, 300] as const,
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
  | { type: 'reset'; seed?: number }

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
    reverseProbability: clamp(candidate.reverseProbability, ...PATCH_RANGES.reverseProbability),
    stereoSpread: clamp(candidate.stereoSpread, ...PATCH_RANGES.stereoSpread),
    window: ['hann', 'percussive', 'hard', 'reverse'].includes(candidate.window)
      ? candidate.window
      : 'hann',
    outputGain: clamp(candidate.outputGain, ...PATCH_RANGES.outputGain),
    drive: clamp(candidate.drive, ...PATCH_RANGES.drive),
    crush: clamp(candidate.crush, ...PATCH_RANGES.crush),
    damp: clamp(candidate.damp, ...PATCH_RANGES.damp),
    space: clamp(candidate.space, ...PATCH_RANGES.space),
    repeat: clamp(candidate.repeat, ...PATCH_RANGES.repeat),
    tapeAmount: clamp(candidate.tapeAmount, ...PATCH_RANGES.tapeAmount),
    tapeTone: clamp(candidate.tapeTone, ...PATCH_RANGES.tapeTone),
    formantAmount: clamp(candidate.formantAmount, ...PATCH_RANGES.formantAmount),
    formantVowel: clamp(candidate.formantVowel, ...PATCH_RANGES.formantVowel),
    ringModAmount: clamp(candidate.ringModAmount, ...PATCH_RANGES.ringModAmount),
    ringModHz: clamp(candidate.ringModHz, ...PATCH_RANGES.ringModHz),
    seed: Number.isFinite(candidate.seed) ? candidate.seed >>> 0 : DEFAULT_PATCH.seed,
    bpm: clamp(candidate.bpm, ...PATCH_RANGES.bpm),
    shatterDivision: SHATTER_DIVISIONS.includes(candidate.shatterDivision)
      ? candidate.shatterDivision
      : DEFAULT_PATCH.shatterDivision,
    shatterSteps: sanitizeShatterSteps(candidate.shatterSteps),
  }
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
    }
  })
}
