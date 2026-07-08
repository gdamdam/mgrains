// Multi-lane gesture capture over the motion system. Pure logic: no DOM, no
// timers, no Date.now/Math.random (same contract as motion.ts). One "take"
// records up to MAX_MOTION_LANES lanes; a lane is born the first frame its
// target's value deviates from the record-press baseline (no backfill).

import { MotionRecorder } from './motion'
import type { MotionData, MotionSample } from './motion'

export const MOTION_PARAM_TARGETS = [
  'position', 'spray', 'grainSizeMs', 'densityHz', 'pitchSpreadSemitones',
] as const

export type MotionParamTarget = typeof MOTION_PARAM_TARGETS[number]
export type MotionTarget = MotionParamTarget | `macro:${string}`

export interface MotionLane {
  target: MotionTarget
  data: MotionData
}

export const MAX_MOTION_LANES = 4

export class GestureCapture {
  private readonly baseline: Record<string, number>
  private readonly lanes = new Map<string, MotionSample[]>()

  constructor(baseline: Record<string, number>) {
    this.baseline = { ...baseline }
  }

  // Call once per animation frame with the take-relative timestamp and the
  // current value of every watched target. First deviation creates a lane
  // (until the cap); existing lanes record every call thereafter.
  sample(tMs: number, values: Record<string, number>): void {
    for (const target of Object.keys(values)) {
      const value = values[target]
      if (!Number.isFinite(value)) continue
      const lane = this.lanes.get(target)
      if (lane) {
        lane.push({ tMs, value })
        continue
      }
      if (this.lanes.size >= MAX_MOTION_LANES) continue
      if (target in this.baseline && value !== this.baseline[target]) {
        this.lanes.set(target, [{ tMs, value }])
      }
    }
  }

  // All lanes share the take's duration so playback loops them in lockstep.
  finish(durationMs: number): MotionLane[] {
    const duration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0
    return [...this.lanes.entries()].map(([target, samples]) => ({
      target: target as MotionTarget,
      data: { samples: samples.map((s) => ({ tMs: s.tMs, value: s.value })), durationMs: duration },
    }))
  }
}

export interface MotionLanePlayback {
  target: MotionTarget
  recorder: MotionRecorder
}

// Loading any preset/session replaces the lane set wholesale (same contract as
// the old resolvePresetMotion): non-empty lanes swap in, anything else clears.
export function resolveMotionLanes(lanes: MotionLane[] | undefined): {
  lanes: MotionLanePlayback[]
  loopMs: number
  hasMotion: boolean
} {
  const playable = (lanes ?? [])
    .filter((lane) => lane.data.durationMs > 0 && lane.data.samples.length > 0)
    .map((lane) => ({ target: lane.target, recorder: MotionRecorder.deserialize(lane.data) }))
  const loopMs = playable.reduce((max, lane) => Math.max(max, lane.recorder.serialize().durationMs), 0)
  return { lanes: playable, loopMs, hasMotion: playable.length > 0 }
}

// One shared elapsed clock drives every lane (lanes were recorded against the
// same take timeline, so they loop in lockstep).
export function laneValuesAt(
  lanes: MotionLanePlayback[],
  elapsedMs: number,
  loopMs: number,
): Map<MotionTarget, number> {
  const values = new Map<MotionTarget, number>()
  for (const lane of lanes) {
    const value = lane.recorder.value(elapsedMs, loopMs > 0 ? loopMs : undefined)
    if (value !== null) values.set(lane.target, value)
  }
  return values
}

export function serializeMotionLanes(lanes: MotionLanePlayback[]): MotionLane[] {
  return lanes.map((lane) => ({ target: lane.target, data: lane.recorder.serialize() }))
}

// Legacy (schema v2) presets/sessions stored a single position recording.
export function motionToLanes(motion: MotionData | undefined): MotionLane[] {
  if (!motion || motion.durationMs <= 0 || motion.samples.length === 0) return []
  return [{ target: 'position', data: motion }]
}
