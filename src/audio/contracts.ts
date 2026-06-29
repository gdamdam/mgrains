export type GrainMode = 'bloom' | 'shatter'

export type GrainWindow = 'hann' | 'percussive' | 'hard' | 'reverse'

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
  seed: number
}

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
  seed: 0x6d677261,
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
})

export interface EngineTelemetry {
  type: 'telemetry'
  frame: number
  activeGrains: number
  peak: number
}

export type EngineToMainMessage = EngineTelemetry

export type MainToEngineMessage =
  | { type: 'set-patch'; patch: GrainPatch }
  | { type: 'set-source'; channels: [Float32Array, Float32Array] }
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
    seed: Number.isFinite(candidate.seed) ? candidate.seed >>> 0 : DEFAULT_PATCH.seed,
  }
}
