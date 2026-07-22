import { describe, expect, it } from 'vitest'
import { PATCH_RANGES } from '../audio/contracts'
import {
  MIDI_MAPPINGS_SCHEMA_VERSION,
  applyLearn,
  deserializeMidiMappings,
  matchMapping,
  parseControlChange,
  removeMapping,
  scaleCcToTarget,
  serializeMidiMappings,
  type MidiMapping,
} from './midiMapping'

describe('parseControlChange', () => {
  it('parses a CC on each channel', () => {
    expect(parseControlChange(0xb0, 74, 100)).toEqual({ channel: 0, cc: 74, value: 100 })
    expect(parseControlChange(0xbf, 1, 0)).toEqual({ channel: 15, cc: 1, value: 0 })
  })

  it('rejects non-CC status bytes', () => {
    expect(parseControlChange(0x90, 60, 100)).toBeNull() // note on
    expect(parseControlChange(0xe0, 0, 64)).toBeNull() // pitch bend
    expect(parseControlChange(0xf0, 0, 0)).toBeNull() // system
  })

  it('masks data bytes to 7 bits', () => {
    expect(parseControlChange(0xb0, 0xff, 0xff)).toEqual({ channel: 0, cc: 127, value: 127 })
  })
})

describe('scaleCcToTarget', () => {
  it('linear maps endpoints and midpoint', () => {
    // position range [0,1]
    expect(scaleCcToTarget(0, 'position')).toBeCloseTo(0)
    expect(scaleCcToTarget(127, 'position')).toBeCloseTo(1)
    expect(scaleCcToTarget(64, 'position')).toBeCloseTo(64 / 127)
  })

  it('linear maps a signed range (scanSpeed [-2,2])', () => {
    expect(scaleCcToTarget(0, 'scanSpeed')).toBeCloseTo(-2)
    expect(scaleCcToTarget(127, 'scanSpeed')).toBeCloseTo(2)
    expect(scaleCcToTarget(64, 'scanSpeed')).toBeCloseTo(-2 + (64 / 127) * 4)
  })

  it('log maps geometrically for frequency params', () => {
    const [min, max] = PATCH_RANGES.densityHz
    expect(scaleCcToTarget(0, 'densityHz')).toBeCloseTo(min)
    expect(scaleCcToTarget(127, 'densityHz')).toBeCloseTo(max)
    // geometric midpoint = sqrt(min*max), well below the arithmetic midpoint
    expect(scaleCcToTarget(64, 'densityHz')).toBeLessThan((min + max) / 2)
    expect(scaleCcToTarget(64, 'densityHz')).toBeCloseTo(min * Math.pow(max / min, 64 / 127))
  })

  it('macros scale over unit range, linear', () => {
    expect(scaleCcToTarget(0, 'macro:cloud')).toBeCloseTo(0)
    expect(scaleCcToTarget(127, 'macro:cloud')).toBeCloseTo(1)
    expect(scaleCcToTarget(64, 'macro:cloud')).toBeCloseTo(64 / 127)
  })

  it('clamps out-of-range CC input', () => {
    expect(scaleCcToTarget(-10, 'position')).toBeCloseTo(0)
    expect(scaleCcToTarget(999, 'position')).toBeCloseTo(1)
  })

  it('unknown non-macro target falls back to unit linear', () => {
    expect(scaleCcToTarget(127, 'nope')).toBeCloseTo(1)
    expect(scaleCcToTarget(0, 'nope')).toBeCloseTo(0)
  })

  it('non-finite input is treated as 0', () => {
    expect(scaleCcToTarget(Number.NaN, 'position')).toBeCloseTo(0)
  })
})

describe('matchMapping', () => {
  const mappings: MidiMapping[] = [
    { cc: 74, channel: null, target: 'position' },
    { cc: 74, channel: 3, target: 'drive' },
    { cc: 1, channel: 0, target: 'space' },
  ]

  it('exact channel wins over any-channel', () => {
    expect(matchMapping(mappings, 3, 74)?.target).toBe('drive')
  })

  it('falls back to any-channel when no exact match', () => {
    expect(matchMapping(mappings, 9, 74)?.target).toBe('position')
  })

  it('unmapped cc returns undefined (harmless)', () => {
    expect(matchMapping(mappings, 0, 127)).toBeUndefined()
  })

  it('concrete channel with no any fallback returns undefined off-channel', () => {
    expect(matchMapping(mappings, 5, 1)).toBeUndefined()
    expect(matchMapping(mappings, 0, 1)?.target).toBe('space')
  })
})

describe('applyLearn', () => {
  it('adds a new mapping', () => {
    const next = applyLearn([], 'drive', { channel: 0, cc: 20 })
    expect(next).toEqual([{ cc: 20, channel: 0, target: 'drive' }])
  })

  it('replaces the existing mapping for the same target', () => {
    const start: MidiMapping[] = [{ cc: 20, channel: 0, target: 'drive' }]
    const next = applyLearn(start, 'drive', { channel: 1, cc: 30 })
    expect(next).toEqual([{ cc: 30, channel: 1, target: 'drive' }])
  })

  it('steals a cc already bound to another target (overlapping channel)', () => {
    const start: MidiMapping[] = [{ cc: 20, channel: 0, target: 'space' }]
    const next = applyLearn(start, 'drive', { channel: 0, cc: 20 })
    expect(next).toEqual([{ cc: 20, channel: 0, target: 'drive' }])
  })

  it('an any-channel learn steals a concrete-channel binding on the same cc', () => {
    const start: MidiMapping[] = [{ cc: 20, channel: 5, target: 'space' }]
    const next = applyLearn(start, 'drive', { channel: null, cc: 20 })
    expect(next).toEqual([{ cc: 20, channel: null, target: 'drive' }])
  })

  it('keeps a same-cc mapping on a non-overlapping channel', () => {
    const start: MidiMapping[] = [{ cc: 20, channel: 2, target: 'space' }]
    const next = applyLearn(start, 'drive', { channel: 5, cc: 20 })
    expect(next).toContainEqual({ cc: 20, channel: 2, target: 'space' })
    expect(next).toContainEqual({ cc: 20, channel: 5, target: 'drive' })
  })

  it('does not mutate the input', () => {
    const start: MidiMapping[] = [{ cc: 20, channel: 0, target: 'drive' }]
    applyLearn(start, 'space', { channel: 0, cc: 21 })
    expect(start).toEqual([{ cc: 20, channel: 0, target: 'drive' }])
  })
})

describe('removeMapping', () => {
  const start: MidiMapping[] = [
    { cc: 20, channel: 0, target: 'drive' },
    { cc: 21, channel: null, target: 'space' },
  ]

  it('removes by target', () => {
    expect(removeMapping(start, 'drive')).toEqual([{ cc: 21, channel: null, target: 'space' }])
  })

  it('removes by index', () => {
    expect(removeMapping(start, 0)).toEqual([{ cc: 21, channel: null, target: 'space' }])
  })

  it('unknown target/index is a harmless copy', () => {
    expect(removeMapping(start, 'nope')).toEqual(start)
    expect(removeMapping(start, 99)).toEqual(start)
  })
})

describe('serialize / deserialize', () => {
  const mappings: MidiMapping[] = [
    { cc: 74, channel: null, target: 'position' },
    { cc: 20, channel: 3, target: 'macro:cloud' },
  ]

  it('round-trips', () => {
    expect(deserializeMidiMappings(serializeMidiMappings(mappings))).toEqual(mappings)
  })

  it('writes the current schema version', () => {
    const parsed = JSON.parse(serializeMidiMappings(mappings))
    expect(parsed.schemaVersion).toBe(MIDI_MAPPINGS_SCHEMA_VERSION)
  })

  it('accepts a parsed object as well as a string', () => {
    const obj = { schemaVersion: 1, mappings }
    expect(deserializeMidiMappings(obj)).toEqual(mappings)
  })

  it('migrates a legacy bare array (no envelope)', () => {
    expect(deserializeMidiMappings(mappings)).toEqual(mappings)
  })

  it('drops malformed entries but keeps good ones', () => {
    const raw = {
      schemaVersion: 1,
      mappings: [
        { cc: 74, channel: null, target: 'position' }, // ok
        { cc: 200, channel: 0, target: 'drive' }, // cc out of range
        { cc: 20, channel: 16, target: 'space' }, // channel out of range
        { cc: 5, channel: 0, target: '' }, // empty target
        { cc: 1.5, channel: 0, target: 'damp' }, // non-integer cc
        { channel: 0, target: 'crush' }, // missing cc
        'garbage',
        null,
      ],
    }
    expect(deserializeMidiMappings(raw)).toEqual([{ cc: 74, channel: null, target: 'position' }])
  })

  it('returns [] for unrecognizable input', () => {
    expect(deserializeMidiMappings(undefined)).toEqual([])
    expect(deserializeMidiMappings(42)).toEqual([])
    expect(deserializeMidiMappings('not json {')).toEqual([])
    expect(deserializeMidiMappings({})).toEqual([])
  })

  it('preserves an unknown/future target key on round-trip', () => {
    const future: MidiMapping[] = [{ cc: 9, channel: 0, target: 'macro:futuristic' }]
    expect(deserializeMidiMappings(serializeMidiMappings(future))).toEqual(future)
  })
})
