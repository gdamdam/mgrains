import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LINK_URL,
  encodeSetPlaying,
  encodeSetTempo,
  initialLinkState,
  LINK_QUANTUM,
  parseLinkMessage,
  projectPhase,
  secondsUntilDownbeat,
  wrapPhase,
} from './abletonLink'

describe('DEFAULT_LINK_URL', () => {
  it('points at the mpump bridge port', () => {
    expect(DEFAULT_LINK_URL).toBe('ws://localhost:19876')
  })
})

describe('initialLinkState', () => {
  it('is disconnected, stopped, and zeroed', () => {
    expect(initialLinkState()).toEqual({
      connected: false,
      bpm: 0,
      beat: 0,
      phase: 0,
      peers: 0,
      playing: false,
    })
  })

  it('returns a fresh object each call', () => {
    const a = initialLinkState()
    const b = initialLinkState()
    expect(a).not.toBe(b)
  })
})

describe('parseLinkMessage', () => {
  it('parses a full bridge "link" frame into a partial state', () => {
    const frame =
      '{"type":"link","tempo":130.5,"beat":2.5,"phase":0.625,"playing":true,"peers":2,"clients":1}'

    expect(parseLinkMessage(frame)).toEqual({
      bpm: 130.5,
      beat: 2.5,
      phase: 0.625,
      playing: true,
      peers: 2,
    })
  })

  it('maps the wire "tempo" field onto bpm', () => {
    const result = parseLinkMessage('{"type":"link","tempo":120}')
    expect(result).toEqual({ bpm: 120 })
  })

  it('only includes fields present on the frame', () => {
    const result = parseLinkMessage('{"type":"link","playing":false,"peers":0}')
    expect(result).toEqual({ playing: false, peers: 0 })
  })

  it('ignores frames whose type is not "link"', () => {
    expect(parseLinkMessage('{"type":"state","data":{}}')).toBeNull()
  })

  it('returns null for malformed JSON', () => {
    expect(parseLinkMessage('not json')).toBeNull()
  })

  it('returns null for non-object payloads', () => {
    expect(parseLinkMessage('42')).toBeNull()
    expect(parseLinkMessage('null')).toBeNull()
    expect(parseLinkMessage('"link"')).toBeNull()
  })

  it('ignores fields with the wrong runtime type', () => {
    const result = parseLinkMessage(
      '{"type":"link","tempo":"fast","beat":1,"playing":"yes","peers":3}'
    )
    expect(result).toEqual({ beat: 1, peers: 3 })
  })

  it('rejects non-finite numeric values', () => {
    const result = parseLinkMessage('{"type":"link","beat":1.5}')
    expect(result).toEqual({ beat: 1.5 })
    expect(parseLinkMessage('{"type":"link","tempo":null}')).toEqual({})
  })
})

describe('encodeSetTempo', () => {
  it('emits the bridge set_tempo frame', () => {
    expect(encodeSetTempo(130)).toBe('{"type":"set_tempo","tempo":130}')
  })

  it('preserves fractional tempos', () => {
    expect(JSON.parse(encodeSetTempo(128.5))).toEqual({
      type: 'set_tempo',
      tempo: 128.5,
    })
  })
})

describe('encodeSetPlaying', () => {
  it('emits the bridge set_playing frame when starting', () => {
    expect(encodeSetPlaying(true)).toBe('{"type":"set_playing","playing":true}')
  })

  it('emits the bridge set_playing frame when stopping', () => {
    expect(encodeSetPlaying(false)).toBe('{"type":"set_playing","playing":false}')
  })
})

describe('wrapPhase', () => {
  it('leaves an in-range phase untouched', () => {
    expect(wrapPhase(0.625, 4)).toBeCloseTo(0.625)
  })

  it('wraps a phase that exceeds the quantum', () => {
    expect(wrapPhase(4.25, 4)).toBeCloseTo(0.25)
  })

  it('wraps negative phases into range', () => {
    expect(wrapPhase(-0.5, 4)).toBeCloseTo(3.5)
  })

  it('returns 0 for a non-positive quantum', () => {
    expect(wrapPhase(2, 0)).toBe(0)
  })
})

describe('LINK_QUANTUM', () => {
  it('is a 4-beat bar, matching the bridge phase quantum', () => {
    expect(LINK_QUANTUM).toBe(4)
  })
})

describe('projectPhase', () => {
  it('advances the phase forward at the given tempo, wrapped into the bar', () => {
    // 120 BPM = 2 beats/sec; 0.5s adds 1 beat: phase 3.5 -> 4.5 -> wraps to 0.5.
    expect(projectPhase(3.5, 120, 4, 0.5)).toBeCloseTo(0.5)
  })

  it('preserves fractional tempo precisely', () => {
    // 100.5 BPM over 0.6s = 1.005 beats; phase 3 -> 4.005 -> wraps to 0.005.
    expect(projectPhase(3, 100.5, 4, 0.6)).toBeCloseTo(0.005, 5)
  })

  it('never runs time backwards for a negative elapsed', () => {
    expect(projectPhase(2, 120, 4, -1)).toBeCloseTo(2)
  })

  it('returns 0 for a non-positive tempo or quantum', () => {
    expect(projectPhase(2, 0, 4, 1)).toBe(0)
    expect(projectPhase(2, 120, 0, 1)).toBe(0)
  })
})

describe('secondsUntilDownbeat', () => {
  it('joins the next shared bar from a mid-bar phase', () => {
    // Phase 1 of 4 at 120 BPM (2 beats/sec): 3 beats to the downbeat = 1.5s.
    expect(secondsUntilDownbeat(1, 120, 4)).toBeCloseTo(1.5)
  })

  it('is zero when already on the downbeat', () => {
    expect(secondsUntilDownbeat(0, 120, 4)).toBe(0)
  })

  it('preserves phase across a tempo change — still targets the shared downbeat', () => {
    // Same phase, doubled tempo: still lands on phase 0, only the wall time halves.
    const slow = secondsUntilDownbeat(1, 120, 4)
    const fast = secondsUntilDownbeat(1, 240, 4)
    expect(fast).toBeCloseTo(slow / 2)
  })

  it('projects the phase to now before measuring, using fractional tempo', () => {
    // Phase 3.5 at 120 BPM, received 0.25s ago: +0.5 beat -> projected 0 -> on the downbeat.
    expect(secondsUntilDownbeat(3.5, 120, 4, 0.25)).toBe(0)
  })

  it('returns 0 for an unusable tempo', () => {
    expect(secondsUntilDownbeat(2, 0, 4)).toBe(0)
  })
})
