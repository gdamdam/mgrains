import { describe, expect, it } from 'vitest'
import type { MidiInputEvent } from '../instrument/midi'
import {
  MIDI_OWNER_PREFIX,
  createMidiState,
  midiOwner,
  pitchBendSemitones,
  reduceMidiEvent,
  resetState,
  type MidiAction,
  type MidiRuntimeState,
} from './midiRuntime'

// Event builders.
const noteOn = (device: string, channel: number, note: number, velocity = 100): MidiInputEvent => ({
  type: 'noteon',
  device,
  channel,
  note,
  velocity,
})
const noteOff = (device: string, channel: number, note: number): MidiInputEvent => ({
  type: 'noteoff',
  device,
  channel,
  note,
  velocity: 0,
})
const cc = (device: string, channel: number, controller: number, value: number): MidiInputEvent => ({
  type: 'cc',
  device,
  channel,
  controller,
  value,
})
const bend = (device: string, channel: number, value: number): MidiInputEvent => ({
  type: 'pitchbend',
  device,
  channel,
  value,
})
const disconnect = (device: string): MidiInputEvent => ({ type: 'disconnect', device })

// Fold a sequence of events, returning the final state and all emitted actions.
function run(events: MidiInputEvent[], range = 2): { state: MidiRuntimeState; actions: MidiAction[] } {
  let state = createMidiState()
  const actions: MidiAction[] = []
  for (const event of events) {
    const result = reduceMidiEvent(state, event, { pitchBendRange: range })
    state = result.state
    actions.push(...result.actions)
  }
  return { state, actions }
}

describe('note lifecycle', () => {
  it('emits noteOn then noteOff', () => {
    const { actions } = run([noteOn('d', 0, 60), noteOff('d', 0, 60)])
    expect(actions).toEqual([
      { type: 'noteOn', owner: midiOwner('d', 0), note: 60, velocity: 100 },
      { type: 'noteOff', owner: midiOwner('d', 0), note: 60 },
    ])
  })

  it('repeated note-on retriggers without duplicate bookkeeping', () => {
    const { state, actions } = run([noteOn('d', 0, 60), noteOn('d', 0, 60, 40)])
    expect(actions).toHaveLength(2)
    expect(actions[1]).toEqual({ type: 'noteOn', owner: midiOwner('d', 0), note: 60, velocity: 40 })
    // A single note-off clears it (only one entry was tracked).
    const after = reduceMidiEvent(state, noteOff('d', 0, 60))
    expect(after.actions).toEqual([{ type: 'noteOff', owner: midiOwner('d', 0), note: 60 }])
  })

  it('note-off for an unheld note is a no-op', () => {
    const { actions } = run([noteOff('d', 0, 60)])
    expect(actions).toEqual([])
  })

  it('overlapping distinct notes each get their own on/off', () => {
    const { actions } = run([
      noteOn('d', 0, 60),
      noteOn('d', 0, 64),
      noteOff('d', 0, 60),
      noteOff('d', 0, 64),
    ])
    expect(actions.filter((a) => a.type === 'noteOn')).toHaveLength(2)
    expect(actions.filter((a) => a.type === 'noteOff')).toHaveLength(2)
  })
})

describe('sustain (CC64)', () => {
  it('holds released notes while pedal is down, releases them on pedal up', () => {
    const events = [
      cc('d', 0, 64, 127), // pedal down
      noteOn('d', 0, 60),
      noteOff('d', 0, 60), // held by pedal — no noteOff yet
      cc('d', 0, 64, 0), // pedal up — release now
    ]
    const { actions } = run(events)
    const offs = actions.filter((a) => a.type === 'noteOff')
    expect(offs).toEqual([{ type: 'noteOff', owner: midiOwner('d', 0), note: 60 }])
    // The noteOff only appears after the pedal-up event (index-wise last).
    expect(actions[actions.length - 1]).toEqual({
      type: 'noteOff',
      owner: midiOwner('d', 0),
      note: 60,
    })
  })

  it('re-pressing a sustained note reclaims it (no double release on pedal up)', () => {
    const events = [
      cc('d', 0, 64, 127),
      noteOn('d', 0, 60),
      noteOff('d', 0, 60), // sustained
      noteOn('d', 0, 60), // re-pressed while pedal still down -> now held
      cc('d', 0, 64, 0), // pedal up: 60 is still physically held, so NOT released
    ]
    const { state, actions } = run(events)
    expect(actions.filter((a) => a.type === 'noteOff')).toEqual([])
    // Still held after pedal up.
    const off = reduceMidiEvent(state, noteOff('d', 0, 60))
    expect(off.actions).toEqual([{ type: 'noteOff', owner: midiOwner('d', 0), note: 60 }])
  })

  it('note held down through a pedal cycle is not released by pedal up', () => {
    const events = [
      noteOn('d', 0, 60),
      cc('d', 0, 64, 127),
      cc('d', 0, 64, 0), // key never lifted -> nothing to release
    ]
    const { actions } = run(events)
    expect(actions.filter((a) => a.type === 'noteOff')).toEqual([])
  })

  it('value >=64 is down, <64 is up', () => {
    const down = reduceMidiEvent(createMidiState(), cc('d', 0, 64, 64))
    expect(down.state.owners[midiOwner('d', 0)].pedalDown).toBe(true)
    const up = reduceMidiEvent(down.state, cc('d', 0, 64, 63))
    expect(up.state.owners[midiOwner('d', 0)].pedalDown).toBe(false)
  })

  it('non-sustain CC is ignored (handled by mapping layer)', () => {
    const { actions } = run([cc('d', 0, 74, 100)])
    expect(actions).toEqual([])
  })

  it('releases multiple sustained notes deterministically in press order', () => {
    const events = [
      cc('d', 0, 64, 127),
      noteOn('d', 0, 60),
      noteOn('d', 0, 67),
      noteOff('d', 0, 60),
      noteOff('d', 0, 67),
      cc('d', 0, 64, 0),
    ]
    const { actions } = run(events)
    const offNotes = actions.filter((a) => a.type === 'noteOff').map((a) => (a as { note: number }).note)
    expect(offNotes).toEqual([60, 67])
  })
})

describe('multi-device / multi-channel isolation', () => {
  it('same note on different devices/channels are independent owners', () => {
    const state = createMidiState()
    const r1 = reduceMidiEvent(state, noteOn('A', 0, 60))
    const r2 = reduceMidiEvent(r1.state, noteOn('B', 0, 60))
    const r3 = reduceMidiEvent(r2.state, noteOn('A', 1, 60))
    expect(Object.keys(r3.state.owners).sort()).toEqual(
      [midiOwner('A', 0), midiOwner('A', 1), midiOwner('B', 0)].sort(),
    )
    // Releasing on A/0 leaves B/0 and A/1 untouched.
    const off = reduceMidiEvent(r3.state, noteOff('A', 0, 60))
    expect(off.actions).toEqual([{ type: 'noteOff', owner: midiOwner('A', 0), note: 60 }])
  })

  it("one device's pedal does not sustain another device's notes", () => {
    const events = [
      cc('A', 0, 64, 127), // A pedal down
      noteOn('B', 0, 60),
      noteOff('B', 0, 60), // B has no pedal -> immediate release
    ]
    const { actions } = run(events)
    expect(actions.filter((a) => a.type === 'noteOff')).toEqual([
      { type: 'noteOff', owner: midiOwner('B', 0), note: 60 },
    ])
  })
})

describe('pitch bend', () => {
  it('pitchBendSemitones handles normalized input', () => {
    expect(pitchBendSemitones(0, 2)).toBeCloseTo(0)
    expect(pitchBendSemitones(1, 2)).toBeCloseTo(2)
    expect(pitchBendSemitones(-1, 2)).toBeCloseTo(-2)
    expect(pitchBendSemitones(0.5, 12)).toBeCloseTo(6)
  })

  it('pitchBendSemitones handles raw 14-bit input', () => {
    expect(pitchBendSemitones(8192, 2)).toBeCloseTo(0) // center
    expect(pitchBendSemitones(16383, 2)).toBeCloseTo(2) // full up
    expect(pitchBendSemitones(0, 2)).toBeCloseTo(0) // 0 is treated as normalized center
    expect(pitchBendSemitones(4096, 2)).toBeCloseTo(-1) // half down
  })

  it('non-finite bend is 0', () => {
    expect(pitchBendSemitones(Number.NaN, 2)).toBe(0)
  })

  it('emits a global pitchBend action scaled by range and tracks per owner', () => {
    const r = reduceMidiEvent(createMidiState(), bend('d', 0, 0.5), { pitchBendRange: 12 })
    expect(r.actions).toEqual([{ type: 'pitchBend', semitones: 6 }])
    expect(r.state.bend[midiOwner('d', 0)]).toBeCloseTo(6)
  })
})

describe('disconnect', () => {
  it('releases the device across all channels and clears its bend', () => {
    const seeded = run([
      noteOn('A', 0, 60),
      noteOn('A', 1, 64),
      bend('A', 0, 0.5),
      noteOn('B', 0, 67),
    ])
    const r = reduceMidiEvent(seeded.state, disconnect('A'), { pitchBendRange: 2 })
    expect(r.actions).toContainEqual({ type: 'releaseOwner', ownerPrefix: `${MIDI_OWNER_PREFIX}A:` })
    expect(r.actions).toContainEqual({ type: 'pitchBend', semitones: 0 })
    // B survives.
    expect(r.state.owners[midiOwner('B', 0)]).toBeDefined()
    expect(r.state.owners[midiOwner('A', 0)]).toBeUndefined()
  })

  it('disconnect with no active bend emits release but no pitch reset', () => {
    const seeded = run([noteOn('A', 0, 60)])
    const r = reduceMidiEvent(seeded.state, disconnect('A'))
    expect(r.actions).toEqual([{ type: 'releaseOwner', ownerPrefix: `${MIDI_OWNER_PREFIX}A:` }])
  })

  it('disconnect of an unknown device is a harmless no-op', () => {
    const r = reduceMidiEvent(createMidiState(), disconnect('ghost'))
    expect(r.actions).toEqual([])
  })
})

describe('resetState (teardown)', () => {
  it('releases all MIDI owners and forces pitch bend to 0', () => {
    const seeded = run([noteOn('A', 0, 60), bend('B', 1, 1)])
    const r = resetState(seeded.state)
    expect(r.actions).toEqual([
      { type: 'releaseOwner', ownerPrefix: MIDI_OWNER_PREFIX },
      { type: 'pitchBend', semitones: 0 },
    ])
    expect(Object.keys(r.state.owners)).toHaveLength(0)
    expect(Object.keys(r.state.bend)).toHaveLength(0)
  })

  it('from empty state still neutralizes the (possibly stale) global bend', () => {
    const r = resetState(createMidiState())
    expect(r.actions).toEqual([{ type: 'pitchBend', semitones: 0 }])
  })
})
