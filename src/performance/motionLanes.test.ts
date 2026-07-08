import { describe, expect, it } from 'vitest'
import { GestureCapture, MAX_MOTION_LANES, MOTION_PARAM_TARGETS } from './motionLanes'

const BASE = { position: 0.4, spray: 0.1, 'macro:cloud': 0 }

describe('GestureCapture', () => {
  it('creates a lane the first time a value deviates from the baseline', () => {
    const cap = new GestureCapture(BASE)
    cap.sample(0, BASE)                                  // nothing moved yet
    cap.sample(16, { ...BASE, position: 0.5 })           // position moves
    const lanes = cap.finish(1000)
    expect(lanes).toHaveLength(1)
    expect(lanes[0].target).toBe('position')
    expect(lanes[0].data.samples[0]).toEqual({ tMs: 16, value: 0.5 })
    expect(lanes[0].data.durationMs).toBe(1000)
  })

  it('keeps sampling a lane every call once created, even when the value returns to baseline', () => {
    const cap = new GestureCapture(BASE)
    cap.sample(0, { ...BASE, position: 0.5 })
    cap.sample(16, { ...BASE, position: 0.4 })           // back at baseline — still recorded
    const lanes = cap.finish(100)
    expect(lanes[0].data.samples).toHaveLength(2)
    expect(lanes[0].data.samples[1]).toEqual({ tMs: 16, value: 0.4 })
  })

  it('records macro targets', () => {
    const cap = new GestureCapture(BASE)
    cap.sample(0, { ...BASE, 'macro:cloud': 0.7 })
    expect(cap.finish(50)[0].target).toBe('macro:cloud')
  })

  it('caps lanes at MAX_MOTION_LANES; later movers are ignored', () => {
    const base = { a: 0, b: 0, c: 0, d: 0, e: 0 } as Record<string, number>
    const cap = new GestureCapture(base)
    cap.sample(0, { a: 1, b: 1, c: 1, d: 1, e: 0 })      // four movers → four lanes
    cap.sample(16, { a: 1, b: 1, c: 1, d: 1, e: 1 })     // fifth mover — ignored
    const lanes = cap.finish(100)
    expect(lanes).toHaveLength(MAX_MOTION_LANES)
    expect(lanes.map((l) => l.target)).not.toContain('e')
  })

  it('a take where nothing moves produces no lanes', () => {
    const cap = new GestureCapture(BASE)
    cap.sample(0, BASE)
    cap.sample(16, BASE)
    expect(cap.finish(100)).toHaveLength(0)
  })

  it('exports the param target list for consumers', () => {
    expect(MOTION_PARAM_TARGETS).toContain('position')
    expect(MOTION_PARAM_TARGETS).toHaveLength(5)
  })
})
