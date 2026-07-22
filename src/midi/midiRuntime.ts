// Pure MIDI performance runtime: note lifecycle with sustain (CC64), pitch bend,
// and teardown — modeled as reducers that RETURN action descriptors for App to
// apply. This module never touches the engine, the VoiceAllocator, or the DOM;
// App maps the returned actions onto `alloc.noteOn/noteOff/releaseOwnerPrefix`
// and `engine.setPitchBend`. It concerns MIDI owners only: QWERTY ('kbd') and
// other input sources own their own voices and are untouched here.

import type { MidiInputEvent } from '../instrument/midi'
import { DEFAULT_PATCH } from '../audio/contracts'

// Voice ownership string shared with the VoiceAllocator: `midi:<device>:<channel>`
// keeps the same pitch from different controllers/channels on independent voices.
export const MIDI_OWNER_PREFIX = 'midi:'

export function midiOwner(device: string, channel: number): string {
  return `${MIDI_OWNER_PREFIX}${device}:${channel}`
}

// The MIDI sustain pedal is CC64; >=64 is "down" (hold), <64 is "up" (release).
export const SUSTAIN_CC = 64
const SUSTAIN_THRESHOLD = 64

/**
 * Actions App applies. Note values are MIDI-domain (note 0..127, velocity
 * 0..127); App maps them to allocator units (offset = note - 60, velocity/127).
 * - noteOn/noteOff  → alloc.noteOn(offset, vel, owner) / alloc.noteOff(offset, owner)
 * - releaseOwner    → alloc.releaseOwnerPrefix(ownerPrefix) (bulk teardown)
 * - pitchBend       → engine.setPitchBend(semitones) (global; App reads patch range)
 */
export type MidiAction =
  | { type: 'noteOn'; owner: string; note: number; velocity: number }
  | { type: 'noteOff'; owner: string; note: number }
  | { type: 'releaseOwner'; ownerPrefix: string }
  | { type: 'pitchBend'; semitones: number }

interface OwnerState {
  // Notes whose key is physically down.
  held: number[]
  // Notes whose key was released while the pedal was down (kept sounding by it).
  // Disjoint from `held`: re-pressing a sustained note moves it back to `held`.
  sustained: number[]
  pedalDown: boolean
}

export interface MidiRuntimeState {
  // Keyed by owner string (`midi:<device>:<channel>`) so devices/channels are
  // fully isolated.
  owners: Record<string, OwnerState>
  // Last pitch-bend value (semitones) applied per owner. Tracked so teardown can
  // tell whether a bend needs clearing; the engine's bend is global.
  bend: Record<string, number>
}

export interface MidiReduceResult {
  state: MidiRuntimeState
  actions: MidiAction[]
}

export function createMidiState(): MidiRuntimeState {
  return { owners: {}, bend: {} }
}

/** Fresh empty owner state. */
function emptyOwner(): OwnerState {
  return { held: [], sustained: [], pedalDown: false }
}

// Shallow-clone state with one owner replaced — keeps reducers non-mutating.
function withOwner(
  state: MidiRuntimeState,
  owner: string,
  next: OwnerState,
): MidiRuntimeState {
  return { owners: { ...state.owners, [owner]: next }, bend: state.bend }
}

function withoutNote(list: readonly number[], note: number): number[] {
  return list.filter((n) => n !== note)
}

/**
 * Convert a pitch-bend reading to semitones. Accepts either the normalized
 * -1..1 value produced by parseMidiMessage OR a raw 14-bit integer (0..16383):
 * any magnitude >1 is treated as raw 14-bit and normalized around center 8192
 * (matching parseMidiMessage's asymmetric split so full-up and full-down both
 * reach ±1). `range` is the patch's pitchBendRange in semitones. Pure.
 */
export function pitchBendSemitones(raw14bitOrNormalized: number, range: number): number {
  if (!Number.isFinite(raw14bitOrNormalized)) return 0
  let normalized = raw14bitOrNormalized
  if (normalized < -1 || normalized > 1) {
    const clamped = Math.min(16383, Math.max(0, normalized))
    normalized = clamped >= 8192 ? (clamped - 8192) / (16383 - 8192) : (clamped - 8192) / 8192
  }
  return normalized * range
}

// --- Note lifecycle --------------------------------------------------------

function handleNoteOn(
  state: MidiRuntimeState,
  owner: string,
  note: number,
  velocity: number,
): MidiReduceResult {
  const prev = state.owners[owner] ?? emptyOwner()
  const next: OwnerState = {
    // Re-pressing a note reclaims it from the pedal's sustained set.
    sustained: withoutNote(prev.sustained, note),
    // Dedupe so repeated note-ons keep a single entry (allocator retriggers).
    held: prev.held.includes(note) ? prev.held : [...prev.held, note],
    pedalDown: prev.pedalDown,
  }
  return {
    state: withOwner(state, owner, next),
    actions: [{ type: 'noteOn', owner, note, velocity }],
  }
}

function handleNoteOff(
  state: MidiRuntimeState,
  owner: string,
  note: number,
): MidiReduceResult {
  const prev = state.owners[owner]
  if (!prev || !prev.held.includes(note)) {
    // Not held here (already released, or belongs to another owner) — no-op.
    return { state, actions: [] }
  }

  const held = withoutNote(prev.held, note)

  if (prev.pedalDown) {
    // Pedal holds it: move to sustained, emit nothing (voice keeps sounding).
    const sustained = prev.sustained.includes(note)
      ? prev.sustained
      : [...prev.sustained, note]
    return {
      state: withOwner(state, owner, { held, sustained, pedalDown: true }),
      actions: [],
    }
  }

  return {
    state: withOwner(state, owner, {
      held,
      sustained: withoutNote(prev.sustained, note),
      pedalDown: false,
    }),
    actions: [{ type: 'noteOff', owner, note }],
  }
}

function handleSustain(
  state: MidiRuntimeState,
  owner: string,
  down: boolean,
): MidiReduceResult {
  const prev = state.owners[owner] ?? emptyOwner()

  if (down) {
    if (prev.pedalDown) return { state, actions: [] }
    return { state: withOwner(state, owner, { ...prev, pedalDown: true }), actions: [] }
  }

  // Pedal up: release every note the pedal was holding (they are, by
  // construction, notes whose key is already up). Emit in insertion order for
  // deterministic output.
  const actions: MidiAction[] = prev.sustained.map((note) => ({
    type: 'noteOff' as const,
    owner,
    note,
  }))
  return {
    state: withOwner(state, owner, { held: prev.held, sustained: [], pedalDown: false }),
    actions,
  }
}

// Release every note (held + sustained) and clear the bend for the given owners,
// returning teardown actions. `ownerPrefix` filters which owners; '' matches all.
function releaseOwners(
  state: MidiRuntimeState,
  ownerPrefix: string,
): MidiReduceResult {
  const owners = { ...state.owners }
  const bend = { ...state.bend }
  let matchedOwner = false
  let hadBend = false

  for (const owner of Object.keys(owners)) {
    if (!owner.startsWith(ownerPrefix)) continue
    matchedOwner = true
    delete owners[owner]
  }
  for (const owner of Object.keys(bend)) {
    if (!owner.startsWith(ownerPrefix)) continue
    if (bend[owner] !== 0) hadBend = true
    delete bend[owner]
  }

  const actions: MidiAction[] = []
  // A single releaseOwnerPrefix beats emitting one noteOff per note, and it also
  // sweeps any voice the runtime somehow missed, so emit it whenever any owner
  // matched the prefix.
  if (matchedOwner) actions.push({ type: 'releaseOwner', ownerPrefix })
  // Neutralize a lingering bend so it never sticks to QWERTY/other/future notes.
  if (hadBend) actions.push({ type: 'pitchBend', semitones: 0 })

  return { state: { owners, bend }, actions }
}

/**
 * Reduce one MidiInput event into state + actions. Handles noteon/noteoff,
 * CC64 sustain (other CCs are ignored here — App maps them via midiMapping),
 * pitch bend (per device+channel), and device disconnect. `pitchBendRange`
 * defaults to the patch default; App passes the live patch value.
 */
export function reduceMidiEvent(
  state: MidiRuntimeState,
  event: MidiInputEvent,
  config: { pitchBendRange?: number } = {},
): MidiReduceResult {
  const range = config.pitchBendRange ?? DEFAULT_PATCH.pitchBendRange

  switch (event.type) {
    case 'noteon':
      return handleNoteOn(state, midiOwner(event.device, event.channel), event.note, event.velocity)
    case 'noteoff':
      return handleNoteOff(state, midiOwner(event.device, event.channel), event.note)
    case 'cc':
      if (event.controller === SUSTAIN_CC) {
        return handleSustain(
          state,
          midiOwner(event.device, event.channel),
          event.value >= SUSTAIN_THRESHOLD,
        )
      }
      // Non-sustain CC: parameter mapping is App's job (midiMapping).
      return { state, actions: [] }
    case 'pitchbend': {
      const owner = midiOwner(event.device, event.channel)
      const semitones = pitchBendSemitones(event.value, range)
      return {
        state: { owners: state.owners, bend: { ...state.bend, [owner]: semitones } },
        actions: [{ type: 'pitchBend', semitones }],
      }
    }
    case 'disconnect':
      // Release everything this device held across all its channels.
      return releaseOwners(state, `${MIDI_OWNER_PREFIX}${event.device}:`)
    default:
      return { state, actions: [] }
  }
}

/**
 * Teardown: release ALL MIDI-owned notes and reset pitch bend to 0. Used for
 * visibility loss, engine shutdown, MIDI teardown, and MIDI disabled. Always
 * emits `pitchBend 0` so no stale bend survives on QWERTY/other/future notes.
 * Returns a fresh empty state.
 */
export function resetState(state: MidiRuntimeState): MidiReduceResult {
  const anyOwners = Object.keys(state.owners).length > 0
  const actions: MidiAction[] = []
  if (anyOwners) actions.push({ type: 'releaseOwner', ownerPrefix: MIDI_OWNER_PREFIX })
  // Unconditional: guarantees the engine bend is neutral after any teardown.
  actions.push({ type: 'pitchBend', semitones: 0 })
  return { state: createMidiState(), actions }
}
