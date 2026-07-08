// Inverse of the waveform playhead mapping (regionStart + position * span):
// converts a pointer x normalized over the whole waveform into the
// region-relative position the engine uses, so the playhead lands exactly
// under the pointer.
export function pointerToRegionPosition(normalized: number, regionStart: number, regionEnd: number): number {
  const span = regionEnd - regionStart
  if (span <= 0) return 1
  return Math.min(1, Math.max(0, (normalized - regionStart) / span))
}
