import { describe, expect, it } from 'vitest'
import { PATCH_RANGES } from '../audio/contracts'
import { MACROS } from '../audio/macros'
import {
  MIDI_TARGETS,
  MIDI_TARGET_BY_KEY,
  isMacroTarget,
} from './paramTargets'

describe('MIDI_TARGETS', () => {
  it('every non-macro key is a real PATCH_RANGES key', () => {
    for (const target of MIDI_TARGETS) {
      if (isMacroTarget(target.key)) continue
      expect(PATCH_RANGES).toHaveProperty(target.key)
    }
  })

  it('includes a slot for every macro', () => {
    for (const macro of MACROS) {
      expect(MIDI_TARGET_BY_KEY.has(`macro:${macro.id}`)).toBe(true)
    }
  })

  it('flags exponential-feel params as log and the rest as linear', () => {
    const log = new Set(
      MIDI_TARGETS.filter((t) => t.log).map((t) => t.key),
    )
    expect(log).toEqual(
      new Set(['grainSizeMs', 'densityHz', 'grainFilterHz', 'ringModHz', 'combFreq']),
    )
  })

  it('has unique keys and non-empty labels', () => {
    const keys = MIDI_TARGETS.map((t) => t.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const t of MIDI_TARGETS) expect(t.label.length).toBeGreaterThan(0)
  })

  it('macros are never log', () => {
    for (const t of MIDI_TARGETS) {
      if (isMacroTarget(t.key)) expect(t.log).toBe(false)
    }
  })
})
