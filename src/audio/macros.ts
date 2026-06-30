import {
  clamp,
  SHATTER_DIVISIONS,
  type GrainMode,
  type GrainPatch,
  type ShatterDivision,
} from './contracts'

// Performance macros: each maps a single 0..1 knob onto a curated set of
// EXISTING GrainPatch params, so a player can sweep one control and move a whole
// musical gesture. Mappings stay monotonic across the full 0..1 range and land
// inside PATCH_RANGES at both endpoints; applyMacro returns ONLY the params it
// changed, leaving the caller to merge + sanitize.
//
// Link/Unlink takeover model:
//   linked   => the caller WRITES the params in applyMacro's result (the macro
//               "takes over" those fields while the knob is moving).
//   unlinked => the caller SKIPS writing the macro's params (look them up in
//               MACRO_PARAMS), leaving the player's hand-set values intact.

export interface MacroDef {
  readonly id: string
  readonly label: string
  readonly mode: GrainMode
  readonly params: ReadonlyArray<keyof GrainPatch>
}

// Linear interpolation across a PATCH_RANGES tuple for a normalized 0..1 input.
function lerp(range: readonly [number, number], value: number): number {
  return range[0] + (range[1] - range[0]) * value
}

const CLOUD_PARAMS = ['grainSizeMs', 'densityHz'] as const satisfies ReadonlyArray<
  keyof GrainPatch
>
const DRIFT_PARAMS = [
  'scanSpeed',
  'spray',
  'timingJitter',
  'pitchSpreadSemitones',
] as const satisfies ReadonlyArray<keyof GrainPatch>
const CHOP_PARAMS = ['shatterDivision', 'grainSizeMs'] as const satisfies ReadonlyArray<
  keyof GrainPatch
>
const SCATTER_PARAMS = [
  'spray',
  'timingJitter',
  'reverseProbability',
] as const satisfies ReadonlyArray<keyof GrainPatch>
const WARMTH_PARAMS = ['damp', 'drive'] as const satisfies ReadonlyArray<keyof GrainPatch>
const CRUSH_PARAMS = ['drive', 'crush', 'damp'] as const satisfies ReadonlyArray<
  keyof GrainPatch
>

export const MACROS: ReadonlyArray<MacroDef> = Object.freeze([
  Object.freeze({ id: 'cloud', label: 'Cloud', mode: 'bloom', params: CLOUD_PARAMS }),
  Object.freeze({ id: 'drift', label: 'Drift', mode: 'bloom', params: DRIFT_PARAMS }),
  Object.freeze({ id: 'warmth', label: 'Warmth', mode: 'bloom', params: WARMTH_PARAMS }),
  Object.freeze({ id: 'chop', label: 'Chop', mode: 'shatter', params: CHOP_PARAMS }),
  Object.freeze({ id: 'scatter', label: 'Scatter', mode: 'shatter', params: SCATTER_PARAMS }),
  Object.freeze({ id: 'crush', label: 'Crush', mode: 'shatter', params: CRUSH_PARAMS }),
])

// Params each macro controls, exposed so the UI can drive Link/Unlink: an
// unlinked macro's params are simply not written by the caller.
export const MACRO_PARAMS: Record<string, ReadonlyArray<keyof GrainPatch>> = Object.freeze(
  Object.fromEntries(MACROS.map((macro) => [macro.id, macro.params])),
)

// Pick a division from the ordered (coarse -> fine) SHATTER_DIVISIONS by value.
// value 0 -> '1/8' (a gentle coarse start), value 1 -> '1/64' (finest).
function chopDivision(value: number): ShatterDivision {
  const start = SHATTER_DIVISIONS.indexOf('1/8')
  const end = SHATTER_DIVISIONS.length - 1
  const index = Math.round(lerp([start, end], value))
  return SHATTER_DIVISIONS[index]
}

// Map a clamped 0..1 value to the changed params for the given macro.
// Returns {} for an unknown id so the caller can no-op safely.
export function applyMacro(
  _patch: GrainPatch,
  macroId: string,
  value: number,
): Partial<GrainPatch> {
  const v = clamp(value, 0, 1)

  switch (macroId) {
    case 'cloud':
      // Thickness: longer grains + higher density together build a denser cloud.
      return {
        grainSizeMs: lerp([40, 1200], v),
        densityHz: lerp([4, 60], v),
      }
    case 'drift':
      // Wandering motion: scan sweeps forward, grains spray and jitter, pitch fans out.
      return {
        scanSpeed: lerp([0, 1], v),
        spray: lerp([0, 0.8], v),
        timingJitter: lerp([0, 0.6], v),
        pitchSpreadSemitones: lerp([0, 12], v),
      }
    case 'chop':
      // Finer subdivision + smaller grains as the knob rises for tighter stutter.
      return {
        shatterDivision: chopDivision(v),
        grainSizeMs: lerp([220, 20], v),
      }
    case 'scatter':
      // Randomized fragmentation: spray, jitter and reversal probability all grow.
      return {
        spray: lerp([0, 1], v),
        timingJitter: lerp([0, 1], v),
        reverseProbability: lerp([0, 0.85], v),
      }
    case 'warmth':
      // Tone shaping: roll off the highs and add a gentle saturation glow.
      return {
        damp: lerp([0, 0.8], v),
        drive: lerp([0, 0.4], v),
      }
    case 'crush':
      // Aggressive degradation: hard drive + bit reduction, with a touch of
      // damping to tame the harshest top end.
      return {
        drive: lerp([0, 1], v),
        crush: lerp([0, 1], v),
        damp: lerp([0, 0.5], v),
      }
    default:
      return {}
  }
}
