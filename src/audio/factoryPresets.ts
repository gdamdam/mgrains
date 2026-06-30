import {
  DEFAULT_SHATTER_STEPS,
  type GrainMode,
  type GrainPatch,
  type ShatterStep,
} from './contracts'

// Curated factory presets. Each entry is a PARTIAL patch meant to be overlaid
// on DEFAULT_PATCH (only the fields that define its character are listed), then
// run through sanitizePatch by the caller. We intentionally do NOT import the
// storage `Preset` type so this catalogue stays decoupled from persistence —
// it is pure data the rest of the app can adapt as it sees fit.
//
// `sourceHint` names the kind of source material the preset flatters most
// ('any', 'sustained/pad', 'drums/percussive', 'vocal'). Every numeric value
// here already sits inside PATCH_RANGES so sanitizePatch leaves it untouched.

export interface FactoryPreset {
  name: string
  mode: GrainMode
  sourceHint: string
  patch: Partial<GrainPatch>
}

// Build a 16-step Shatter lane from a compact list of overrides. Steps default
// to a plain enabled 1/1 cell; only the fields a preset cares about are set,
// keeping each lane readable while still producing the full 16 cells the engine
// (and the round-trip test) require. Values stay integral and in-range so they
// survive sanitizeShatterSteps unchanged.
function lane(
  overrides: ReadonlyArray<Partial<ShatterStep>>,
): ShatterStep[] {
  return Array.from({ length: 16 }, (_, index): ShatterStep => ({
    enabled: true,
    probability: 1,
    pitchOffsetSemitones: 0,
    reverse: false,
    ratchet: 1,
    ...overrides[index],
  }))
}

// A four-on-the-floor accent lane: hits on the quarter beats, ghosted offbeats.
const TIGHT_STEPS: ShatterStep[] = lane([
  { probability: 1 },
  { enabled: false },
  { probability: 0.5 },
  { enabled: false },
  { probability: 1 },
  { enabled: false },
  { probability: 0.6 },
  { enabled: false },
  { probability: 1 },
  { enabled: false },
  { probability: 0.5, ratchet: 2 },
  { enabled: false },
  { probability: 1 },
  { enabled: false },
  { probability: 0.6 },
  { enabled: false },
])

// Crushed/destructive lane: dense, every cell firing with occasional ratchets
// so the bit-mangled grains pile up into a wall.
const CRUSHED_STEPS: ShatterStep[] = lane([
  {},
  {},
  { ratchet: 2 },
  {},
  {},
  { ratchet: 3 },
  {},
  {},
  {},
  { ratchet: 2 },
  {},
  {},
  { ratchet: 4 },
  {},
  {},
  { probability: 0.8, ratchet: 2 },
])

// Reverse + pitch-ratchet lane: alternating octave/fifth jumps, reversed tails
// and climbing ratchet counts for a tumbling, rewinding feel.
const RATCHET_STEPS: ShatterStep[] = lane([
  { ratchet: 2 },
  { reverse: true },
  { pitchOffsetSemitones: 12, ratchet: 3 },
  { reverse: true },
  { pitchOffsetSemitones: 7 },
  { reverse: true, ratchet: 2 },
  { pitchOffsetSemitones: -12 },
  { reverse: true },
  { pitchOffsetSemitones: 12, ratchet: 4 },
  { reverse: true },
  { pitchOffsetSemitones: 5 },
  { reverse: true, ratchet: 2 },
  { pitchOffsetSemitones: -7, ratchet: 3 },
  { reverse: true },
  { pitchOffsetSemitones: 12, ratchet: 4 },
  { reverse: true, probability: 0.7 },
])

// Glitchy ring-mod/formant lane: sparse, syncopated stabs with the odd reverse
// so the vowel/ring-mod colour reads as deliberate punctuation.
const GLITCH_STEPS: ShatterStep[] = lane([
  { probability: 1 },
  { enabled: false },
  { probability: 0.7, ratchet: 2 },
  { reverse: true },
  { enabled: false },
  { probability: 0.9 },
  { enabled: false },
  { probability: 0.5, ratchet: 3 },
  { probability: 1 },
  { enabled: false },
  { reverse: true, ratchet: 2 },
  { enabled: false },
  { probability: 0.8 },
  { reverse: true },
  { enabled: false },
  { probability: 0.6, ratchet: 2 },
])

// A loosened version of the default lane for the hybrid: keeps the engine's
// musical bones but pulls a couple of cells out so it breathes under the cloud.
const HYBRID_STEPS: ShatterStep[] = DEFAULT_SHATTER_STEPS.map(
  (step, index): ShatterStep => ({
    ...step,
    enabled: index === 4 || index === 8 ? false : step.enabled,
    probability: index === 14 ? 0.5 : step.probability,
  }),
)

export const FACTORY_PRESETS: ReadonlyArray<FactoryPreset> = Object.freeze([
  Object.freeze<FactoryPreset>({
    name: 'Gentle Bloom',
    mode: 'bloom',
    sourceHint: 'any',
    patch: {
      mode: 'bloom',
      grainSizeMs: 220,
      densityHz: 18,
      spray: 0.18,
      stereoSpread: 0.78,
      tapeAmount: 0.12,
    },
  }),
  Object.freeze<FactoryPreset>({
    name: 'Lush Cloud',
    mode: 'bloom',
    sourceHint: 'sustained/pad',
    patch: {
      mode: 'bloom',
      grainSizeMs: 900,
      densityHz: 55,
      spray: 0.55,
      timingJitter: 0.35,
      pitchSpreadSemitones: 7,
      stereoSpread: 0.95,
      space: 0.45,
    },
  }),
  Object.freeze<FactoryPreset>({
    name: 'Frozen Pad',
    mode: 'bloom',
    sourceHint: 'sustained/pad',
    patch: {
      mode: 'bloom',
      grainSizeMs: 1400,
      densityHz: 40,
      scanSpeed: 0,
      spray: 0.04,
      timingJitter: 0.02,
      pitchSpreadSemitones: 0.2,
      stereoSpread: 0.85,
      space: 0.6,
      damp: 0.25,
    },
  }),
  Object.freeze<FactoryPreset>({
    name: 'Drifting Space',
    mode: 'bloom',
    sourceHint: 'sustained/pad',
    patch: {
      mode: 'bloom',
      grainSizeMs: 600,
      densityHz: 30,
      scanSpeed: 0.4,
      spray: 0.5,
      timingJitter: 0.4,
      pitchSpreadSemitones: 5,
      stereoSpread: 1,
      space: 0.85,
    },
  }),
  Object.freeze<FactoryPreset>({
    name: 'Warm Haze',
    mode: 'bloom',
    sourceHint: 'any',
    patch: {
      mode: 'bloom',
      grainSizeMs: 320,
      densityHz: 22,
      spray: 0.22,
      damp: 0.55,
      drive: 0.28,
      tapeAmount: 0.6,
      tapeTone: 0.35,
    },
  }),
  Object.freeze<FactoryPreset>({
    name: 'Tight Stutter',
    mode: 'shatter',
    sourceHint: 'drums/percussive',
    patch: {
      mode: 'shatter',
      grainSizeMs: 70,
      densityHz: 24,
      bpm: 120,
      shatterDivision: '1/16',
      spray: 0.05,
      timingJitter: 0.03,
      shatterSteps: TIGHT_STEPS,
    },
  }),
  Object.freeze<FactoryPreset>({
    name: 'Crush Wall',
    mode: 'shatter',
    sourceHint: 'drums/percussive',
    patch: {
      mode: 'shatter',
      grainSizeMs: 45,
      densityHz: 30,
      bpm: 140,
      shatterDivision: '1/16',
      drive: 0.85,
      crush: 0.8,
      damp: 0.35,
      shatterSteps: CRUSHED_STEPS,
    },
  }),
  Object.freeze<FactoryPreset>({
    name: 'Reverse Ratchet',
    mode: 'shatter',
    sourceHint: 'any',
    patch: {
      mode: 'shatter',
      grainSizeMs: 90,
      densityHz: 20,
      bpm: 128,
      shatterDivision: '1/16',
      reverseProbability: 0.4,
      pitchSpreadSemitones: 2,
      shatterSteps: RATCHET_STEPS,
    },
  }),
  Object.freeze<FactoryPreset>({
    name: 'Glitch Vox',
    mode: 'shatter',
    sourceHint: 'vocal',
    patch: {
      mode: 'shatter',
      grainSizeMs: 60,
      densityHz: 26,
      bpm: 124,
      shatterDivision: '1/16',
      formantAmount: 0.7,
      formantVowel: 0.35,
      ringModAmount: 0.45,
      ringModHz: 320,
      shatterSteps: GLITCH_STEPS,
    },
  }),
  Object.freeze<FactoryPreset>({
    name: 'Dub Bloom',
    mode: 'shatter',
    sourceHint: 'any',
    patch: {
      mode: 'shatter',
      grainSizeMs: 260,
      densityHz: 16,
      bpm: 90,
      shatterDivision: '1/8',
      space: 0.55,
      repeat: 0.65,
      damp: 0.4,
      tapeAmount: 0.4,
      stereoSpread: 0.9,
      shatterSteps: HYBRID_STEPS,
    },
  }),
])
