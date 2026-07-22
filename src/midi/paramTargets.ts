// Registry of parameters a MIDI CC can drive. Pure data — no DOM, no engine.
//
// A target `key` is either a top-level PATCH_RANGES key (a GrainPatch field) or
// a `macro:<id>` slot (a performance macro knob, scaled over 0..1). `log:true`
// marks params whose useful travel is exponential (frequencies, grain size,
// density) so a CC sweep feels even across the range instead of bunching at the
// low end. Everything else interpolates linearly.

import { MACROS } from '../audio/macros'

export interface MidiTarget {
  /** PATCH_RANGES key or `macro:<id>`. */
  key: string
  label: string
  /** Interpolate 0..127 logarithmically (frequency/exponential-feel params). */
  log: boolean
}

// Prefix that identifies a macro-slot target key.
export const MACRO_TARGET_PREFIX = 'macro:'

export function isMacroTarget(key: string): boolean {
  return key.startsWith(MACRO_TARGET_PREFIX)
}

// Direct-patch targets. Ordered for a sensible learn menu (source/shape first,
// then tone/FX, then output). `log` is true only where the audible response is
// exponential; keep this in sync with the notes above.
const PATCH_TARGETS: readonly MidiTarget[] = [
  { key: 'grainSizeMs', label: 'Grain Size', log: true },
  { key: 'densityHz', label: 'Density', log: true },
  { key: 'position', label: 'Position', log: false },
  { key: 'spray', label: 'Spray', log: false },
  { key: 'scanSpeed', label: 'Scan Speed', log: false },
  { key: 'pitchSemitones', label: 'Pitch', log: false },
  { key: 'stereoSpread', label: 'Stereo Spread', log: false },
  { key: 'drive', label: 'Drive', log: false },
  { key: 'crush', label: 'Crush', log: false },
  { key: 'damp', label: 'Damp', log: false },
  { key: 'space', label: 'Space', log: false },
  { key: 'repeatFeedback', label: 'Repeat Feedback', log: false },
  { key: 'grainFilterHz', label: 'Grain Filter', log: true },
  { key: 'ringModHz', label: 'Ring Mod Freq', log: true },
  { key: 'combFreq', label: 'Comb Freq', log: true },
  { key: 'wowRate', label: 'Wow Rate', log: false },
  { key: 'outputGain', label: 'Output Gain', log: false },
]

// Macro slots, derived from the macro registry so a new macro auto-appears.
// Macros are normalized 0..1 knobs, hence never logarithmic.
const MACRO_TARGETS: readonly MidiTarget[] = MACROS.map((macro) => ({
  key: `${MACRO_TARGET_PREFIX}${macro.id}`,
  label: `Macro: ${macro.label}`,
  log: false,
}))

/** Every assignable MIDI target: direct patch params followed by macro slots. */
export const MIDI_TARGETS: readonly MidiTarget[] = [...PATCH_TARGETS, ...MACRO_TARGETS]

/** O(1) lookup by key, used by CC scaling to read the `log` flag. */
export const MIDI_TARGET_BY_KEY: ReadonlyMap<string, MidiTarget> = new Map(
  MIDI_TARGETS.map((target) => [target.key, target]),
)
