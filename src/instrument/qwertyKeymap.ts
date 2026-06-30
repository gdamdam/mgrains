// Ableton Live "Computer MIDI Keyboard" layout, encoded with
// KeyboardEvent.code values so it stays correct regardless of the user's
// physical keyboard layout (QWERTY codes are positional, not glyph-based).
//
// Semitone offsets are relative to a base C. Two staggered rows form a
// piano: the home row carries the "white" keys and the row above carries
// the "black" keys, mirroring the physical key positions.

/** Note keys mapped to their semitone offset above the base C. */
export const KEY_TO_SEMITONE = {
  KeyA: 0, // C
  KeyW: 1, // C#
  KeyS: 2, // D
  KeyE: 3, // D#
  KeyD: 4, // E
  KeyF: 5, // F
  KeyT: 6, // F#
  KeyG: 7, // G
  KeyY: 8, // G#
  KeyH: 9, // A
  KeyU: 10, // A#
  KeyJ: 11, // B
  KeyK: 12, // C (octave up)
  KeyO: 13, // C#
  KeyL: 14, // D
  KeyP: 15, // D#
  Semicolon: 16, // E
  // Note: KeyR and KeyI are intentionally gaps in the layout.
} as const

export type NoteKeyCode = keyof typeof KEY_TO_SEMITONE

/** Keys that shift the playable octave range. */
export const OCTAVE_KEYS = { down: 'KeyZ', up: 'KeyX' } as const

/** Keys that adjust note velocity. */
export const VELOCITY_KEYS = { down: 'KeyC', up: 'KeyV' } as const

export type ControlIntent =
  | 'octave-down'
  | 'octave-up'
  | 'velocity-down'
  | 'velocity-up'

/** Returns the semitone offset for a note key, or null if it is not one. */
export function keyToSemitone(code: string): number | null {
  if (Object.prototype.hasOwnProperty.call(KEY_TO_SEMITONE, code)) {
    return KEY_TO_SEMITONE[code as NoteKeyCode]
  }
  return null
}

/** True when the code corresponds to a playable note key. */
export function isNoteKey(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(KEY_TO_SEMITONE, code)
}

/** Maps a code to its octave/velocity control intent, or null. */
export function controlForKey(code: string): ControlIntent | null {
  switch (code) {
    case OCTAVE_KEYS.down:
      return 'octave-down'
    case OCTAVE_KEYS.up:
      return 'octave-up'
    case VELOCITY_KEYS.down:
      return 'velocity-down'
    case VELOCITY_KEYS.up:
      return 'velocity-up'
    default:
      return null
  }
}
