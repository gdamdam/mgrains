import { afterEach, describe, expect, it, vi } from 'vitest'
import { MidiInput, parseMidiMessage } from './midi'

describe('parseMidiMessage', () => {
  it('parses note on', () => {
    expect(parseMidiMessage([0x90, 60, 100])).toEqual({
      type: 'noteon',
      channel: 0,
      note: 60,
      velocity: 100,
    })
  })

  it('treats note on with velocity 0 as note off', () => {
    expect(parseMidiMessage([0x90, 60, 0])).toEqual({
      type: 'noteoff',
      channel: 0,
      note: 60,
      velocity: 0,
    })
  })

  it('parses note off', () => {
    expect(parseMidiMessage([0x80, 60, 64])).toEqual({
      type: 'noteoff',
      channel: 0,
      note: 60,
      velocity: 64,
    })
  })

  it('parses control change', () => {
    expect(parseMidiMessage([0xb0, 7, 127])).toEqual({
      type: 'cc',
      channel: 0,
      controller: 7,
      value: 127,
    })
  })

  it('parses pitch bend center as ~0', () => {
    const event = parseMidiMessage([0xe0, 0, 64])
    expect(event?.type).toBe('pitchbend')
    if (event?.type === 'pitchbend') {
      expect(event.value).toBeCloseTo(0, 4)
    }
  })

  it('parses pitch bend max as ~+1', () => {
    const event = parseMidiMessage([0xe0, 127, 127])
    expect(event?.type).toBe('pitchbend')
    if (event?.type === 'pitchbend') {
      expect(event.value).toBeCloseTo(1, 4)
    }
  })

  it('parses pitch bend min as ~-1', () => {
    const event = parseMidiMessage([0xe0, 0, 0])
    expect(event?.type).toBe('pitchbend')
    if (event?.type === 'pitchbend') {
      expect(event.value).toBeCloseTo(-1, 4)
    }
  })

  it('parses channel from the low nibble', () => {
    expect(parseMidiMessage([0x92, 60, 100])).toEqual({
      type: 'noteon',
      channel: 2,
      note: 60,
      velocity: 100,
    })
  })

  it('accepts a Uint8Array', () => {
    expect(parseMidiMessage(new Uint8Array([0x90, 60, 100]))).toEqual({
      type: 'noteon',
      channel: 0,
      note: 60,
      velocity: 100,
    })
  })

  it('returns null for short data', () => {
    expect(parseMidiMessage([0x90])).toBeNull()
    expect(parseMidiMessage([])).toBeNull()
    expect(parseMidiMessage([0xe0, 0])).toBeNull()
  })

  it('returns null for unrecognized status', () => {
    expect(parseMidiMessage([0xf0, 1, 2])).toBeNull()
    expect(parseMidiMessage([0x00, 1, 2])).toBeNull()
  })
})

// Test doubles for the Web MIDI API — only the surface `MidiInput` actually
// touches, typed minimally (no `any`). They are passed across the stubbed
// `navigator` boundary, where `MidiInput` treats them as the real DOM types.
type FakeMidiMessageListener = ((message: { data: Uint8Array }) => void) | null

interface FakeMidiInput {
  type: 'input'
  state: 'connected'
  onmidimessage: FakeMidiMessageListener
}

interface FakeMidiAccess {
  inputs: Map<string, FakeMidiInput>
  onstatechange: ((event: { port: FakeMidiInput }) => void) | null
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function fakeInput(): FakeMidiInput {
  return { type: 'input', state: 'connected', onmidimessage: null }
}

function fakeAccess(inputs: FakeMidiInput[]): FakeMidiAccess {
  return { inputs: new Map(inputs.map((input, n) => [String(n), input])), onstatechange: null }
}

function send(input: FakeMidiInput, bytes: number[]): void {
  input.onmidimessage?.({ data: new Uint8Array(bytes) })
}

describe('MidiInput', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('A) does not attach handlers if disabled while access is pending', async () => {
    const d = deferred<FakeMidiAccess>()
    vi.stubGlobal('navigator', { requestMIDIAccess: () => d.promise })

    const handler = vi.fn()
    const m = new MidiInput(handler)
    const input = fakeInput()

    const p = m.enable()
    m.disable()
    d.resolve(fakeAccess([input]))
    await p

    send(input, [0x90, 60, 100])
    expect(handler).toHaveBeenCalledTimes(0)
  })

  it('B) binds devices connected after enable (hot-plug)', async () => {
    const access = fakeAccess([])
    vi.stubGlobal('navigator', {
      requestMIDIAccess: () => Promise.resolve(access),
    })

    const handler = vi.fn()
    const m = new MidiInput(handler)
    await m.enable()

    const inp = fakeInput()
    access.onstatechange?.({ port: inp })

    send(inp, [0x90, 64, 90])
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({
      type: 'noteon',
      channel: 0,
      note: 64,
      velocity: 90,
    })
  })

  it('C) forwards messages while enabled and stops after disable', async () => {
    const input = fakeInput()
    vi.stubGlobal('navigator', {
      requestMIDIAccess: () => Promise.resolve(fakeAccess([input])),
    })

    const handler = vi.fn()
    const m = new MidiInput(handler)
    await m.enable()

    send(input, [0x90, 60, 100])
    expect(handler).toHaveBeenCalledTimes(1)

    m.disable()
    send(input, [0x90, 62, 100])
    expect(handler).toHaveBeenCalledTimes(1)
  })
})
