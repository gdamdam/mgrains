import type { GrainWindow } from '../contracts'

const TWO_PI = Math.PI * 2

export function grainWindow(kind: GrainWindow, phase: number): number {
  if (!Number.isFinite(phase) || phase <= 0 || phase >= 1) return 0

  switch (kind) {
    case 'hard':
      return 1
    case 'percussive':
      return percussiveWindow(phase)
    case 'reverse':
      return percussiveWindow(1 - phase)
    case 'hann':
    default:
      return 0.5 - 0.5 * Math.cos(TWO_PI * phase)
  }
}

function percussiveWindow(phase: number): number {
  const attack = Math.min(1, phase / 0.035)
  return attack * Math.exp(-4.5 * phase)
}
