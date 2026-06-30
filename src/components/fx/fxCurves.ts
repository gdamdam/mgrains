import type { GrainPatch } from '../../audio/contracts'

// Decorative-but-responsive SVG visualizations: each FX maps to a curve of
// y-values in 0..1 (left→right) that reacts to the patch, so the modal shows
// the effect's character at a glance. Not a measured frequency response.
const POINTS = 48

function curve(fn: (t: number) => number): number[] {
  const out: number[] = []
  for (let i = 0; i < POINTS; i += 1) {
    const t = i / (POINTS - 1)
    out.push(Math.min(1, Math.max(0, fn(t))))
  }
  return out
}

export function fxCurvePoints(id: string, patch: GrainPatch): number[] {
  switch (id) {
    case 'drive':
    case 'tape': {
      const amount = id === 'drive' ? patch.drive : patch.tapeAmount
      const k = 1 + amount * 9
      // Saturation transfer curve: steeper (more compressed) as amount rises.
      return curve((t) => 0.5 + 0.5 * Math.tanh((t * 2 - 1) * k))
    }
    case 'crush': {
      const steps = Math.max(2, Math.round(2 + (1 - patch.crush) * 14))
      return curve((t) => Math.round(t * steps) / steps)
    }
    case 'damp': {
      const k = 1 + patch.damp * 28
      // Low-pass-style rolloff: darker (earlier rolloff) as damp rises.
      return curve((t) => 1 / Math.sqrt(1 + (t * k) ** 2))
    }
    case 'space': {
      const k = 1 + (1 - patch.space) * 8
      // Reverb decay envelope: longer tail as space rises.
      return curve((t) => Math.exp(-t * k))
    }
    case 'repeat': {
      const k = 1 + (1 - patch.repeat) * 7
      // Discrete decaying echoes.
      return curve((t) => Math.exp(-t * k) * (0.5 + 0.5 * Math.cos(t * Math.PI * 6)))
    }
    case 'ringmod': {
      const cycles = 1 + (patch.ringModHz / 4000) * 12
      return curve((t) => 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * cycles))
    }
    case 'formant': {
      // Three resonant peaks whose spacing shifts with the vowel.
      const v = patch.formantVowel
      const centers = [0.1 + v * 0.12, 0.42 + v * 0.04, 0.74 - v * 0.12]
      return curve((t) => centers.reduce((y, c) => y + Math.exp(-((t - c) ** 2) / 0.004), 0))
    }
    default:
      return curve(() => 0.5)
  }
}
