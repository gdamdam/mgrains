import { describe, expect, it } from 'vitest'
import { barsToMs, MotionRecorder, resolvePresetMotion } from './motion'

function recordThree(): MotionRecorder {
  const m = new MotionRecorder()
  m.start()
  m.record(0, 0)
  m.record(100, 0.5)
  m.record(200, 1)
  m.stop()
  return m
}

describe('MotionRecorder.value', () => {
  it('returns each sample value at its own tMs', () => {
    const m = recordThree()
    expect(m.value(0)).toBe(0)
    expect(m.value(100)).toBe(0.5)
    expect(m.value(200)).toBe(1)
  })

  it('linearly interpolates the midpoint between two samples', () => {
    const m = recordThree()
    expect(m.value(50)).toBeCloseTo(0.25, 10)
    expect(m.value(150)).toBeCloseTo(0.75, 10)
  })

  it('clamps before the first and after the last sample', () => {
    const m = recordThree()
    expect(m.value(-100)).toBe(0)
    expect(m.value(99999)).toBe(1)
  })

  it('wraps elapsedMs modulo loopMs', () => {
    const m = recordThree()
    const loopMs = 200
    for (const t of [0, 25, 50, 137, 199]) {
      expect(m.value(t + loopMs, loopMs)).toBeCloseTo(m.value(t, loopMs) as number, 10)
      expect(m.value(t + loopMs * 3, loopMs)).toBeCloseTo(m.value(t, loopMs) as number, 10)
    }
  })

  it('returns null when there are no samples', () => {
    const m = new MotionRecorder()
    expect(m.value(0)).toBeNull()
    expect(m.value(100, 200)).toBeNull()
  })
})

describe('MotionRecorder lifecycle', () => {
  it('start/reset clears previous samples', () => {
    const m = recordThree()
    m.reset()
    expect(m.value(100)).toBeNull()
    m.start()
    m.record(0, 0.2)
    expect(m.value(0)).toBe(0.2)
  })

  it('clear removes all samples', () => {
    const m = recordThree()
    m.clear()
    expect(m.value(100)).toBeNull()
  })

  it('stop computes duration from the last sample', () => {
    const m = recordThree()
    expect(m.serialize().durationMs).toBe(200)
  })
})

describe('MotionRecorder serialization', () => {
  it('serialize round-trips through deserialize and reproduces value()', () => {
    const m = recordThree()
    const data = m.serialize()
    const json = JSON.parse(JSON.stringify(data)) as ReturnType<MotionRecorder['serialize']>
    const restored = MotionRecorder.deserialize(json)
    for (const t of [-50, 0, 37, 100, 150, 200, 9999]) {
      expect(restored.value(t)).toBe(m.value(t))
    }
    expect(restored.serialize()).toEqual(data)
  })
})

describe('barsToMs', () => {
  it('converts one bar at 120 bpm to 2000ms', () => {
    expect(barsToMs(1, 120)).toBe(2000)
  })
})

describe('resolvePresetMotion', () => {
  it('swaps in a preset recording when it carries motion', () => {
    const source = recordThree().serialize()
    const result = resolvePresetMotion(source)

    expect(result.hasMotion).toBe(true)
    expect(result.loopMs).toBe(source.durationMs)
    expect(result.recorder.value(100)).toBe(0.5)
    expect(result.recorder.serialize()).toEqual(source)
  })

  it('clears the lane for a preset without motion', () => {
    const result = resolvePresetMotion(undefined)

    expect(result.hasMotion).toBe(false)
    expect(result.loopMs).toBe(0)
    expect(result.recorder.value(0)).toBeNull()
    expect(result.recorder.serialize()).toEqual({ samples: [], durationMs: 0 })
  })

  it('treats an empty (zero-duration) recording as no motion', () => {
    const result = resolvePresetMotion({ samples: [], durationMs: 0 })

    expect(result.hasMotion).toBe(false)
    expect(result.loopMs).toBe(0)
  })
})
