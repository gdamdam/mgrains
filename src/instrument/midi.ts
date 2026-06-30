// Web MIDI input parsing plus a thin access wrapper.
// All parsing lives in the pure `parseMidiMessage`; `MidiInput` only wires
// the browser's Web MIDI API to that parser so it stays trivially testable.

export type MidiEvent =
  | { type: 'noteon'; channel: number; note: number; velocity: number }
  | { type: 'noteoff'; channel: number; note: number; velocity: number }
  | { type: 'cc'; channel: number; controller: number; value: number }
  | { type: 'pitchbend'; channel: number; value: number }

// 14-bit pitch bend: center 8192 maps to 0, full range maps to -1..1.
const PITCH_BEND_CENTER = 8192
const PITCH_BEND_MAX = 16383

/**
 * Parse a single raw MIDI message into a structured event.
 *
 * Returns null for messages that are too short or whose status nibble is not a
 * channel voice message we model (note on/off, control change, pitch bend).
 */
export function parseMidiMessage(
  data: Uint8Array | readonly number[],
): MidiEvent | null {
  if (data.length < 2) return null

  const status = data[0]
  const statusNibble = status & 0xf0
  const channel = status & 0x0f

  switch (statusNibble) {
    case 0x90: {
      // Note on, but a zero velocity is conventionally a note off.
      if (data.length < 3) return null
      const note = data[1]
      const velocity = data[2]
      if (velocity === 0) {
        return { type: 'noteoff', channel, note, velocity: 0 }
      }
      return { type: 'noteon', channel, note, velocity }
    }
    case 0x80: {
      if (data.length < 3) return null
      return { type: 'noteoff', channel, note: data[1], velocity: data[2] }
    }
    case 0xb0: {
      if (data.length < 3) return null
      return { type: 'cc', channel, controller: data[1], value: data[2] }
    }
    case 0xe0: {
      if (data.length < 3) return null
      // LSB is the low 7 bits, MSB the high 7 bits of a 14-bit value.
      const raw = data[1] | (data[2] << 7)
      const value =
        raw >= PITCH_BEND_CENTER
          ? (raw - PITCH_BEND_CENTER) / (PITCH_BEND_MAX - PITCH_BEND_CENTER)
          : (raw - PITCH_BEND_CENTER) / PITCH_BEND_CENTER
      return { type: 'pitchbend', channel, value }
    }
    default:
      return null
  }
}

function hasMidiSupport(nav: Navigator): boolean {
  return typeof (nav as { requestMIDIAccess?: unknown }).requestMIDIAccess === 'function'
}

export type MidiEventHandler = (event: MidiEvent) => void

/**
 * Thin wrapper around Web MIDI input: requests access, parses incoming
 * messages with `parseMidiMessage`, and forwards structured events.
 */
export class MidiInput {
  private access: MIDIAccess | null = null
  private readonly ports = new Set<MIDIInput>()
  // Tracks the caller's intent independently of the async access request, so a
  // `disable()` (or re-entrant `enable()`) during a pending request can cancel
  // it and prevent handler leaks once the promise finally resolves.
  private active = false

  constructor(private readonly onEvent: MidiEventHandler) {}

  async enable(): Promise<void> {
    // Already enabled or a request is in flight; nothing more to do.
    if (this.active) return

    // Throw before flipping `active` so a failed support check leaves us off.
    if (typeof navigator === 'undefined' || !hasMidiSupport(navigator)) {
      throw new Error('Web MIDI is not supported in this environment')
    }

    this.active = true

    let access: MIDIAccess
    try {
      access = await navigator.requestMIDIAccess()
    } catch (err) {
      this.active = false
      throw err
    }

    // Disabled while the request was pending: drop the access without wiring
    // anything so no handlers leak past the user turning MIDI off.
    if (!this.active) return

    this.access = access

    access.inputs.forEach((input) => {
      this.bindInput(input)
    })

    access.onstatechange = (event: MIDIConnectionEvent): void => {
      const port = event.port
      if (port && port.type === 'input' && port.state === 'connected') {
        this.bindInput(port as MIDIInput)
      }
    }
  }

  disable(): void {
    this.active = false
    if (this.access) this.access.onstatechange = null
    for (const input of this.ports) {
      input.onmidimessage = null
    }
    this.ports.clear()
    this.access = null
  }

  // Attach the message handler to an input and track it. Idempotent: binding an
  // already-tracked input simply refreshes its handler.
  private bindInput(input: MIDIInput): void {
    input.onmidimessage = (message: MIDIMessageEvent): void => {
      if (!message.data) return
      const event = parseMidiMessage(message.data)
      if (event) this.onEvent(event)
    }
    this.ports.add(input)
  }
}
