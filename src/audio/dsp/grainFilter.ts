// Per-grain resonant lowpass: Cytomic/Simper trapezoidal SVF, lowpass output.
// State lives in GranularCore's per-slot typed arrays (Float64Array per channel);
// these free functions do the math so the loop stays class-free and the DSP is
// unit-testable. The trapezoidal form is unconditionally stable for g > 0,
// k > 0, so no per-sample guards are needed — stability is proven by test.

// Fixed damping k = 1/Q. 0.75 => Q ~= 1.33 (~ +2.5 dB bump at cutoff): audible
// color without self-oscillation. Tuned by ear at release QA.
export const GRAIN_FILTER_K = 0.75

// Upper cutoff guard: 0.22 x sampleRate (same guard as mkeys' SVF fix), keeping
// tan(pi*fc/sr) far from its pole at Nyquist. Lower guard: 20 Hz so a deep
// negative spread draw can never reach g = 0.
export const GRAIN_FILTER_MAX_RATIO = 0.22
export const GRAIN_FILTER_MIN_HZ = 20

export function clampGrainCutoff(cutoffHz: number, sampleRate: number): number {
  const max = GRAIN_FILTER_MAX_RATIO * sampleRate
  if (!Number.isFinite(cutoffHz)) return max
  return Math.min(max, Math.max(GRAIN_FILTER_MIN_HZ, cutoffHz))
}

// Integrator gain for a (pre-clamped) cutoff. The only transcendental per grain
// LIFETIME — called once at spawn, never in the per-sample loop.
export function grainFilterG(cutoffHz: number, sampleRate: number): number {
  return Math.tan(Math.PI * (cutoffHz / sampleRate))
}

// Simper coefficients for a (pre-clamped) integrator gain g and the fixed
// resonance GRAIN_FILTER_K. Called once per grain at spawn (never per sample),
// so the object return is fine — it feeds svfLowpass's a1/a2/a3 arguments.
export function grainFilterCoefficients(g: number): { a1: number; a2: number; a3: number } {
  const a1 = 1 / (1 + g * (g + GRAIN_FILTER_K))
  const a2 = g * a1
  const a3 = g * a2
  return { a1, a2, a3 }
}

// One lowpass sample for `slot`, reading/writing the caller's state arrays in
// place (zero allocation). a1/a2/a3 come from grainFilterCoefficients(g).
export function svfLowpass(
  input: number,
  a1: number,
  a2: number,
  a3: number,
  ic1: Float64Array,
  ic2: Float64Array,
  slot: number,
): number {
  const v3 = input - ic2[slot]
  const v1 = a1 * ic1[slot] + a2 * v3
  const v2 = ic2[slot] + a2 * ic1[slot] + a3 * v3
  let s1 = 2 * v1 - ic1[slot]
  let s2 = 2 * v2 - ic2[slot]
  // Denormal flush: silent source lets the integrators decay into subnormal
  // doubles, which run 10-100x slower on the audio thread (JS can't set
  // FTZ/DAZ). Snap to zero below the audible floor. Only runs on the engaged
  // path — the Off branch never calls this, so its bypass stays byte-identical.
  if (s1 < 1e-20 && s1 > -1e-20) s1 = 0
  if (s2 < 1e-20 && s2 > -1e-20) s2 = 0
  ic1[slot] = s1
  ic2[slot] = s2
  return v2
}
