import { positionWithinRegion, viewportXToBuffer, type Viewport } from './waveformView'

// Inverse of the waveform playhead mapping (regionStart + position * span):
// converts a pointer x normalized over the whole waveform into the
// region-relative position the engine uses, so the playhead lands exactly
// under the pointer.
export function pointerToRegionPosition(normalized: number, regionStart: number, regionEnd: number): number {
  const span = regionEnd - regionStart
  if (span <= 0) return 1
  return Math.min(1, Math.max(0, (normalized - regionStart) / span))
}

// Viewport-aware variant: converts a pixel X within the visible slice into the
// region-relative position, routing through the current zoom/pan viewport.
// (When the viewport is full {0,1} and width is 1, this equals the whole-buffer
// mapping above.)
export function pointerToRegionPositionViewport(
  px: number,
  width: number,
  viewport: Viewport,
  region: { start: number; end: number },
): number {
  return positionWithinRegion(viewportXToBuffer(px, viewport, width), region)
}
