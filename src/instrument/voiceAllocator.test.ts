import { describe, expect, it } from 'vitest'
import { VoiceAllocator } from './voiceAllocator'

describe('VoiceAllocator', () => {
  it('assigns distinct voices for distinct notes up to voiceCount', () => {
    const alloc = new VoiceAllocator(4)
    const indices = [60, 62, 64, 65].map((note) => alloc.noteOn(note))

    expect(new Set(indices).size).toBe(4)
    expect(indices.every((index) => index >= 0 && index < 4)).toBe(true)
    expect(alloc.activeVoices()).toHaveLength(4)
  })

  it('reuses a freed voice after noteOff', () => {
    const alloc = new VoiceAllocator(2)
    const first = alloc.noteOn(60)
    alloc.noteOn(62)

    const freed = alloc.noteOff(60)
    expect(freed).toBe(first)

    const reused = alloc.noteOn(67)
    expect(reused).toBe(first)
    expect(alloc.activeVoices()).toHaveLength(2)
  })

  it('steals the oldest voice when all are busy', () => {
    const alloc = new VoiceAllocator(3)
    const oldest = alloc.noteOn(60) // started first -> oldest
    alloc.noteOn(62)
    alloc.noteOn(64)

    const stolen = alloc.noteOn(67)
    expect(stolen).toBe(oldest)

    const active = alloc.activeVoices()
    expect(active).toHaveLength(3)
    // The stolen voice now carries the new note, and 60 is gone.
    expect(active.map((voice) => voice.note).sort((a, b) => a - b)).toEqual([
      62, 64, 67,
    ])
    expect(active.find((voice) => voice.index === oldest)?.note).toBe(67)
  })

  it('returns null for noteOff on an inactive note', () => {
    const alloc = new VoiceAllocator(4)
    alloc.noteOn(60)

    expect(alloc.noteOff(99)).toBeNull()
  })

  it('retriggers an already-sounding note on the same voice without extra allocation', () => {
    const alloc = new VoiceAllocator(4)
    const first = alloc.noteOn(60, 0.5)

    const retrigger = alloc.noteOn(60, 0.9)
    expect(retrigger).toBe(first)
    expect(alloc.activeVoices()).toHaveLength(1)
    expect(alloc.activeVoices()[0].velocity).toBe(0.9)
  })

  it('reset clears all active voices', () => {
    const alloc = new VoiceAllocator(3)
    alloc.noteOn(60)
    alloc.noteOn(62)

    alloc.reset()

    expect(alloc.activeVoices()).toHaveLength(0)
    // After reset the first note again takes a fresh voice.
    const index = alloc.noteOn(64)
    expect(index).toBeGreaterThanOrEqual(0)
    expect(alloc.activeVoices()).toHaveLength(1)
  })

  it('orders ages deterministically by start sequence', () => {
    const alloc = new VoiceAllocator(2)
    alloc.noteOn(60)
    alloc.noteOn(62)

    const ages = alloc.activeVoices().map((voice) => voice.age)
    expect(ages[0]).toBeLessThan(ages[1])
  })

  it('gives the same note from two owners independent voices', () => {
    const alloc = new VoiceAllocator(4)
    alloc.noteOn(60, 1, 'kbd')
    alloc.noteOn(60, 1, 'midi')

    expect(alloc.activeVoices()).toHaveLength(2)
  })

  it('releasing one owner leaves the other owner still sounding the note', () => {
    const alloc = new VoiceAllocator(4)
    alloc.noteOn(60, 1, 'kbd')
    alloc.noteOn(60, 1, 'midi')

    alloc.noteOff(60, 'kbd')

    const active = alloc.activeVoices()
    expect(active).toHaveLength(1)
    expect(active[0].note).toBe(60)
  })

  it('noteOff from a non-owning source returns null and frees nothing', () => {
    const alloc = new VoiceAllocator(4)
    alloc.noteOn(60, 1, 'kbd')

    expect(alloc.noteOff(60, 'midi')).toBeNull()
    expect(alloc.activeVoices()).toHaveLength(1)
  })

  it('retrigger only affects the same owner', () => {
    const alloc = new VoiceAllocator(4)
    const kbd = alloc.noteOn(60, 1, 'kbd')
    const midi = alloc.noteOn(60, 1, 'midi')

    expect(midi).not.toBe(kbd)

    // Retriggering 'kbd' reuses the kbd voice, not the midi one.
    expect(alloc.noteOn(60, 0.5, 'kbd')).toBe(kbd)
    expect(alloc.activeVoices()).toHaveLength(2)
  })
})
