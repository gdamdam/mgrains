// Pure geometry for the waveform's horizontal zoom/pan and region editing.
// All coordinates are deterministic and NaN-guarded so the React component can
// stay a thin renderer. Two coordinate spaces are used:
//   - "buffer" fractions in [0,1] spanning the whole source buffer;
//   - "viewport X" pixels in [0, width] spanning only the visible slice.
// A Viewport is the buffer slice currently mapped onto the full pixel width.

export type Viewport = { start: number; end: number }

// Smallest visible slice (buffer fraction). Prevents zooming into a degenerate
// window where round-trips lose all precision.
export const MIN_VIEWPORT_WIDTH = 0.02
// Smallest selectable region (buffer fraction). Keeps start < end with a usable
// span the engine can scan.
export const MIN_REGION_WIDTH = 0.01

// Keyboard step sizes. zoomStep is a multiplier (>1 narrows the viewport);
// panStep and regionStep are buffer fractions per key press.
export const zoomStep = 1.5
export const panStep = 0.05
export const regionStep = 0.01

const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))

// Normalise any (possibly NaN/reversed/too-narrow) viewport into a valid one:
// ordered, width in [MIN_VIEWPORT_WIDTH, 1], shifted (not clipped) to stay in
// [0,1] so width is preserved wherever possible.
export function clampViewport(v: Viewport): Viewport {
  let start = isNum(v?.start) ? v.start : 0
  let end = isNum(v?.end) ? v.end : 1
  if (end < start) [start, end] = [end, start]
  // Already valid: return as-is so exact fractions survive round-trips (the
  // re-centering below introduces float error we don't want on the fast path).
  if (start >= 0 && end <= 1 && end - start >= MIN_VIEWPORT_WIDTH) {
    return { start, end }
  }
  const center = (start + end) / 2
  const width = Math.min(1, Math.max(MIN_VIEWPORT_WIDTH, end - start))
  start = center - width / 2
  end = center + width / 2
  // Shift the fixed-width window back inside [0,1] rather than clipping it.
  if (start < 0) { end -= start; start = 0 }
  if (end > 1) { start -= end - 1; end = 1 }
  return { start: clamp01(start), end: clamp01(end) }
}

// Zoom keeping `anchor` (a buffer point in [0,1]) stationary on screen: the
// anchor's fractional offset within the viewport is preserved. factor>1 zooms
// in (narrower), factor<1 zooms out.
export function zoomViewport(v: Viewport, factor: number, anchor: number): Viewport {
  const cur = clampViewport(v)
  if (!isNum(factor) || factor <= 0) return cur
  const width = cur.end - cur.start
  const a = isNum(anchor) ? clamp01(anchor) : (cur.start + cur.end) / 2
  const t = width > 0 ? (a - cur.start) / width : 0.5
  const newWidth = Math.min(1, Math.max(MIN_VIEWPORT_WIDTH, width / factor))
  const start = a - t * newWidth
  return clampViewport({ start, end: start + newWidth })
}

// Slide the viewport by a buffer-fraction delta, preserving width.
export function panViewport(v: Viewport, deltaFraction: number): Viewport {
  const cur = clampViewport(v)
  if (!isNum(deltaFraction)) return cur
  return clampViewport({ start: cur.start + deltaFraction, end: cur.end + deltaFraction })
}

// buffer fraction -> pixel X within the viewport. Not clamped: off-screen
// positions map outside [0,width] and are clipped by the SVG viewBox.
export function bufferToViewportX(pos0to1: number, v: Viewport, width: number): number {
  const cur = clampViewport(v)
  const span = cur.end - cur.start
  const p = isNum(pos0to1) ? pos0to1 : cur.start
  const w = isNum(width) ? width : 0
  return span > 0 ? ((p - cur.start) / span) * w : 0
}

// pixel X -> buffer fraction. Clamped into the visible slice.
export function viewportXToBuffer(px: number, v: Viewport, width: number): number {
  const cur = clampViewport(v)
  if (!isNum(px) || !isNum(width) || width <= 0) return cur.start
  const t = clamp01(px / width)
  return cur.start + t * (cur.end - cur.start)
}

// Region editing. Both keep start < end, enforce MIN_REGION_WIDTH, stay in [0,1].
export function moveRegionStart(region: { start: number; end: number }, newStartBuffer: number): { start: number; end: number } {
  const end = clamp01(isNum(region?.end) ? region.end : 1)
  let start = clamp01(isNum(newStartBuffer) ? newStartBuffer : 0)
  start = Math.max(0, Math.min(start, end - MIN_REGION_WIDTH))
  return { start, end }
}

export function moveRegionEnd(region: { start: number; end: number }, newEndBuffer: number): { start: number; end: number } {
  const start = clamp01(isNum(region?.start) ? region.start : 0)
  let end = clamp01(isNum(newEndBuffer) ? newEndBuffer : 1)
  end = Math.min(1, Math.max(end, start + MIN_REGION_WIDTH))
  return { start, end }
}

// Which region handle (if any) is within tolerancePx of pixel X. Ties favour
// the start handle so a fully-collapsed region can still be reopened.
export function hitTestHandle(
  px: number,
  region: { start: number; end: number },
  v: Viewport,
  width: number,
  tolerancePx: number,
): 'start' | 'end' | null {
  if (!isNum(px)) return null
  const tol = isNum(tolerancePx) ? tolerancePx : 0
  const dStart = Math.abs(px - bufferToViewportX(region.start, v, width))
  const dEnd = Math.abs(px - bufferToViewportX(region.end, v, width))
  if (dStart <= tol && dStart <= dEnd) return 'start'
  if (dEnd <= tol) return 'end'
  return null
}

// Position is stored RELATIVE to the selected region (preserves existing
// engine semantics): 0 = region start, 1 = region end.
export function positionWithinRegion(bufferPos: number, region: { start: number; end: number }): number {
  const start = clamp01(isNum(region?.start) ? region.start : 0)
  const end = clamp01(isNum(region?.end) ? region.end : 1)
  const span = end - start
  if (span <= 0) return 1
  const pos = isNum(bufferPos) ? bufferPos : start
  return clamp01((pos - start) / span)
}

// Inverse of positionWithinRegion: region-relative position -> buffer fraction.
export function regionPositionToBuffer(position: number, region: { start: number; end: number }): number {
  const start = clamp01(isNum(region?.start) ? region.start : 0)
  const end = clamp01(isNum(region?.end) ? region.end : 1)
  return start + clamp01(isNum(position) ? position : 0) * (end - start)
}

// Keyboard appliers, built from the step constants.
export const zoomIn = (v: Viewport, anchor: number): Viewport => zoomViewport(v, zoomStep, anchor)
export const zoomOut = (v: Viewport, anchor: number): Viewport => zoomViewport(v, 1 / zoomStep, anchor)
export const panLeft = (v: Viewport): Viewport => panViewport(v, -panStep)
export const panRight = (v: Viewport): Viewport => panViewport(v, panStep)
export const nudgeRegionStart = (region: { start: number; end: number }, dir: number): { start: number; end: number } =>
  moveRegionStart(region, region.start + (isNum(dir) ? dir : 0) * regionStep)
export const nudgeRegionEnd = (region: { start: number; end: number }, dir: number): { start: number; end: number } =>
  moveRegionEnd(region, region.end + (isNum(dir) ? dir : 0) * regionStep)
