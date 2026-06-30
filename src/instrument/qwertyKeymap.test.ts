import { describe, expect, it } from 'vitest'
import {
  KEY_TO_SEMITONE,
  OCTAVE_KEYS,
  VELOCITY_KEYS,
  controlForKey,
  isEditableTarget,
  isNoteKey,
  keyToSemitone,
} from './qwertyKeymap'

describe('keyToSemitone', () => {
  it('maps the lower note row starting at C', () => {
    expect(keyToSemitone('KeyA')).toBe(0)
    expect(keyToSemitone('KeyW')).toBe(1)
    expect(keyToSemitone('KeyS')).toBe(2)
  })

  it('maps the upper note row continuing past the octave', () => {
    expect(keyToSemitone('KeyK')).toBe(12)
    expect(keyToSemitone('Semicolon')).toBe(16)
  })

  it('returns null for non-note keys and gaps in the layout', () => {
    expect(keyToSemitone('KeyR')).toBe(null)
    expect(keyToSemitone('KeyI')).toBe(null)
    expect(keyToSemitone('Enter')).toBe(null)
  })

  it('exposes a mapping table consistent with keyToSemitone', () => {
    for (const [code, semitone] of Object.entries(KEY_TO_SEMITONE)) {
      expect(keyToSemitone(code)).toBe(semitone)
    }
  })
})

describe('isNoteKey', () => {
  it('is true for a note key', () => {
    expect(isNoteKey('KeyA')).toBe(true)
  })

  it('is false for a control key', () => {
    expect(isNoteKey('KeyZ')).toBe(false)
  })
})

describe('controlForKey', () => {
  it('identifies octave intent', () => {
    expect(controlForKey('KeyZ')).toBe('octave-down')
    expect(controlForKey('KeyX')).toBe('octave-up')
  })

  it('identifies velocity intent', () => {
    expect(controlForKey('KeyC')).toBe('velocity-down')
    expect(controlForKey('KeyV')).toBe('velocity-up')
  })

  it('returns null for a note key', () => {
    expect(controlForKey('KeyA')).toBe(null)
  })

  it('exposes the control key constants', () => {
    expect(OCTAVE_KEYS).toEqual({ down: 'KeyZ', up: 'KeyX' })
    expect(VELOCITY_KEYS).toEqual({ down: 'KeyC', up: 'KeyV' })
  })
})

describe('isEditableTarget', () => {
  it('matches text/select form controls by tag name', () => {
    expect(isEditableTarget({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true)
    expect(isEditableTarget({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true)
    expect(isEditableTarget({ tagName: 'SELECT' } as unknown as EventTarget)).toBe(true)
  })

  it('matches contenteditable elements', () => {
    expect(isEditableTarget(
      { tagName: 'DIV', isContentEditable: true } as unknown as EventTarget,
    )).toBe(true)
  })

  it('ignores non-editable elements and null', () => {
    expect(isEditableTarget({ tagName: 'BUTTON' } as unknown as EventTarget)).toBe(false)
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: false } as unknown as EventTarget)).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
  })
})
