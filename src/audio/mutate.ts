import {
  type GrainPatch,
  type ShatterStep,
  PATCH_RANGES,
  sanitizePatch,
} from './contracts'
import { XorShift32 } from './dsp/rng'

// Musical interval jumps used when shifting a step's pitch. Octaves, fifths and
// fourths keep mutations consonant with the source rather than randomly atonal.
const PITCH_JUMPS = [12, -12, 7, -7, 5, -5]

// Relative magnitude of the gentle nudge applied to continuous params. ~10–20%
// so the result reads as a variation of the input, not a fresh random patch.
const NUDGE_FRACTION = 0.18

// Per-step probabilities for the Shatter-lane edits. Tuned so a mutation touches
// a few steps rather than rewriting the whole lane.
const TOGGLE_GATE_CHANCE = 0.18
const NUDGE_PROBABILITY_CHANCE = 0.25
const SHIFT_PITCH_CHANCE = 0.18
const FLIP_REVERSE_CHANCE = 0.1
const CHANGE_RATCHET_CHANCE = 0.12

// Nudge a value by a small, bounded relative amount around its current value.
// Zero-valued params still get a small absolute kick (relative to range) so they
// are not stuck forever — the spread of the range scales the move.
function nudge(rng: XorShift32, value: number, range: readonly [number, number]): number {
  const [min, max] = range
  const span = max - min
  const magnitude = Math.max(Math.abs(value), span * 0.05)
  return value + rng.nextBipolar() * NUDGE_FRACTION * magnitude
}

function mutateStep(rng: XorShift32, step: ShatterStep): ShatterStep {
  const next: ShatterStep = { ...step }

  if (rng.nextFloat() < TOGGLE_GATE_CHANCE) {
    next.enabled = !next.enabled
  }

  if (rng.nextFloat() < NUDGE_PROBABILITY_CHANCE) {
    next.probability = step.probability + rng.nextBipolar() * 0.2
  }

  if (rng.nextFloat() < SHIFT_PITCH_CHANCE) {
    const jump = PITCH_JUMPS[rng.nextUint() % PITCH_JUMPS.length]
    next.pitchOffsetSemitones = step.pitchOffsetSemitones + jump
  }

  if (rng.nextFloat() < FLIP_REVERSE_CHANCE) {
    next.reverse = !next.reverse
  }

  if (rng.nextFloat() < CHANGE_RATCHET_CHANCE) {
    // 1..4 inclusive; sanitizePatch rounds and clamps defensively.
    next.ratchet = (1 + (rng.nextUint() % 4)) as ShatterStep['ratchet']
  }

  return next
}

// Produce a deterministic, musically related variation of `patch`. The same
// (patch, seed) pair always yields a byte-identical result. The Shatter lane is
// emphasized — gates toggle, probabilities drift, pitches leap by octaves/fifths/
// fourths, reverse and ratchet occasionally flip — while a handful of continuous
// params receive a small bounded nudge. Mode, bpm and shatterDivision are left
// untouched and the region stays essentially intact.
export function mutatePatch(patch: GrainPatch, seed: number): GrainPatch {
  const rng = new XorShift32(seed)

  // Drive the Shatter lane first so its richer edits dominate the variation.
  const shatterSteps = patch.shatterSteps.map((step) => mutateStep(rng, step))

  const next: GrainPatch = {
    ...patch,
    grainSizeMs: nudge(rng, patch.grainSizeMs, PATCH_RANGES.grainSizeMs),
    densityHz: nudge(rng, patch.densityHz, PATCH_RANGES.densityHz),
    spray: nudge(rng, patch.spray, PATCH_RANGES.spray),
    timingJitter: nudge(rng, patch.timingJitter, PATCH_RANGES.timingJitter),
    pitchSpreadSemitones: nudge(
      rng,
      patch.pitchSpreadSemitones,
      PATCH_RANGES.pitchSpreadSemitones,
    ),
    shatterSteps,
  }

  return sanitizePatch(next)
}
