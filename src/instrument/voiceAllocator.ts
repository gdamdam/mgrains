// Deterministic, DOM-free polyphonic voice allocator for the chromatic
// instrument. It maps incoming notes to a fixed pool of voices, reusing free
// voices and stealing the oldest sounding voice when the pool is exhausted.
//
// Determinism: "age"/start-order comes from an internal monotonically
// increasing counter rather than wall-clock time, so a given sequence of
// noteOn/noteOff calls always yields the same allocation. No Date.now and no
// Math.random are used anywhere.

/** A snapshot of one sounding voice. */
export interface ActiveVoice {
  /** Index of the voice within the pool (0..voiceCount-1). */
  index: number
  /** The note currently sounding on this voice. */
  note: number
  /** The velocity the note was triggered with (0..1, defaults to 1). */
  velocity: number
  /** Monotonic start order; lower means started earlier (older). */
  age: number
}

interface VoiceSlot {
  note: number
  velocity: number
  age: number
  active: boolean
  // Identifies the input that owns this voice (e.g. 'kbd' vs 'midi'). Lets the
  // same pitch from different sources occupy independent voices so releasing
  // one input never silences a note still held by another.
  owner: string
}

export class VoiceAllocator {
  private readonly slots: VoiceSlot[]
  // Monotonic counter used as the start-order "age". Strictly increasing per
  // noteOn so the oldest active voice always has the smallest age.
  private clock = 0

  constructor(voiceCount: number) {
    if (!Number.isInteger(voiceCount) || voiceCount < 1) {
      throw new RangeError('voiceCount must be a positive integer')
    }
    this.slots = Array.from({ length: voiceCount }, () => ({
      note: -1,
      velocity: 0,
      age: 0,
      active: false,
      owner: '',
    }))
  }

  /**
   * Triggers a note and returns the assigned voice index.
   * - If the note is already sounding, its voice is retriggered (no new slot).
   * - Otherwise a free voice is used if available.
   * - If all voices are busy, the oldest-started voice is stolen.
   */
  noteOn(note: number, velocity = 1, owner = ''): number {
    const age = this.clock++

    // Retrigger an already-sounding note on its existing voice. The owner must
    // match too, so the same pitch from a different source gets its own voice.
    const existing = this.slots.findIndex(
      (slot) => slot.active && slot.note === note && slot.owner === owner,
    )
    if (existing !== -1) {
      const slot = this.slots[existing]
      slot.velocity = velocity
      slot.age = age
      return existing
    }

    // Prefer the first free voice.
    const free = this.slots.findIndex((slot) => !slot.active)
    const target = free !== -1 ? free : this.oldestActiveIndex()

    const slot = this.slots[target]
    slot.note = note
    slot.velocity = velocity
    slot.age = age
    slot.active = true
    slot.owner = owner
    return target
  }

  /**
   * Frees the voice sounding the given note.
   * Returns the freed voice index, or null when the note is not active.
   */
  noteOff(note: number, owner = ''): number | null {
    const index = this.slots.findIndex(
      (slot) => slot.active && slot.note === note && slot.owner === owner,
    )
    if (index === -1) {
      return null
    }
    this.slots[index].active = false
    return index
  }

  /**
   * Frees every active voice whose owner starts with `prefix` — e.g. all voices
   * held by a disconnected MIDI device (`midi:<id>:`). Returns true if any voice
   * was freed, so callers know whether to refresh downstream note state.
   */
  releaseOwnerPrefix(prefix: string): boolean {
    let released = false
    for (const slot of this.slots) {
      if (slot.active && slot.owner.startsWith(prefix)) {
        slot.active = false
        released = true
      }
    }
    return released
  }

  /** Snapshot of all sounding voices, ordered by ascending age (oldest first). */
  activeVoices(): ReadonlyArray<ActiveVoice> {
    return this.slots
      .map((slot, index) => ({ slot, index }))
      .filter(({ slot }) => slot.active)
      .sort((a, b) => a.slot.age - b.slot.age)
      .map(({ slot, index }) => ({
        index,
        note: slot.note,
        velocity: slot.velocity,
        age: slot.age,
      }))
  }

  /** Releases every voice. The age counter keeps advancing for determinism. */
  reset(): void {
    for (const slot of this.slots) {
      slot.active = false
      slot.note = -1
      slot.velocity = 0
      slot.age = 0
      slot.owner = ''
    }
  }

  // Index of the active voice with the smallest age (started earliest).
  private oldestActiveIndex(): number {
    let oldest = -1
    let oldestAge = Number.POSITIVE_INFINITY
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]
      if (slot.active && slot.age < oldestAge) {
        oldestAge = slot.age
        oldest = i
      }
    }
    return oldest
  }
}
