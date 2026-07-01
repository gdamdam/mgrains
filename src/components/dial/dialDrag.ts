// Given the normalized value at drag start (0..1) and the vertical pixel delta
// (dy; positive = pointer moved DOWN), return the new normalized value.
// Dragging UP increases. sensitivityPx = pixels for a full 0..1 sweep.
export function dragNormalized(startNorm: number, dy: number, sensitivityPx = 200): number {
  const next = startNorm - dy / sensitivityPx
  return Math.min(1, Math.max(0, next))
}
