import { describe, expect, it } from 'vitest'
import {
  MIN_REGION_WIDTH,
  MIN_VIEWPORT_WIDTH,
  bufferToViewportX,
  clampViewport,
  hitTestHandle,
  moveRegionEnd,
  moveRegionStart,
  nudgeRegionEnd,
  nudgeRegionStart,
  panViewport,
  positionWithinRegion,
  regionPositionToBuffer,
  viewportXToBuffer,
  zoomViewport,
} from './waveformView'

describe('clampViewport', () => {
  it('reorders a reversed viewport and preserves it in [0,1]', () => {
    expect(clampViewport({ start: 0.8, end: 0.2 })).toEqual({ start: 0.2, end: 0.8 })
  })

  it('replaces NaN edges with the full buffer', () => {
    expect(clampViewport({ start: NaN, end: NaN })).toEqual({ start: 0, end: 1 })
  })

  it('widens a too-narrow window to MIN_VIEWPORT_WIDTH, preserving width by shifting into range', () => {
    const v = clampViewport({ start: 0.999, end: 1 })
    expect(v.end - v.start).toBeCloseTo(MIN_VIEWPORT_WIDTH, 10)
    expect(v.end).toBe(1)
  })
})

describe('zoomViewport anchor stability', () => {
  it('keeps the anchor buffer point stationary in pixel space', () => {
    const v = { start: 0, end: 1 }
    const anchor = 0.3
    const width = 1000
    const before = bufferToViewportX(anchor, v, width)
    const zoomed = zoomViewport(v, 2, anchor)
    const after = bufferToViewportX(anchor, zoomed, width)
    expect(after).toBeCloseTo(before, 6)
    expect(zoomed.end - zoomed.start).toBeCloseTo(0.5, 10)
  })

  it('zooms out toward the full buffer and clamps to [0,1]', () => {
    const zoomed = zoomViewport({ start: 0.4, end: 0.6 }, 0.1, 0.5)
    expect(zoomed).toEqual({ start: 0, end: 1 })
  })

  it('ignores non-positive / NaN factors', () => {
    const v = { start: 0.2, end: 0.8 }
    expect(zoomViewport(v, 0, 0.5)).toEqual(v)
    expect(zoomViewport(v, NaN, 0.5)).toEqual(v)
  })
})

describe('panViewport', () => {
  it('preserves width and clamps at the right edge', () => {
    const v = panViewport({ start: 0.6, end: 0.8 }, 0.5)
    expect(v.end).toBe(1)
    expect(v.end - v.start).toBeCloseTo(0.2, 10)
  })

  it('preserves width and clamps at the left edge', () => {
    const v = panViewport({ start: 0.2, end: 0.4 }, -0.5)
    expect(v.start).toBe(0)
    expect(v.end - v.start).toBeCloseTo(0.2, 10)
  })

  it('ignores NaN deltas', () => {
    expect(panViewport({ start: 0.2, end: 0.4 }, NaN)).toEqual({ start: 0.2, end: 0.4 })
  })
})

describe('coordinate round-trip', () => {
  it('viewportXToBuffer inverts bufferToViewportX within the viewport', () => {
    const v = { start: 0.25, end: 0.75 }
    const width = 1000
    for (const pos of [0.25, 0.4, 0.5, 0.75]) {
      const px = bufferToViewportX(pos, v, width)
      expect(viewportXToBuffer(px, v, width)).toBeCloseTo(pos, 6)
    }
  })

  it('viewportXToBuffer clamps out-of-range pixels into the viewport', () => {
    const v = { start: 0.25, end: 0.75 }
    expect(viewportXToBuffer(-100, v, 1000)).toBe(0.25)
    expect(viewportXToBuffer(5000, v, 1000)).toBe(0.75)
  })

  it('guards zero width and NaN', () => {
    expect(viewportXToBuffer(NaN, { start: 0.1, end: 0.9 }, 1000)).toBe(0.1)
    expect(viewportXToBuffer(500, { start: 0.1, end: 0.9 }, 0)).toBe(0.1)
    expect(bufferToViewportX(NaN, { start: 0, end: 1 }, 1000)).toBe(0)
  })
})

describe('region editing', () => {
  it('moveRegionStart enforces MIN_REGION_WIDTH below end', () => {
    const r = moveRegionStart({ start: 0.2, end: 0.5 }, 0.9)
    expect(r.end).toBe(0.5)
    expect(r.start).toBeCloseTo(0.5 - MIN_REGION_WIDTH, 10)
    expect(r.start).toBeLessThan(r.end)
  })

  it('moveRegionEnd enforces MIN_REGION_WIDTH above start', () => {
    const r = moveRegionEnd({ start: 0.5, end: 0.8 }, 0.1)
    expect(r.start).toBe(0.5)
    expect(r.end).toBeCloseTo(0.5 + MIN_REGION_WIDTH, 10)
    expect(r.end).toBeGreaterThan(r.start)
  })

  it('keeps edits within [0,1]', () => {
    expect(moveRegionStart({ start: 0.2, end: 0.5 }, -1).start).toBe(0)
    expect(moveRegionEnd({ start: 0.2, end: 0.5 }, 5).end).toBe(1)
  })

  it('nudges step the correct edge and direction', () => {
    expect(nudgeRegionStart({ start: 0.3, end: 0.7 }, 1).start).toBeCloseTo(0.31, 10)
    expect(nudgeRegionEnd({ start: 0.3, end: 0.7 }, -1).end).toBeCloseTo(0.69, 10)
  })
})

describe('hitTestHandle', () => {
  const v = { start: 0, end: 1 }
  const region = { start: 0.25, end: 0.75 }
  const width = 1000

  it('detects the start handle within tolerance', () => {
    expect(hitTestHandle(255, region, v, width, 20)).toBe('start')
  })

  it('detects the end handle within tolerance', () => {
    expect(hitTestHandle(745, region, v, width, 20)).toBe('end')
  })

  it('returns null when far from both handles', () => {
    expect(hitTestHandle(500, region, v, width, 20)).toBeNull()
  })

  it('favours the start handle on a tie / collapsed region', () => {
    const collapsed = { start: 0.5, end: 0.5 + MIN_REGION_WIDTH }
    expect(hitTestHandle(500, collapsed, v, width, 20)).toBe('start')
  })

  it('guards NaN pixel input', () => {
    expect(hitTestHandle(NaN, region, v, width, 20)).toBeNull()
  })
})

describe('position within region (relative semantics)', () => {
  it('round-trips a relative position through buffer space', () => {
    const region = { start: 0.25, end: 0.75 }
    const buf = regionPositionToBuffer(0.3, region)
    expect(buf).toBeCloseTo(0.4, 10)
    expect(positionWithinRegion(buf, region)).toBeCloseTo(0.3, 10)
  })

  it('clamps out-of-region buffer positions to edges', () => {
    const region = { start: 0.25, end: 0.75 }
    expect(positionWithinRegion(0.1, region)).toBe(0)
    expect(positionWithinRegion(0.95, region)).toBe(1)
  })

  it('degrades safely on a zero-width region', () => {
    expect(positionWithinRegion(0.5, { start: 0.4, end: 0.4 })).toBe(1)
  })
})
