// Offline stress harness for the artifact audit. Renders a GranularCore through
// a timeline of segments, applying an operation (patch edit, source swap, …) at
// each segment boundary so a discontinuity can be attributed to the exact frame
// and the operation that preceded it. Pure/offline — Vitest-only.

import type { GranularCore } from './GranularCore'

export interface TimelineSegment {
  // Human-readable label for the operation applied at this boundary.
  label: string
  // How many frames to render in this segment.
  frames: number
  // Operation applied to the core just before this segment renders (the "change").
  before?: (core: GranularCore) => void
}

export interface TimelineMarker {
  frame: number
  label: string
}

export interface TimelineResult {
  left: Float32Array
  right: Float32Array
  markers: TimelineMarker[]
}

// Render the segments back-to-back in fixed-size blocks (default 128, the
// AudioWorklet render-quantum) so operations land on block boundaries exactly as
// they would when a main-thread message is handled between quanta.
export function renderTimeline(
  core: GranularCore,
  segments: TimelineSegment[],
  blockSize = 128,
): TimelineResult {
  const total = segments.reduce((sum, segment) => sum + segment.frames, 0)
  const left = new Float32Array(total)
  const right = new Float32Array(total)
  const markers: TimelineMarker[] = []

  let offset = 0
  for (const segment of segments) {
    if (segment.before) segment.before(core)
    markers.push({ frame: offset, label: segment.label })
    let remaining = segment.frames
    while (remaining > 0) {
      const n = Math.min(blockSize, remaining)
      core.process(left.subarray(offset, offset + n), right.subarray(offset, offset + n))
      offset += n
      remaining -= n
    }
  }

  return { left, right, markers }
}

// The label of the most recent operation at or before `frame`.
export function precedingOp(markers: TimelineMarker[], frame: number): string {
  let label = '(start)'
  for (const marker of markers) {
    if (marker.frame <= frame) label = marker.label
    else break
  }
  return label
}
