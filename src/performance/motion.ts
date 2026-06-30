// Deterministic one-lane motion automation recorder/player.
// Pure logic: no DOM, no timers, no Date.now/Math.random. Identical inputs
// always yield identical outputs so recordings can be serialized and replayed.

export interface MotionSample {
  tMs: number
  value: number
}

export interface MotionData {
  samples: MotionSample[]
  durationMs: number
}

// Convert a number of bars to milliseconds, assuming 4 beats per bar.
// Used to derive loop lengths (1..16 bars) from a tempo.
export function barsToMs(bars: number, bpm: number): number {
  return bars * 4 * (60000 / bpm)
}

export class MotionRecorder {
  private samples: MotionSample[] = []
  private durationMs = 0

  // Begin a fresh recording, discarding any prior samples.
  start(): void {
    this.clear()
  }

  // Alias for start(): semantic clarity at call sites that "reset" a lane.
  reset(): void {
    this.clear()
  }

  // Append a sample. Caller supplies monotonically increasing tMs near 0.
  record(tMs: number, value: number): void {
    this.samples.push({ tMs, value })
  }

  // Finalize the recording; duration is the timestamp of the last sample.
  stop(): void {
    this.durationMs = this.samples.length > 0
      ? this.samples[this.samples.length - 1].tMs
      : 0
  }

  // Remove all samples and reset duration.
  clear(): void {
    this.samples = []
    this.durationMs = 0
  }

  // Interpolated value at elapsedMs. With loopMs > 0, elapsedMs wraps modulo
  // loopMs first. Linear interpolation between adjacent samples; clamps to the
  // first/last sample outside the recorded range. Null when no samples exist.
  value(elapsedMs: number, loopMs?: number): number | null {
    if (this.samples.length === 0) return null

    let t = elapsedMs
    if (loopMs !== undefined && loopMs > 0) {
      // Euclidean modulo so negative elapsed values still wrap into [0, loopMs).
      t = ((elapsedMs % loopMs) + loopMs) % loopMs
    }

    const first = this.samples[0]
    if (t <= first.tMs) return first.value

    const last = this.samples[this.samples.length - 1]
    if (t >= last.tMs) return last.value

    // Find the bracketing pair [a, b] with a.tMs <= t < b.tMs.
    for (let i = 1; i < this.samples.length; i += 1) {
      const b = this.samples[i]
      if (t <= b.tMs) {
        const a = this.samples[i - 1]
        const span = b.tMs - a.tMs
        if (span <= 0) return b.value
        const ratio = (t - a.tMs) / span
        return a.value + (b.value - a.value) * ratio
      }
    }

    return last.value
  }

  // Plain JSON-able snapshot of this recording.
  serialize(): MotionData {
    return {
      samples: this.samples.map((s) => ({ tMs: s.tMs, value: s.value })),
      durationMs: this.durationMs,
    }
  }

  // Rebuild a recorder from serialize() output.
  static deserialize(data: MotionData): MotionRecorder {
    const m = new MotionRecorder()
    m.samples = data.samples.map((s) => ({ tMs: s.tMs, value: s.value }))
    m.durationMs = data.durationMs
    return m
  }
}

// The motion-lane state a preset load should produce. Loading any preset replaces
// the lane wholesale: a preset carrying a non-empty recording swaps it in; one
// without (or with an empty recording) clears the lane so no stale automation
// survives. `loopMs` is the playback loop length and `hasMotion` gates the UI's
// motion transport.
export interface PresetMotionState {
  recorder: MotionRecorder
  loopMs: number
  hasMotion: boolean
}

export function resolvePresetMotion(motion: MotionData | undefined): PresetMotionState {
  if (motion && motion.durationMs > 0) {
    return {
      recorder: MotionRecorder.deserialize(motion),
      loopMs: motion.durationMs,
      hasMotion: true,
    }
  }
  return { recorder: new MotionRecorder(), loopMs: 0, hasMotion: false }
}
