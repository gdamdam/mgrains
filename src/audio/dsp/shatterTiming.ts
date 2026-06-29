import type { ShatterDivision } from '../contracts'

const DIVISION_BEATS: Record<ShatterDivision, number> = {
  '1/4': 1,
  '1/8D': 0.75,
  '1/8': 0.5,
  '1/8T': 1 / 3,
  '1/16D': 0.375,
  '1/16': 0.25,
  '1/16T': 1 / 6,
  '1/32': 0.125,
  '1/32T': 1 / 12,
  '1/64': 0.0625,
}

export function shatterStepFrames(
  sampleRate: number,
  bpm: number,
  division: ShatterDivision,
): number {
  const safeSampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48_000
  const safeBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120
  return safeSampleRate * 60 / safeBpm * DIVISION_BEATS[division]
}
