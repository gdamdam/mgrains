import { describe, expect, it } from 'vitest'
import { parseMidiMessage } from './midi'

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
