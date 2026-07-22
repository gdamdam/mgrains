import { describe, expect, it } from 'vitest'
import {
  dragEnter,
  dragLeave,
  isOverlayVisible,
  looksLikeAudio,
  transferHasFiles,
  validateDrop,
} from './dropTarget'

describe('looksLikeAudio', () => {
  it('accepts audio/* MIME regardless of extension', () => {
    expect(looksLikeAudio({ name: 'x.wav', type: 'audio/wav' })).toBe(true)
    expect(looksLikeAudio({ name: 'weird', type: 'audio/mpeg' })).toBe(true)
  })
  it('accepts audio-only containers reported as video/* or application/ogg', () => {
    expect(looksLikeAudio({ name: 'clip.webm', type: 'video/webm' })).toBe(true)
    expect(looksLikeAudio({ name: 'track.ogg', type: 'application/ogg' })).toBe(true)
  })
  it('is lenient about empty / octet-stream MIME (decode decides)', () => {
    expect(looksLikeAudio({ name: 'sample.flac', type: '' })).toBe(true)
    expect(looksLikeAudio({ name: 'noext', type: '' })).toBe(true)
    expect(looksLikeAudio({ name: 'a.wav', type: 'application/octet-stream' })).toBe(true)
  })
  it('rejects confident non-audio by MIME family', () => {
    expect(looksLikeAudio({ name: 'photo.png', type: 'image/png' })).toBe(false)
    expect(looksLikeAudio({ name: 'notes.txt', type: 'text/plain' })).toBe(false)
    expect(looksLikeAudio({ name: 'doc.pdf', type: 'application/pdf' })).toBe(false)
  })
  it('rejects confident non-audio by extension when MIME is unhelpful', () => {
    expect(looksLikeAudio({ name: 'photo.png', type: '' })).toBe(false)
    expect(looksLikeAudio({ name: 'movie.mov', type: 'application/octet-stream' })).toBe(false)
  })
})

describe('validateDrop', () => {
  it('accepts exactly one audio file', () => {
    expect(validateDrop([{ name: 'a.wav', type: 'audio/wav' }])).toEqual({ ok: true, index: 0 })
  })
  it('rejects empty drops', () => {
    expect(validateDrop([])).toEqual({ ok: false, error: expect.stringContaining('No file') })
  })
  it('rejects multiple files', () => {
    const r = validateDrop([
      { name: 'a.wav', type: 'audio/wav' },
      { name: 'b.wav', type: 'audio/wav' },
    ])
    expect(r.ok).toBe(false)
  })
  it('rejects directories', () => {
    const r = validateDrop([{ name: 'folder', type: '', isDirectory: true }])
    expect(r).toEqual({ ok: false, error: expect.stringContaining('Folders') })
  })
  it('rejects unsupported media', () => {
    const r = validateDrop([{ name: 'photo.png', type: 'image/png' }])
    expect(r.ok).toBe(false)
  })
})

describe('transferHasFiles', () => {
  it('true only when the transfer types include Files', () => {
    expect(transferHasFiles(['Files'])).toBe(true)
    expect(transferHasFiles(['text/plain'])).toBe(false)
    expect(transferHasFiles(null)).toBe(false)
    expect(transferHasFiles(undefined)).toBe(false)
  })
})

describe('nested drag depth', () => {
  it('increments/decrements and clamps at zero', () => {
    let d = 0
    d = dragEnter(d)
    d = dragEnter(d) // entered a child too
    expect(isOverlayVisible(d)).toBe(true)
    d = dragLeave(d)
    expect(isOverlayVisible(d)).toBe(true) // still inside outer
    d = dragLeave(d)
    expect(isOverlayVisible(d)).toBe(false)
    d = dragLeave(d) // extra leave can't go negative
    expect(d).toBe(0)
    expect(isOverlayVisible(d)).toBe(false)
  })
})
