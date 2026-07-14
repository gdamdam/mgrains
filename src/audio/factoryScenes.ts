import {
  type GrainMode,
  type GrainPatch,
  type ShatterStep,
} from './contracts'

// Curated factory SCENES. A scene binds a generated source (`sourceId`, see
// DEMO_SOURCES in demoSource.ts) to a PARTIAL patch overlaid on DEFAULT_PATCH
// (only the fields that define its character are listed), then run through
// sanitizePatch by the caller. Loading a scene switches BOTH the source and the
// patch, so two scenes on the SAME source (e.g. the two "Voice —" scenes) prove
// the transformation is mgrains, not the sample.
//
// We intentionally do NOT import the storage `Preset` type so this catalogue
// stays decoupled from persistence — it is pure data the rest of the app adapts.
// Every numeric value here already sits inside PATCH_RANGES so sanitizePatch
// leaves it untouched, and every `outputGain` is kept conservative (<= 0.74)
// so no scene loads unexpectedly loud. Scenes carry no randomness beyond the
// deterministic source generators, so first load is always reproducible.

export interface FactoryScene {
  // Stable id used by the UI selector and session/preset round-trips.
  id: string
  // Evocative but honest name reflecting audible behaviour ("Category — Name").
  name: string
  // Generated source this scene loads (must be a DEMO_SOURCES id).
  sourceId: string
  // Which mode the scene runs in (kept consistent with patch.mode).
  mode: GrainMode
  // One line on what this scene demonstrates.
  description: string
  patch: Partial<GrainPatch>
}

// Build a 16-step Shatter lane from a compact list of overrides. Steps default
// to a plain enabled 1/1 cell; only the fields a scene cares about are set,
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
    positionOffset: 0,
    sizeScale: 1,
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

// Sparse, swung syncopation for a stumbling "broken clock" feel: off-grid
// accents and the odd ghosted double, leaving plenty of silence between hits.
const BROKEN_STEPS: ShatterStep[] = lane([
  { probability: 1 },
  { enabled: false },
  { enabled: false },
  { probability: 0.7, ratchet: 2 },
  { enabled: false },
  { probability: 1 },
  { enabled: false },
  { enabled: false },
  { probability: 0.8 },
  { enabled: false },
  { probability: 0.5 },
  { enabled: false },
  { enabled: false },
  { probability: 1, ratchet: 2 },
  { enabled: false },
  { probability: 0.4 },
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

// Fast, dense machine-gun ratchets: every cell firing with climbing ratchet
// counts and a couple of reversed cells for stutter — a percussive wall.
const RAPID_STEPS: ShatterStep[] = lane([
  { ratchet: 2 },
  { ratchet: 2 },
  { ratchet: 3 },
  { ratchet: 2 },
  { ratchet: 4 },
  { ratchet: 2 },
  { reverse: true, ratchet: 3 },
  { ratchet: 2 },
  { ratchet: 3 },
  { ratchet: 2 },
  { ratchet: 4 },
  { ratchet: 2 },
  { reverse: true, ratchet: 3 },
  { ratchet: 2 },
  { ratchet: 4 },
  { probability: 0.9, ratchet: 3 },
])

export const FACTORY_SCENES: ReadonlyArray<FactoryScene> = Object.freeze([
  // ── Voice ──────────────────────────────────────────────────────────────
  Object.freeze<FactoryScene>({
    id: 'voice-frozen-choir',
    name: 'Voice — Frozen Choir',
    sourceId: 'vowel-choir',
    mode: 'bloom',
    description: 'Huge, near-static grains freeze the choir into a suspended, breathing chord.',
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
      outputGain: 0.7,
    },
  }),
  Object.freeze<FactoryScene>({
    id: 'voice-glitch-prayer',
    name: 'Voice — Glitch Prayer',
    sourceId: 'vowel-choir',
    mode: 'shatter',
    description: 'The SAME choir, chopped into syncopated ring-mod/formant stabs — proof it is the engine, not the sample.',
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
      outputGain: 0.68,
    },
  }),
  Object.freeze<FactoryScene>({
    id: 'voice-vowel-tide',
    name: 'Voice — Vowel Tide',
    sourceId: 'formant-drone',
    mode: 'bloom',
    description: 'A slow scan drifts through the drone, revealing vowels that wash in and out.',
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
      outputGain: 0.7,
    },
  }),
  // ── Bell ───────────────────────────────────────────────────────────────
  Object.freeze<FactoryScene>({
    id: 'bell-spectral-rain',
    name: 'Bell — Spectral Rain',
    sourceId: 'glass-bells',
    mode: 'bloom',
    description: 'Sparse, wide-sprayed grains scatter the bell into pentatonic droplets over reverb.',
    patch: {
      mode: 'bloom',
      grainSizeMs: 260,
      densityHz: 8,
      spray: 0.7,
      timingJitter: 0.5,
      pitchSpreadSemitones: 7,
      pitchQuantize: 'majorPent',
      stereoSpread: 0.95,
      space: 0.6,
      outputGain: 0.7,
    },
  }),
  Object.freeze<FactoryScene>({
    id: 'bell-broken-music-box',
    name: 'Bell — Broken Music Box',
    sourceId: 'glass-bells',
    mode: 'shatter',
    description: 'The same bell, tumbling in reversed octave/fifth ratchets like a wound-down music box.',
    patch: {
      mode: 'shatter',
      grainSizeMs: 90,
      densityHz: 20,
      bpm: 128,
      shatterDivision: '1/16',
      reverseProbability: 0.4,
      pitchSpreadSemitones: 2,
      shatterSteps: RATCHET_STEPS,
      outputGain: 0.68,
    },
  }),
  // ── Pluck ──────────────────────────────────────────────────────────────
  Object.freeze<FactoryScene>({
    id: 'pluck-wooden-rain',
    name: 'Pluck — Wooden Rain',
    sourceId: 'mallet-pulse',
    mode: 'bloom',
    description: 'Dense overlapping grains smear the mallet hits into a lush, pitched downpour.',
    patch: {
      mode: 'bloom',
      grainSizeMs: 900,
      densityHz: 55,
      spray: 0.55,
      timingJitter: 0.35,
      pitchSpreadSemitones: 7,
      stereoSpread: 0.95,
      space: 0.45,
      outputGain: 0.66,
    },
  }),
  Object.freeze<FactoryScene>({
    id: 'pluck-music-box-stutter',
    name: 'Pluck — Music Box Stutter',
    sourceId: 'mallet-pulse',
    mode: 'shatter',
    description: 'Tight four-on-the-floor slices turn the mallets into a crisp, gated pattern.',
    patch: {
      mode: 'shatter',
      grainSizeMs: 70,
      densityHz: 24,
      bpm: 120,
      shatterDivision: '1/16',
      spray: 0.05,
      timingJitter: 0.03,
      shatterSteps: TIGHT_STEPS,
      outputGain: 0.7,
    },
  }),
  // ── Percussion ─────────────────────────────────────────────────────────
  Object.freeze<FactoryScene>({
    id: 'percussion-broken-clock',
    name: 'Percussion — Broken Clock',
    sourceId: 'clave-seq',
    mode: 'shatter',
    description: 'Swung, sparse hits stumble off the grid — a clock that never quite keeps time.',
    patch: {
      mode: 'shatter',
      grainSizeMs: 55,
      densityHz: 22,
      bpm: 96,
      shatterDivision: '1/16',
      shatterSwing: 0.22,
      drive: 0.2,
      shatterSteps: BROKEN_STEPS,
      outputGain: 0.72,
    },
  }),
  Object.freeze<FactoryScene>({
    id: 'percussion-crush-wall',
    name: 'Percussion — Crush Wall',
    sourceId: 'clave-seq',
    mode: 'shatter',
    description: 'The same clicks driven and bit-crushed into a dense, distorted wall.',
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
      outputGain: 0.6,
    },
  }),
  // ── Field ──────────────────────────────────────────────────────────────
  Object.freeze<FactoryScene>({
    id: 'field-moving-landscape',
    name: 'Field — Moving Landscape',
    sourceId: 'noise-bed',
    mode: 'bloom',
    description: 'A slow scan and wow drift the noise bed like wind moving across an open field.',
    patch: {
      mode: 'bloom',
      grainSizeMs: 500,
      densityHz: 26,
      scanSpeed: 0.3,
      spray: 0.5,
      damp: 0.5,
      wowAmount: 0.3,
      wowRate: 1.5,
      stereoSpread: 1,
      space: 0.4,
      outputGain: 0.7,
    },
  }),
  Object.freeze<FactoryScene>({
    id: 'field-static-storm',
    name: 'Field — Static Storm',
    sourceId: 'noise-bed',
    mode: 'shatter',
    description: 'The same bed torn into driven, crushed bursts — turbulent and unstable.',
    patch: {
      mode: 'shatter',
      grainSizeMs: 40,
      densityHz: 30,
      bpm: 132,
      shatterDivision: '1/16',
      drive: 0.7,
      crush: 0.6,
      damp: 0.2,
      shatterSteps: CRUSHED_STEPS,
      outputGain: 0.58,
    },
  }),
  // ── Drone ──────────────────────────────────────────────────────────────
  Object.freeze<FactoryScene>({
    id: 'drone-deep-current',
    name: 'Drone — Deep Current',
    sourceId: 'sub-swell',
    mode: 'bloom',
    description: 'Long grains and added sub roll the swell into a slow, deep undertow.',
    patch: {
      mode: 'bloom',
      grainSizeMs: 700,
      densityHz: 20,
      spray: 0.2,
      subAmount: 0.5,
      subTune: 55,
      drive: 0.3,
      damp: 0.3,
      stereoSpread: 0.6,
      outputGain: 0.6,
    },
  }),
  Object.freeze<FactoryScene>({
    id: 'drone-warm-haze',
    name: 'Drone — Warm Haze',
    sourceId: 'harmonic-pad',
    mode: 'bloom',
    description: 'Tape saturation and damping wrap the pad in a soft, hazy glow.',
    patch: {
      mode: 'bloom',
      grainSizeMs: 320,
      densityHz: 22,
      spray: 0.22,
      damp: 0.55,
      drive: 0.28,
      tapeAmount: 0.6,
      tapeTone: 0.35,
      outputGain: 0.72,
    },
  }),
  Object.freeze<FactoryScene>({
    id: 'drone-glass-cathedral',
    name: 'Drone — Glass Cathedral',
    sourceId: 'harmonic-pad',
    mode: 'bloom',
    description: 'The same pad frozen into vast, dense grains and long reverb — a cathedral of glass.',
    patch: {
      mode: 'bloom',
      grainSizeMs: 1400,
      densityHz: 45,
      scanSpeed: 0,
      spray: 0.06,
      pitchSpreadSemitones: 0.2,
      stereoSpread: 0.9,
      space: 0.75,
      damp: 0.2,
      outputGain: 0.66,
    },
  }),
  // ── Impulse ────────────────────────────────────────────────────────────
  Object.freeze<FactoryScene>({
    id: 'impulse-dust-constellation',
    name: 'Impulse — Dust Constellation',
    sourceId: 'dust-impulse',
    mode: 'bloom',
    description: 'Very sparse, wide-sprayed clicks scatter into a slow, pitched constellation of dust.',
    patch: {
      mode: 'bloom',
      grainSizeMs: 120,
      densityHz: 6,
      spray: 0.85,
      timingJitter: 0.6,
      pitchSpreadSemitones: 12,
      pitchQuantize: 'minorPent',
      reverseProbability: 0.3,
      stereoSpread: 1,
      space: 0.5,
      outputGain: 0.74,
    },
  }),
  Object.freeze<FactoryScene>({
    id: 'impulse-machine-gun',
    name: 'Impulse — Machine Gun',
    sourceId: 'dust-impulse',
    mode: 'shatter',
    description: 'The same clicks fired in fast, dense ratchets — a rattling percussive barrage.',
    patch: {
      mode: 'shatter',
      grainSizeMs: 40,
      densityHz: 30,
      bpm: 150,
      shatterDivision: '1/16',
      drive: 0.4,
      repeat: 0.3,
      shatterSteps: RAPID_STEPS,
      outputGain: 0.62,
    },
  }),
])

// Look up a scene by id (used by the selector and any session round-trip).
export function findScene(id: string): FactoryScene | undefined {
  return FACTORY_SCENES.find((scene) => scene.id === id)
}
