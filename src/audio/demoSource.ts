import { XorShift32 } from './dsp/rng'

export interface AudioSourceData {
  label: string
  left: Float32Array
  right: Float32Array
  peaks: Float32Array
  durationSeconds: number
}

// Each generator owns a fixed seed so its texture is reproducible, and a
// duration that flatters its character (longer for evolving drones, shorter
// for rhythmic material that gets chopped). Channels are decorrelated with
// independent noise/phase so granular clouds keep stereo width.
type DemoGenerator = (sampleRate: number) => AudioSourceData

const TWO_PI = Math.PI * 2

// Soft clip keeps summed partials inside ~[-1, 1] without the harsh corner of
// hard clipping, preserving the rich harmonics granular processing thrives on.
function softClip(value: number): number {
  return Math.tanh(value)
}

// 1. Warm evolving harmonic PAD: a small stack of slightly inharmonic, detuned
//    partials whose levels breathe at independent rates. The two channels use
//    opposing detune and phase so the pad drifts across the stereo field.
function createHarmonicPad(sampleRate: number): AudioSourceData {
  const durationSeconds = 8
  const length = Math.floor(sampleRate * durationSeconds)
  const left = new Float32Array(length)
  const right = new Float32Array(length)
  const rng = new XorShift32(0x70616431)

  const fundamental = 98 // G2
  const partialCount = 7
  const partials = Array.from({ length: partialCount }, (_, harmonic) => {
    const ratio = harmonic + 1
    // Mild stretched-string inharmonicity lifts upper partials slightly sharp.
    const inharmonicity = 1 + 0.0009 * ratio * ratio
    return {
      frequency: fundamental * ratio * inharmonicity,
      detune: 1 + (rng.nextBipolar() * 0.004) / ratio,
      amplitude: 0.9 / (ratio * 0.85 + 1),
      breatheRate: 0.03 + rng.nextFloat() * 0.11,
      breathePhase: rng.nextFloat() * TWO_PI,
      panPhase: rng.nextFloat() * TWO_PI,
    }
  })

  for (let index = 0; index < length; index += 1) {
    const time = index / sampleRate
    let sampleLeft = 0
    let sampleRight = 0
    for (const partial of partials) {
      // Independent slow tremolo per partial makes the timbre evolve.
      const breathe = 0.55 + 0.45 * Math.sin(TWO_PI * partial.breatheRate * time + partial.breathePhase)
      const level = partial.amplitude * breathe
      const baseLeft = TWO_PI * partial.frequency * partial.detune * time
      const baseRight = TWO_PI * (partial.frequency / partial.detune) * time
      sampleLeft += Math.sin(baseLeft) * level
      sampleRight += Math.sin(baseRight + partial.panPhase) * level
    }
    // Gentle global swell so the pad emerges and recedes over the buffer.
    const swell = 0.7 + 0.3 * Math.sin(TWO_PI * 0.05 * time - 0.6)
    const air = rng.nextBipolar() * 0.006
    left[index] = softClip((sampleLeft * 0.34 + air) * swell)
    right[index] = softClip((sampleRight * 0.34 + air) * swell)
  }

  return {
    label: 'Warm harmonic pad',
    left,
    right,
    peaks: createWaveformPeaks(left, right),
    durationSeconds,
  }
}

// 2. Rhythmic MALLET / PLUCK texture: enveloped struck tones on a steady pulse
//    with slight pitch wander, short percussive decays, and alternating stereo
//    placement so chopping the buffer yields clean, varied hits.
function createMalletPulse(sampleRate: number): AudioSourceData {
  const durationSeconds = 6
  const length = Math.floor(sampleRate * durationSeconds)
  const left = new Float32Array(length)
  const right = new Float32Array(length)
  const rng = new XorShift32(0x6d616c6c)

  const pulseHz = 6 // hits per second
  const interval = 1 / pulseHz
  const hitCount = Math.ceil(durationSeconds * pulseHz)
  // A loose pentatonic-ish scale (semitone offsets from the root) for movement.
  const scale = [0, 3, 5, 7, 10, 12]
  const rootHz = 220

  interface Mallet {
    start: number
    frequency: number
    decay: number
    pan: number
    amplitude: number
  }
  const mallets: Mallet[] = Array.from({ length: hitCount }, (_, hit) => {
    const degree = scale[rng.nextUint() % scale.length]
    const octaveLift = rng.nextFloat() < 0.25 ? 12 : 0
    const detuneCents = rng.nextBipolar() * 8
    const semitones = degree + octaveLift + detuneCents / 100
    return {
      start: hit * interval + rng.nextBipolar() * 0.004,
      frequency: rootHz * 2 ** (semitones / 12),
      decay: 7 + rng.nextFloat() * 9,
      pan: rng.nextFloat(),
      amplitude: 0.7 + rng.nextFloat() * 0.3,
    }
  })

  for (let index = 0; index < length; index += 1) {
    const time = index / sampleRate
    let mono = 0
    let panAccum = 0
    let weight = 0
    for (const mallet of mallets) {
      const since = time - mallet.start
      if (since < 0 || since > 1) continue
      // Fast attack, exponential decay — a struck-mallet envelope.
      const attack = 1 - Math.exp(-since * 900)
      const decay = Math.exp(-since * mallet.decay)
      const envelope = attack * decay * mallet.amplitude
      if (envelope < 0.0005) continue
      // Two partials (fundamental + a slightly sharp octave) for a wooden ring.
      const tone =
        Math.sin(TWO_PI * mallet.frequency * since)
        + Math.sin(TWO_PI * mallet.frequency * 2.01 * since) * 0.4
      const voice = tone * envelope
      mono += voice
      panAccum += mallet.pan * Math.abs(voice)
      weight += Math.abs(voice)
    }
    const pan = weight > 0 ? panAccum / weight : 0.5
    const air = rng.nextBipolar() * 0.004
    // Equal-power-ish pan placement keeps decorrelation between channels.
    left[index] = softClip((mono * (1 - pan) + air) * 0.5)
    right[index] = softClip((mono * pan + air) * 0.5)
  }

  return {
    label: 'Mallet pulse texture',
    left,
    right,
    peaks: createWaveformPeaks(left, right),
    durationSeconds,
  }
}

// 3. Evolving NOISY / FORMANT drone: a low partial bed under band-passed noise
//    whose formant peaks sweep slowly. Independent noise streams and formant
//    phases per channel give a wide, lively cloud for granular smearing.
function createFormantDrone(sampleRate: number): AudioSourceData {
  const durationSeconds = 8
  const length = Math.floor(sampleRate * durationSeconds)
  const left = new Float32Array(length)
  const right = new Float32Array(length)
  const rng = new XorShift32(0x6e6f697a)

  // Sub bed: a couple of low partials to ground the noise cloud.
  const bedFrequencies = [55, 82.5, 110]

  // One-pole band-pass per channel realised as the difference of two leaky
  // integrators (low-pass) whose cutoffs straddle a moving centre frequency.
  let lowLeftA = 0
  let lowLeftB = 0
  let lowRightA = 0
  let lowRightB = 0

  for (let index = 0; index < length; index += 1) {
    const time = index / sampleRate

    // Two formant centres drift along independent slow LFOs.
    const formant1 = 420 + 260 * Math.sin(TWO_PI * 0.05 * time)
    const formant2 = 1100 + 700 * Math.sin(TWO_PI * 0.037 * time + 1.1)
    // Map a centre frequency to a one-pole coefficient.
    const coeff = (centre: number): number => {
      const x = Math.exp((-TWO_PI * centre) / sampleRate)
      return x
    }
    const c1 = coeff(formant1)
    const c2 = coeff(formant2)

    const noiseLeft = rng.nextBipolar()
    const noiseRight = rng.nextBipolar()

    // Band-pass ~ low-pass(c1) minus low-pass(c2): emphasises the band between
    // the two moving cutoffs, producing a vowel-like formant sweep.
    lowLeftA = noiseLeft * (1 - c1) + lowLeftA * c1
    lowLeftB = noiseLeft * (1 - c2) + lowLeftB * c2
    lowRightA = noiseRight * (1 - c1) + lowRightA * c1
    lowRightB = noiseRight * (1 - c2) + lowRightB * c2
    const formantLeft = (lowLeftA - lowLeftB) * 6
    const formantRight = (lowRightA - lowRightB) * 6

    let bed = 0
    for (let partial = 0; partial < bedFrequencies.length; partial += 1) {
      const frequency = bedFrequencies[partial]
      const wobble = 1 + 0.002 * Math.sin(TWO_PI * (0.08 + partial * 0.03) * time)
      bed += Math.sin(TWO_PI * frequency * wobble * time) * (0.12 / (partial + 1))
    }

    const swell = 0.65 + 0.35 * Math.sin(TWO_PI * 0.043 * time - 0.4)
    left[index] = softClip((bed + formantLeft * 0.5) * swell)
    right[index] = softClip((bed + formantRight * 0.5) * swell)
  }

  return {
    label: 'Formant noise drone',
    left,
    right,
    peaks: createWaveformPeaks(left, right),
    durationSeconds,
  }
}

const GENERATORS: readonly DemoGenerator[] = [
  createHarmonicPad,
  createMalletPulse,
  createFormantDrone,
]

export const DEMO_VARIANT_COUNT = GENERATORS.length

// Picks one of three demo textures. Pass `variant` for deterministic selection
// (tests, reproducibility); omit it and a generator is chosen at random.
export function createDemoSource(sampleRate: number, variant?: number): AudioSourceData {
  const index = variant === undefined
    ? Math.floor(Math.random() * GENERATORS.length)
    : ((variant % GENERATORS.length) + GENERATORS.length) % GENERATORS.length
  return GENERATORS[index](sampleRate)
}

export function createWaveformPeaks(
  left: Float32Array,
  right: Float32Array,
  bucketCount = 320,
): Float32Array {
  const length = Math.min(left.length, right.length)
  const peaks = new Float32Array(bucketCount)
  const bucketSize = Math.max(1, Math.floor(length / bucketCount))

  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = bucket * bucketSize
    const end = Math.min(length, start + bucketSize)
    let peak = 0
    for (let index = start; index < end; index += 1) {
      peak = Math.max(peak, Math.abs(left[index]), Math.abs(right[index]))
    }
    peaks[bucket] = peak
  }

  return peaks
}
