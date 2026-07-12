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

// Wraps a finished stereo channel pair into an AudioSourceData, computing
// peaks once so every generator shares the same finalisation step.
function finalizeStereo(
  left: Float32Array,
  right: Float32Array,
  label: string,
  durationSeconds: number,
): AudioSourceData {
  return { label, left, right, peaks: createWaveformPeaks(left, right), durationSeconds }
}

// Sums a fixed set of sine partials, each with its own per-partial exponential
// decay envelope (or none, for a sustained partial), plus a small seeded
// stereo detune/phase spread so the result has width without needing an
// explicit noise layer. Generalises the partial-summing technique in
// createHarmonicPad / createGlassBells.
function additivePartials(
  sampleRate: number,
  durationSeconds: number,
  partials: { freq: number; amp: number; decay?: number; detuneCents?: number }[],
  seed: number,
): { left: Float32Array; right: Float32Array } {
  const length = Math.floor(sampleRate * durationSeconds)
  const left = new Float32Array(length)
  const right = new Float32Array(length)
  const rng = new XorShift32(seed)

  const voices = partials.map((partial) => {
    const detuneCents = partial.detuneCents ?? rng.nextBipolar() * 4
    const detuneRatio = 2 ** (detuneCents / 1200)
    return {
      ...partial,
      freqLeft: partial.freq * detuneRatio,
      freqRight: partial.freq / detuneRatio,
      phase: rng.nextFloat() * TWO_PI,
    }
  })

  for (let index = 0; index < length; index += 1) {
    const time = index / sampleRate
    let sampleLeft = 0
    let sampleRight = 0
    for (const voice of voices) {
      const envelope = voice.decay !== undefined ? Math.exp(-time * voice.decay) : 1
      const level = voice.amp * envelope
      sampleLeft += Math.sin(TWO_PI * voice.freqLeft * time + voice.phase) * level
      sampleRight += Math.sin(TWO_PI * voice.freqRight * time + voice.phase) * level
    }
    left[index] = softClip(sampleLeft)
    right[index] = softClip(sampleRight)
  }

  return { left, right }
}

// Seeded white noise pushed through a one-pole band-pass (difference of two
// leaky integrators) whose centre frequency moves over time per `centreHz`.
// Generalises the moving-formant band-pass technique in createFormantDrone.
function filteredNoise(
  sampleRate: number,
  durationSeconds: number,
  centreHz: (time: number) => number,
  q: number,
  seed: number,
): { left: Float32Array; right: Float32Array } {
  const length = Math.floor(sampleRate * durationSeconds)
  const left = new Float32Array(length)
  const right = new Float32Array(length)
  const rng = new XorShift32(seed)

  let lowLeftA = 0
  let lowLeftB = 0
  let lowRightA = 0
  let lowRightB = 0

  for (let index = 0; index < length; index += 1) {
    const time = index / sampleRate
    const centre = centreHz(time)
    const bandwidth = centre / q
    const coeffA = Math.exp((-TWO_PI * (centre - bandwidth / 2)) / sampleRate)
    const coeffB = Math.exp((-TWO_PI * (centre + bandwidth / 2)) / sampleRate)

    const noiseLeft = rng.nextBipolar()
    const noiseRight = rng.nextBipolar()

    lowLeftA = noiseLeft * (1 - coeffA) + lowLeftA * coeffA
    lowLeftB = noiseLeft * (1 - coeffB) + lowLeftB * coeffB
    lowRightA = noiseRight * (1 - coeffA) + lowRightA * coeffA
    lowRightB = noiseRight * (1 - coeffB) + lowRightB * coeffB

    left[index] = softClip((lowLeftA - lowLeftB) * q * 2)
    right[index] = softClip((lowRightA - lowRightB) * q * 2)
  }

  return { left, right }
}

// One-pole band-pass formant filter (difference of two leaky integrators)
// applied to an existing signal, with the centre frequency swept by
// `centreHz(time)`. Extracted from createFormantDrone so createVowelChoir can
// reuse the same formant-shaping technique on a harmonic source instead of
// noise.
function formantFilter(
  input: Float32Array,
  sampleRate: number,
  centreHz: (time: number) => number,
  q: number,
): Float32Array {
  const output = new Float32Array(input.length)
  let lowA = 0
  let lowB = 0
  for (let index = 0; index < input.length; index += 1) {
    const time = index / sampleRate
    const centre = centreHz(time)
    const bandwidth = centre / q
    const coeffA = Math.exp((-TWO_PI * (centre - bandwidth / 2)) / sampleRate)
    const coeffB = Math.exp((-TWO_PI * (centre + bandwidth / 2)) / sampleRate)
    const sample = input[index]
    lowA = sample * (1 - coeffA) + lowA * coeffA
    lowB = sample * (1 - coeffB) + lowB * coeffB
    output[index] = (lowA - lowB) * q * 2
  }
  return output
}

// A steady train of decaying pitched clicks (two-partial percussive envelope,
// as in createMalletPulse) fired at `rateHz`, with small seeded timing/level
// jitter so the sequence feels played rather than mechanically identical.
function transientTrain(
  sampleRate: number,
  durationSeconds: number,
  rateHz: number,
  pitchHz: number,
  seed: number,
): { left: Float32Array; right: Float32Array } {
  const length = Math.floor(sampleRate * durationSeconds)
  const left = new Float32Array(length)
  const right = new Float32Array(length)
  const rng = new XorShift32(seed)

  const interval = 1 / rateHz
  const hitCount = Math.ceil(durationSeconds * rateHz)
  const hits = Array.from({ length: hitCount }, (_, hit) => ({
    start: hit * interval + rng.nextBipolar() * 0.002,
    pan: rng.nextFloat(),
    amplitude: 0.75 + rng.nextFloat() * 0.25,
  }))

  for (let index = 0; index < length; index += 1) {
    const time = index / sampleRate
    let mono = 0
    let panAccum = 0
    let weight = 0
    for (const hit of hits) {
      const since = time - hit.start
      if (since < 0 || since > 0.25) continue
      const attack = 1 - Math.exp(-since * 2000)
      const decay = Math.exp(-since * 45)
      const envelope = attack * decay * hit.amplitude
      if (envelope < 0.0005) continue
      const tone = Math.sin(TWO_PI * pitchHz * since) + Math.sin(TWO_PI * pitchHz * 2.4 * since) * 0.3
      const voice = tone * envelope
      mono += voice
      panAccum += hit.pan * Math.abs(voice)
      weight += Math.abs(voice)
    }
    const pan = weight > 0 ? panAccum / weight : 0.5
    left[index] = softClip(mono * (1 - pan))
    right[index] = softClip(mono * pan)
  }

  return { left, right }
}

// 4. Bell-like inharmonic partials with independent exponential decays — a
//    classic FM/additive bell spectrum, showcasing pitched comb/ring effects.
function createGlassBells(sampleRate: number): AudioSourceData {
  const dur = 7
  const { left, right } = additivePartials(sampleRate, dur, [
    { freq: 220, amp: 0.5, decay: 2.2 },
    { freq: 220 * 2.76, amp: 0.32, decay: 1.6 }, // inharmonic bell ratios
    { freq: 220 * 5.4, amp: 0.2, decay: 1.1 },
    { freq: 220 * 8.93, amp: 0.12, decay: 0.8 },
  ], 0x6265_6c6c)
  return finalizeStereo(left, right, 'Glass bell partials', dur)
}

// 5. Slow sub-bass swell: a few low partials whose combined amplitude breathes
//    at 0.12 Hz, showcasing sub-heavy drive/bloom processing.
function createSubSwell(sampleRate: number): AudioSourceData {
  const dur = 8
  const { left: rawLeft, right: rawRight } = additivePartials(sampleRate, dur, [
    { freq: 55, amp: 0.6 },
    { freq: 110, amp: 0.2 },
    { freq: 27.5, amp: 0.3 },
  ], 0x5355_4221)

  const length = rawLeft.length
  const left = new Float32Array(length)
  const right = new Float32Array(length)
  for (let index = 0; index < length; index += 1) {
    const time = index / sampleRate
    const swell = 0.5 + 0.5 * Math.sin(TWO_PI * 0.12 * time)
    left[index] = rawLeft[index] * swell
    right[index] = rawRight[index] * swell
  }
  return finalizeStereo(left, right, 'Sub bass swell', dur)
}

// 6. Three detuned vocal-harmonic voices swept through ah -> ee -> oh formant
//    positions, showcasing formant filtering and bloom stretch.
function createVowelChoir(sampleRate: number): AudioSourceData {
  const dur = 8
  const length = Math.floor(sampleRate * dur)
  const rng = new XorShift32(0x564f_4943)

  const fundamental = 130
  const detunes = [-7, 0, 7]
  const mixedLeft = new Float32Array(length)
  const mixedRight = new Float32Array(length)

  for (const detuneCents of detunes) {
    const partials = Array.from({ length: 12 }, (_, harmonic) => {
      const ratio = harmonic + 1
      return { freq: fundamental * ratio, amp: 0.5 / ratio, detuneCents }
    })
    const { left, right } = additivePartials(sampleRate, dur, partials, rng.nextUint())
    for (let index = 0; index < length; index += 1) {
      mixedLeft[index] += left[index]
      mixedRight[index] += right[index]
    }
  }

  // Sweep the formant centre through ah -> ee -> oh across the buffer.
  const vowelCentres = [700, 2200, 550] // ah, ee, oh (approx first-formant-ish)
  const centreHz = (time: number): number => {
    const phase = (time / dur) * (vowelCentres.length - 1)
    const segment = Math.min(Math.floor(phase), vowelCentres.length - 2)
    const frac = phase - segment
    return vowelCentres[segment] + (vowelCentres[segment + 1] - vowelCentres[segment]) * frac
  }

  const left = formantFilter(mixedLeft, sampleRate, centreHz, 3)
  const right = formantFilter(mixedRight, sampleRate, centreHz, 3)
  const scaledLeft = new Float32Array(length)
  const scaledRight = new Float32Array(length)
  for (let index = 0; index < length; index += 1) {
    scaledLeft[index] = softClip(left[index] * 0.5)
    scaledRight[index] = softClip(right[index] * 0.5)
  }
  return finalizeStereo(scaledLeft, scaledRight, 'Vowel-morph choir', dur)
}

// 7. A steady clave-like click sequence at ~120 BPM 1/16 spacing, showcasing
//    Shatter sequencing, gating, and repeat.
function createClaveSeq(sampleRate: number): AudioSourceData {
  const dur = 6
  const { left, right } = transientTrain(sampleRate, dur, 8, 2000, 0x434c_4156)
  return finalizeStereo(left, right, 'Clave click sequence', dur)
}

// 8. Band-passed noise whose centre frequency drifts slowly across the
//    spectrum, showcasing spray/damp/wow/crush processing.
function createNoiseBed(sampleRate: number): AudioSourceData {
  const dur = 8
  const { left, right } = filteredNoise(
    sampleRate,
    dur,
    (t) => 300 + 2700 * (0.5 + 0.5 * Math.sin(TWO_PI * 0.08 * t)),
    2,
    0x4e4f_4953,
  )
  return finalizeStereo(left, right, 'Evolving noise bed', dur)
}

// 9. Three detuned sawtooth-like harmonic stacks (built additively), showcasing
//    drive/comb/pitch-spread processing.
function createSawStack(sampleRate: number): AudioSourceData {
  const dur = 8
  const length = Math.floor(sampleRate * dur)
  const rng = new XorShift32(0x5341_5721)
  const fundamental = 110
  const detunes = [-6, 0, 6]
  const mixedLeft = new Float32Array(length)
  const mixedRight = new Float32Array(length)

  for (const detuneCents of detunes) {
    const partials = Array.from({ length: 14 }, (_, harmonic) => {
      const ratio = harmonic + 1
      return { freq: fundamental * ratio, amp: 0.4 / ratio, detuneCents }
    })
    const { left, right } = additivePartials(sampleRate, dur, partials, rng.nextUint())
    for (let index = 0; index < length; index += 1) {
      mixedLeft[index] += left[index]
      mixedRight[index] += right[index]
    }
  }

  const left = new Float32Array(length)
  const right = new Float32Array(length)
  for (let index = 0; index < length; index += 1) {
    left[index] = softClip(mixedLeft[index] * 0.5)
    right[index] = softClip(mixedRight[index] * 0.5)
  }
  return finalizeStereo(left, right, 'Detuned saw stack', dur)
}

// 10. Six partials whose frequencies rise linearly over the buffer, showcasing
//     position/scan, wow, and bloom processing.
function createChirpSweep(sampleRate: number): AudioSourceData {
  const dur = 8
  const length = Math.floor(sampleRate * dur)
  const left = new Float32Array(length)
  const right = new Float32Array(length)
  const rng = new XorShift32(0x4348_5250)

  const partialCount = 6
  const baseStart = 120
  const baseEnd = 900
  const voices = Array.from({ length: partialCount }, (_, index) => {
    const ratio = index + 1
    const detuneRatio = 2 ** ((rng.nextBipolar() * 4) / 1200)
    return { ratio, detuneRatio, phase: rng.nextFloat() * TWO_PI }
  })

  for (let index = 0; index < length; index += 1) {
    const time = index / sampleRate
    let sampleLeft = 0
    let sampleRight = 0
    for (const voice of voices) {
      // Phase = integral of frequency over time for a linear chirp: since freq
      // is linear in time, integral is base*t + slope*t^2/2.
      const slope = ((baseEnd - baseStart) / dur) * voice.ratio
      const baseFreq = baseStart * voice.ratio
      const phaseAccum = TWO_PI * (baseFreq * time + (slope * time * time) / 2)
      sampleLeft += Math.sin(phaseAccum * voice.detuneRatio + voice.phase) * 0.25
      sampleRight += Math.sin(phaseAccum / voice.detuneRatio + voice.phase) * 0.25
    }
    left[index] = softClip(sampleLeft)
    right[index] = softClip(sampleRight)
  }

  return finalizeStereo(left, right, 'Spectral chirp sweep', dur)
}

export interface DemoSource {
  id: string
  label: string
  showcases: string
  build(sampleRate: number): AudioSourceData
}

export const DEMO_SOURCES: DemoSource[] = [
  { id: 'harmonic-pad', label: 'Warm harmonic pad', showcases: 'Bloom clouds · Space · Warmth', build: createHarmonicPad },
  { id: 'mallet-pulse', label: 'Mallet pulse texture', showcases: 'Shatter rhythm · Repeat · Tape', build: createMalletPulse },
  { id: 'formant-drone', label: 'Formant vocal drone', showcases: 'Formant · scan-reveals-vowels', build: createFormantDrone },
  { id: 'glass-bells', label: 'Glass bell partials', showcases: 'Ring · Comb · Pitch spread', build: createGlassBells },
  { id: 'sub-swell', label: 'Sub bass swell', showcases: 'Sub · Drive · Bloom drone', build: createSubSwell },
  { id: 'vowel-choir', label: 'Vowel-morph choir', showcases: 'Formant · Bloom stretch · Position', build: createVowelChoir },
  { id: 'clave-seq', label: 'Clave click sequence', showcases: 'Shatter seq · gate · Repeat', build: createClaveSeq },
  { id: 'noise-bed', label: 'Evolving noise bed', showcases: 'Spray · Damp · Wow · Crush', build: createNoiseBed },
  { id: 'saw-stack', label: 'Detuned saw stack', showcases: 'Drive · Comb · Pitch spread', build: createSawStack },
  { id: 'chirp-sweep', label: 'Spectral chirp sweep', showcases: 'Position/Scan · Wow · Bloom', build: createChirpSweep },
]

// Builds the demo source matching `id`, defaulting to the first registry
// entry when `id` is omitted or unknown. Selection is always explicit and
// deterministic — never random. The registry entry's `label` is authoritative
// so the dropdown label always matches the loaded source, even if a build fn
// sets its own internal label.
export function createDemoSource(sampleRate: number, id?: string): AudioSourceData {
  const entry = (id ? DEMO_SOURCES.find((candidate) => candidate.id === id) : undefined) ?? DEMO_SOURCES[0]
  return { ...entry.build(sampleRate), label: entry.label }
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
    // floor() leaves up to bucketCount-1 trailing samples; fold them into the
    // last bucket so the waveform tail is not silently dropped.
    const end = bucket === bucketCount - 1 ? length : Math.min(length, start + bucketSize)
    let peak = 0
    for (let index = start; index < end; index += 1) {
      peak = Math.max(peak, Math.abs(left[index]), Math.abs(right[index]))
    }
    peaks[bucket] = peak
  }

  return peaks
}
