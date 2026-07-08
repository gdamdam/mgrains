import {
  clamp,
  DEFAULT_PATCH,
  LFO_COUNT,
  PATCH_RANGES,
  sanitizePatch,
  SCALE_MASKS,
  type GrainMode,
  type GrainPatch,
  type GrainWindow,
  type LfoConfig,
} from '../contracts'
import { DIVISION_BEATS } from './shatterTiming'
import { bitcrush, OnePole, softClipDrive } from './effects'
import { Formant } from './formant'
import { clampGrainCutoff, GRAIN_FILTER_K, grainFilterG, svfLowpass } from './grainFilter'
import { Reverb } from './reverb'
import { Comb } from './comb'
import { Limiter } from './limiter'
import { RingMod } from './ringMod'
import { Sub } from './sub'
import { Wow } from './wow'
import { XorShift32 } from './rng'
import { shatterStepFrames } from './shatterTiming'
import { Tape } from './tape'
import { divisionToSeconds, TempoDelay } from './tempoDelay'
import { grainWindow } from './windows'

export interface GranularCoreOptions {
  sampleRate: number
  maxGrains?: number
}

export interface ProcessResult {
  activeGrains: number
  peak: number
  spawnedGrains: number
  currentStep: number
}

const DEFAULT_MAX_GRAINS = 64
const MODE_TRANSITION_HALF_SECONDS = 0.09
// Stolen grains ramp to silence over this window instead of hard-cutting
// (an instant cut at mid-envelope amplitude is an audible click).
const STEAL_FADE_SECONDS = 0.003
const STEAL_TAIL_COUNT = 16
const OUTPUT_SMOOTHING_SECONDS = 0.02
// Below this smoothed amount an effect is bypassed entirely, so a patch with the
// FX at zero renders a bit-identical dry signal.
const FX_EPSILON = 1e-4
// Darkest lowpass the damping macro reaches (normalized cutoff), keeping some body.
const DAMP_MIN_CUTOFF = 0.04

// Repeat (delay) time in seconds for a tempo-synced division. DIVISION_BEATS is
// in quarter-note beats; divisionToSeconds wants a whole-note fraction (÷4).
function repeatDivisionSeconds(patch: GrainPatch): number {
  return divisionToSeconds(DIVISION_BEATS[patch.repeatDivision] / 4, patch.bpm)
}

type ModeTransitionState = 'steady' | 'fade-out' | 'fade-in'

// A stereo effect that can render allocation-free into a 2-element buffer and
// clear its state. Reverb/TempoDelay/Tape/Formant/RingMod all satisfy this.
interface StereoFx {
  processInto(left: number, right: number, out: Float64Array): void
  reset(): void
}

export class GranularCore {
  readonly sampleRate: number
  readonly maxGrains: number

  private patch: GrainPatch = { ...DEFAULT_PATCH }
  private readonly rng: XorShift32
  private sourceLeft: Float32Array<ArrayBufferLike> = new Float32Array(0)
  private sourceRight: Float32Array<ArrayBufferLike> = new Float32Array(0)
  private sourceLength = 0
  private sourceFrameOffset = 0
  private frame = 0
  private nextGrainFrame = 0
  private shatterStepIndex = 0
  private shatterRatchetIndex = 0
  private lastShatterStep = 0
  // Absolute frame at which the shatter sequence should re-anchor to step 0 for
  // Ableton Link bar alignment; null when free-running. Applied forward-only in
  // process(): a supplied anchor never replays the steps it skipped past.
  private shatterAnchorFrame: number | null = null
  private pendingPatch: GrainPatch | null = null
  private modeTransitionState: ModeTransitionState = 'steady'
  private modeTransitionGain = 1
  private readonly modeTransitionStep: number
  private smoothedOutputGain = DEFAULT_PATCH.outputGain
  private targetOutputGain = DEFAULT_PATCH.outputGain
  // Input trim applied to the granulated source before the coloration FX chain
  // and the master output gain. Smoothed so header moves never click.
  private smoothedInputGain = DEFAULT_PATCH.inputGain
  private targetInputGain = DEFAULT_PATCH.inputGain
  private readonly outputSmoothingCoefficient: number
  private smoothedDrive = 0
  private targetDrive = 0
  private smoothedCrush = 0
  private targetCrush = 0
  private smoothedDamp = 0
  private targetDamp = 0
  private readonly filterLeft = new OnePole()
  private readonly filterRight = new OnePole()
  private smoothedSpace = 0
  private targetSpace = 0
  private smoothedRepeat = 0
  private targetRepeat = 0
  private spaceActive = false
  private repeatActive = false
  private repeatTimeSeconds = 0
  private readonly reverb: Reverb
  private readonly delay: TempoDelay
  private readonly fxScratch = new Float64Array(2)
  private smoothedTape = 0
  private targetTape = 0
  private tapeTone = DEFAULT_PATCH.tapeTone
  private smoothedFormant = 0
  private targetFormant = 0
  private formantVowel = 0
  private smoothedRingMod = 0
  private targetRingMod = 0
  private ringModHz = DEFAULT_PATCH.ringModHz
  private tapeActive = false
  private formantActive = false
  private ringModActive = false
  private readonly tape: Tape
  private readonly formant: Formant
  private readonly ringMod: RingMod
  private smoothedWow = 0
  private targetWow = 0
  private wowRate = DEFAULT_PATCH.wowRate
  private smoothedComb = 0
  private targetComb = 0
  private combFreq = DEFAULT_PATCH.combFreq
  private smoothedSub = 0
  private targetSub = 0
  private subTune = DEFAULT_PATCH.subTune
  private wowActive = false
  private combActive = false
  private subActive = false
  private readonly wow: Wow
  private readonly comb: Comb
  private readonly sub: Sub
  private readonly limiter: Limiter
  // Held note pitch offsets (semitones) for chromatic polyphony, capped to a
  // small voice count so a chord can never overrun the grain pool.
  private readonly activeNotes = new Float64Array(8)
  private readonly activeVelocities = new Float64Array(8)
  private activeNoteCount = 0
  // When true, grains only spawn while a note is held — the autonomous
  // drone/pattern is muted so the instrument plays from the keyboard/MIDI only.
  private gateToNotes = false

  // Pitch bend (semitones, smoothed) applied globally to every voice, and a
  // last-note glide that ramps the played pitch when glideTime > 0.
  private targetPitchBend = 0
  private smoothedPitchBend = 0
  private glidePitch = 0
  private glideTarget = 0
  private glideInitialized = false

  // Modulation layer: per-LFO sample-and-hold / random-walk state re-evaluated
  // once per process() block, plus the modulated parameter snapshot the spawn
  // path reads instead of the raw patch values.
  private readonly lfoHold = new Float64Array(LFO_COUNT)
  private readonly lfoDrift = new Float64Array(LFO_COUNT)
  private readonly lfoCycle = new Int32Array(LFO_COUNT).fill(-1)
  private readonly lfoRng: XorShift32
  private modPosition = DEFAULT_PATCH.position
  private modSpray = DEFAULT_PATCH.spray
  private modGrainSizeMs = DEFAULT_PATCH.grainSizeMs
  private modDensityHz = DEFAULT_PATCH.densityHz
  private modPitchSpread = DEFAULT_PATCH.pitchSpreadSemitones

  private readonly active: Uint8Array
  private readonly sourcePosition: Float64Array
  private readonly grainSourceOffset: Float64Array
  private readonly step: Float64Array
  private readonly age: Float64Array
  private readonly duration: Float64Array
  private readonly gainLeft: Float32Array
  private readonly gainRight: Float32Array
  private readonly windowCode: Uint8Array
  private readonly regionStartFrame: Float64Array
  private readonly regionLengthFrames: Float64Array

  // Per-grain resonant lowpass (v1.8.0): Simper SVF, per-channel state, one
  // shared integrator-gain coefficient per slot, drawn once at spawn. filterOn
  // gates the render-loop path per grain, so a patch flipped to Off mid-sound
  // lets live grains keep their color (clickless) while new spawns skip the
  // filter — and Off never touches the RNG (exact v1.7 bypass).
  private readonly filterOn: Uint8Array
  private readonly filterG: Float64Array
  private readonly filterIc1L: Float64Array
  private readonly filterIc2L: Float64Array
  private readonly filterIc1R: Float64Array
  private readonly filterIc2R: Float64Array

  // Steal-fade tails: a stolen grain's state is copied here and rendered as a
  // short linear fade-out while its old slot hosts the new grain (zero-alloc).
  private readonly tailPosition: Float64Array
  private readonly tailOffset: Float64Array
  private readonly tailStep: Float64Array
  private readonly tailRegionStart: Float64Array
  private readonly tailRegionLength: Float64Array
  private readonly tailGainLeft: Float32Array
  private readonly tailGainRight: Float32Array
  private readonly tailRemaining: Float64Array
  private readonly stealFadeFrames: number

  // Frames between spawn events under the CURRENT scheduler (bloom density or
  // shatter step/ratchet) — the honest overlap basis for gain normalization.
  private spawnIntervalFrames = 1

  constructor({ sampleRate, maxGrains = DEFAULT_MAX_GRAINS }: GranularCoreOptions) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new RangeError('sampleRate must be a finite positive number')
    }

    this.sampleRate = sampleRate
    this.maxGrains = Math.max(1, Math.floor(maxGrains))
    this.modeTransitionStep = 1 / Math.max(1, sampleRate * MODE_TRANSITION_HALF_SECONDS)
    this.outputSmoothingCoefficient = 1 - Math.exp(
      -1 / Math.max(1, sampleRate * OUTPUT_SMOOTHING_SECONDS),
    )
    this.rng = new XorShift32(this.patch.seed)
    // Dedicated stream so S&H/drift LFOs never perturb grain-spawn randomness
    // (which must stay reproducible for a given seed).
    this.lfoRng = new XorShift32((this.patch.seed ^ 0x9e3779b9) >>> 0)
    this.active = new Uint8Array(this.maxGrains)
    this.sourcePosition = new Float64Array(this.maxGrains)
    this.grainSourceOffset = new Float64Array(this.maxGrains)
    this.step = new Float64Array(this.maxGrains)
    this.age = new Float64Array(this.maxGrains)
    this.duration = new Float64Array(this.maxGrains)
    this.gainLeft = new Float32Array(this.maxGrains)
    this.gainRight = new Float32Array(this.maxGrains)
    this.windowCode = new Uint8Array(this.maxGrains)
    this.regionStartFrame = new Float64Array(this.maxGrains)
    this.regionLengthFrames = new Float64Array(this.maxGrains)
    this.filterOn = new Uint8Array(this.maxGrains)
    this.filterG = new Float64Array(this.maxGrains)
    this.filterIc1L = new Float64Array(this.maxGrains)
    this.filterIc2L = new Float64Array(this.maxGrains)
    this.filterIc1R = new Float64Array(this.maxGrains)
    this.filterIc2R = new Float64Array(this.maxGrains)
    this.tailPosition = new Float64Array(STEAL_TAIL_COUNT)
    this.tailOffset = new Float64Array(STEAL_TAIL_COUNT)
    this.tailStep = new Float64Array(STEAL_TAIL_COUNT)
    this.tailRegionStart = new Float64Array(STEAL_TAIL_COUNT)
    this.tailRegionLength = new Float64Array(STEAL_TAIL_COUNT)
    this.tailGainLeft = new Float32Array(STEAL_TAIL_COUNT)
    this.tailGainRight = new Float32Array(STEAL_TAIL_COUNT)
    this.tailRemaining = new Float64Array(STEAL_TAIL_COUNT)
    this.stealFadeFrames = Math.max(1, Math.round(sampleRate * STEAL_FADE_SECONDS))
    this.spawnIntervalFrames = this.sampleRate / DEFAULT_PATCH.densityHz
    this.reverb = new Reverb(this.sampleRate)
    this.delay = new TempoDelay(this.sampleRate)
    this.tape = new Tape(this.sampleRate)
    this.formant = new Formant(this.sampleRate)
    this.ringMod = new RingMod(this.sampleRate)
    this.wow = new Wow(this.sampleRate)
    this.comb = new Comb(this.sampleRate)
    this.sub = new Sub(this.sampleRate)
    this.limiter = new Limiter(this.sampleRate)
    this.limiter.setParams({ ceiling: 0.95, release: 0.1 })
    this.repeatTimeSeconds = repeatDivisionSeconds(this.patch)
  }

  get currentFrame(): number {
    return this.frame
  }

  /**
   * Request that shatter step 0 land on the given absolute frame — a shared Link
   * downbeat, already projected into this engine's frame clock by the worklet.
   * Forward-only: an anchor in the past is ignored (a late frame is dropped rather
   * than fired as a burst), so alignment only ever corrects at a bar boundary.
   */
  alignShatterAtFrame(frame: number): void {
    if (!Number.isFinite(frame) || frame < this.frame) return
    this.shatterAnchorFrame = frame
  }

  get activeGrainCount(): number {
    let count = 0
    for (let index = 0; index < this.maxGrains; index += 1) {
      count += this.active[index]
    }
    return count
  }

  /**
   * Drawn cutoff (Hz) of the grain in `slot`, recovered exactly from the slot
   * coefficient (fc = atan(g) * sr / pi); 0 when the slot is inactive or
   * unfiltered. Observability for tests — not used by the render path.
   */
  grainFilterCutoffHz(slot: number): number {
    if (slot < 0 || slot >= this.maxGrains) return 0
    if (this.active[slot] === 0 || this.filterOn[slot] === 0) return 0
    return (Math.atan(this.filterG[slot]) * this.sampleRate) / Math.PI
  }

  get currentMode(): GrainMode {
    return this.patch.mode
  }

  get transitionGain(): number {
    return this.modeTransitionGain
  }

  get outputGain(): number {
    return this.smoothedOutputGain
  }

  writeVisualState(
    positions: Float32Array<ArrayBufferLike>,
    intensities: Float32Array<ArrayBufferLike>,
  ): number {
    if (this.sourceLength < 2) return 0
    const limit = Math.min(positions.length, intensities.length)
    let count = 0

    for (let grain = 0; grain < this.maxGrains && count < limit; grain += 1) {
      if (this.active[grain] === 0) continue
      const phase = this.age[grain] / this.duration[grain]
      if (phase >= 1) continue
      const positionFromCurrentOrigin = this.sourcePosition[grain]
        + this.grainSourceOffset[grain]
        - this.sourceFrameOffset
      const logicalPosition = (
        (positionFromCurrentOrigin % this.sourceLength) + this.sourceLength
      ) % this.sourceLength
      positions[count] = logicalPosition / Math.max(1, this.sourceLength - 1)
      intensities[count] = grainWindow(
        decodeWindow(this.windowCode[grain]),
        phase,
        this.patch.windowSkew,
        this.patch.windowHardness,
      )
      count += 1
    }

    return count
  }

  setPatch(nextPatch: GrainPatch): void {
    const next = sanitizePatch(nextPatch)

    if (this.sourceLength < 2) {
      this.pendingPatch = null
      this.modeTransitionState = 'steady'
      this.modeTransitionGain = 1
      this.applyPatch(next, true)
      this.smoothedOutputGain = this.targetOutputGain
      this.snapFxToTargets()
      return
    }

    if (this.modeTransitionState === 'fade-out') {
      if (next.mode === this.patch.mode) {
        this.pendingPatch = null
        this.applyPatch(next)
        this.modeTransitionState = 'fade-in'
      } else {
        this.pendingPatch = next
      }
      return
    }

    if (next.mode !== this.patch.mode) {
      this.pendingPatch = next
      this.modeTransitionState = 'fade-out'
      return
    }

    this.applyPatch(next)
  }

  setSource(left: Float32Array, right: Float32Array): void {
    const length = Math.min(left.length, right.length)
    if (length < 2) {
      this.clearSource()
      return
    }

    this.sourceLeft = left
    this.sourceRight = right
    this.sourceLength = length
    this.sourceFrameOffset = 0
    this.reset()
  }

  setSourceView(
    left: Float32Array<ArrayBufferLike>,
    right: Float32Array<ArrayBufferLike>,
    validLength: number,
    frameOffset: number,
  ): void {
    const capacity = Math.min(left.length, right.length)
    this.sourceLeft = left
    this.sourceRight = right
    this.sourceLength = Math.max(0, Math.min(capacity, Math.floor(validLength)))
    this.sourceFrameOffset = capacity > 0
      ? ((Math.floor(frameOffset) % capacity) + capacity) % capacity
      : 0
  }

  clearSource(): void {
    this.sourceLeft = new Float32Array(0)
    this.sourceRight = new Float32Array(0)
    this.sourceLength = 0
    this.sourceFrameOffset = 0
    this.reset()
  }

  reset(seed?: number): void {
    if (this.pendingPatch) {
      this.applyPatch(this.pendingPatch, true)
      this.pendingPatch = null
    }
    this.active.fill(0)
    this.age.fill(0)
    this.tailRemaining.fill(0)
    this.filterOn.fill(0)
    this.filterIc1L.fill(0)
    this.filterIc2L.fill(0)
    this.filterIc1R.fill(0)
    this.filterIc2R.fill(0)
    this.frame = 0
    this.nextGrainFrame = 0
    this.shatterStepIndex = 0
    this.shatterRatchetIndex = 0
    this.lastShatterStep = 0
    this.shatterAnchorFrame = null
    this.modeTransitionState = 'steady'
    this.modeTransitionGain = 1
    this.smoothedOutputGain = this.targetOutputGain
    this.snapFxToTargets()
    this.filterLeft.reset()
    this.filterRight.reset()
    this.reverb.reset()
    this.delay.reset()
    this.tape.reset()
    this.formant.reset()
    this.ringMod.reset()
    this.wow.reset()
    this.comb.reset()
    this.sub.reset()
    this.limiter.reset()
    this.wowActive = false
    this.combActive = false
    this.subActive = false
    this.spaceActive = false
    this.repeatActive = false
    this.tapeActive = false
    this.formantActive = false
    this.ringModActive = false
    this.rng.reset(seed ?? this.patch.seed)
    this.lfoRng.reset(((seed ?? this.patch.seed) ^ 0x9e3779b9) >>> 0)
    this.lfoHold.fill(0)
    this.lfoDrift.fill(0)
    this.lfoCycle.fill(-1)
    this.smoothedPitchBend = this.targetPitchBend
    this.glideInitialized = false
  }

  private snapFxToTargets(): void {
    this.smoothedInputGain = this.targetInputGain
    this.smoothedDrive = this.targetDrive
    this.smoothedCrush = this.targetCrush
    this.smoothedDamp = this.targetDamp
    this.smoothedSpace = this.targetSpace
    this.smoothedRepeat = this.targetRepeat
    this.smoothedTape = this.targetTape
    this.smoothedFormant = this.targetFormant
    this.smoothedRingMod = this.targetRingMod
    this.smoothedWow = this.targetWow
    this.smoothedComb = this.targetComb
    this.smoothedSub = this.targetSub
  }

  // Run a stereo FX gated by `amount` (exact dry bypass at <= FX_EPSILON, with a
  // reset on disengage), wet-mixing the result into fxScratch. Returns the new
  // active flag. Caller reads fxScratch[0]/[1] for the mixed L/R.
  private runStereoFx(fx: StereoFx, amount: number, active: boolean, left: number, right: number): boolean {
    if (amount > FX_EPSILON) {
      fx.processInto(left, right, this.fxScratch)
      const wetL = this.fxScratch[0]
      const wetR = this.fxScratch[1]
      this.fxScratch[0] = left + (wetL - left) * amount
      this.fxScratch[1] = right + (wetR - right) * amount
      return true
    }
    if (active) fx.reset()
    this.fxScratch[0] = left
    this.fxScratch[1] = right
    return false
  }

  // Per-channel coloration: drive (saturation) -> crush (bit reduction) ->
  // damp (lowpass tone), each bypassed below FX_EPSILON. The stereo Space/Repeat
  // FX and the soft limiter are applied after this, in process(). Continuous
  // params are smoothed per sample so macro/automation moves never click.
  private colorFx(sample: number, filter: OnePole): number {
    let value = sample
    if (this.smoothedDrive > FX_EPSILON) {
      value = softClipDrive(value, this.smoothedDrive)
    }
    if (this.smoothedCrush > FX_EPSILON) {
      value = bitcrush(value, 16 - this.smoothedCrush * 14)
    }
    if (this.smoothedDamp > FX_EPSILON) {
      filter.setCutoff(1 - this.smoothedDamp * (1 - DAMP_MIN_CUTOFF), 'lowpass')
      value = filter.process(value)
    }
    return value
  }

  process(outputLeft: Float32Array, outputRight: Float32Array): ProcessResult {
    if (outputLeft.length !== outputRight.length) {
      throw new RangeError('Output channels must have equal lengths')
    }

    outputLeft.fill(0)
    outputRight.fill(0)

    if (this.sourceLength < 2) {
      this.frame += outputLeft.length
      return { activeGrains: 0, peak: 0, spawnedGrains: 0, currentStep: this.lastShatterStep }
    }

    let peak = 0
    let spawnedGrains = 0

    // Update Space/Repeat FX coefficients once per block (cheap); the wet-mix
    // amount itself is smoothed per sample below.
    this.reverb.setParams({ size: 0.35 + this.targetSpace * 0.6, damp: 0.4, width: 1 })
    this.delay.setParams({
      timeSeconds: this.repeatTimeSeconds,
      feedback: this.patch.repeatFeedback,
      tone: 0.4,
      width: 0.7,
    })
    this.tape.setParams({ drive: 0.2 + this.targetTape * 0.6, tone: this.tapeTone })
    this.formant.setParams({ vowel: this.formantVowel, amount: 1 })
    this.ringMod.setParams({ frequency: this.ringModHz, amount: 1 })
    this.wow.setParams({ rate: this.wowRate, depth: 0.7 })
    this.comb.setParams({ frequency: this.combFreq, resonance: 0.85 })
    this.sub.setParams({ tune: this.subTune })

    // A pending Link bar anchor only means anything for the shatter sequencer;
    // drop it if the mode changed away so it can't fire stale later.
    if (this.shatterAnchorFrame !== null && this.patch.mode !== 'shatter') {
      this.shatterAnchorFrame = null
    }

    // Pitch bend, glide, and LFO modulation are evaluated once per block (grains
    // sample these only at spawn, which is far slower than the block rate), then
    // read by the spawn path via the mod* snapshot.
    this.updateModulation(outputLeft.length)

    for (let offset = 0; offset < outputLeft.length; offset += 1) {
      const absoluteFrame = this.frame + offset
      this.advanceModeTransition(absoluteFrame)
      this.smoothedOutputGain += (
        this.targetOutputGain - this.smoothedOutputGain
      ) * this.outputSmoothingCoefficient
      this.smoothedInputGain += (this.targetInputGain - this.smoothedInputGain) * this.outputSmoothingCoefficient
      this.smoothedDrive += (this.targetDrive - this.smoothedDrive) * this.outputSmoothingCoefficient
      this.smoothedCrush += (this.targetCrush - this.smoothedCrush) * this.outputSmoothingCoefficient
      this.smoothedDamp += (this.targetDamp - this.smoothedDamp) * this.outputSmoothingCoefficient
      this.smoothedSpace += (this.targetSpace - this.smoothedSpace) * this.outputSmoothingCoefficient
      this.smoothedRepeat += (this.targetRepeat - this.smoothedRepeat) * this.outputSmoothingCoefficient
      this.smoothedTape += (this.targetTape - this.smoothedTape) * this.outputSmoothingCoefficient
      this.smoothedFormant += (this.targetFormant - this.smoothedFormant) * this.outputSmoothingCoefficient
      this.smoothedRingMod += (this.targetRingMod - this.smoothedRingMod) * this.outputSmoothingCoefficient
      this.smoothedWow += (this.targetWow - this.smoothedWow) * this.outputSmoothingCoefficient
      this.smoothedComb += (this.targetComb - this.smoothedComb) * this.outputSmoothingCoefficient
      this.smoothedSub += (this.targetSub - this.smoothedSub) * this.outputSmoothingCoefficient

      if (
        this.shatterAnchorFrame !== null
        && this.patch.mode === 'shatter'
        && absoluteFrame >= this.shatterAnchorFrame
      ) {
        // Land step 0 exactly on the shared downbeat. resyncScheduler() jumps the
        // sequence straight to step 0 at this frame, so the steps that would have
        // played since the last anchor are skipped — never replayed as a burst.
        this.resyncScheduler(absoluteFrame)
        this.shatterAnchorFrame = null
      }

      if (absoluteFrame >= this.nextGrainFrame) {
        if (this.patch.mode === 'shatter') {
          spawnedGrains += this.scheduleShatterEvent()
        } else {
          const intervalFrames = this.sampleRate / this.modDensityHz
          this.spawnIntervalFrames = Math.max(1, intervalFrames)
          this.spawnVoices(0, false)
          spawnedGrains += 1
          const jitter = 1 + this.rng.nextBipolar() * this.patch.timingJitter * 0.45
          this.nextGrainFrame += Math.max(1, intervalFrames * jitter)
        }
      }

      let left = 0
      let right = 0

      for (let grain = 0; grain < this.maxGrains; grain += 1) {
        if (this.active[grain] === 0) continue

        const phase = this.age[grain] / this.duration[grain]
        if (phase >= 1) {
          this.active[grain] = 0
          continue
        }

        const envelope = grainWindow(
          decodeWindow(this.windowCode[grain]),
          phase,
          this.patch.windowSkew,
          this.patch.windowHardness,
        )
        const sourceFrame = this.wrapFrameInRegion(
          this.sourcePosition[grain],
          this.regionStartFrame[grain],
          this.regionLengthFrames[grain],
        )
        let sourceLeft = this.readLinear(
          this.sourceLeft,
          sourceFrame,
          this.grainSourceOffset[grain],
          this.regionStartFrame[grain],
          this.regionLengthFrames[grain],
        )
        let sourceRight = this.readLinear(
          this.sourceRight,
          sourceFrame,
          this.grainSourceOffset[grain],
          this.regionStartFrame[grain],
          this.regionLengthFrames[grain],
        )

        if (this.filterOn[grain] === 1) {
          // Derive the Simper coefficients from the slot's g (one divide,
          // shared by both channels) — see grainFilter.ts for the form.
          const g = this.filterG[grain]
          const a1 = 1 / (1 + g * (g + GRAIN_FILTER_K))
          const a2 = g * a1
          const a3 = g * a2
          sourceLeft = svfLowpass(sourceLeft, a1, a2, a3, this.filterIc1L, this.filterIc2L, grain)
          sourceRight = svfLowpass(sourceRight, a1, a2, a3, this.filterIc1R, this.filterIc2R, grain)
        }

        left += sourceLeft * envelope * this.gainLeft[grain]
        right += sourceRight * envelope * this.gainRight[grain]

        this.sourcePosition[grain] += this.step[grain]
        this.age[grain] += 1
      }

      for (let tail = 0; tail < STEAL_TAIL_COUNT; tail += 1) {
        const remaining = this.tailRemaining[tail]
        if (remaining <= 0) continue

        const ramp = remaining / this.stealFadeFrames
        const tailFrame = this.wrapFrameInRegion(
          this.tailPosition[tail],
          this.tailRegionStart[tail],
          this.tailRegionLength[tail],
        )
        left += this.readLinear(
          this.sourceLeft,
          tailFrame,
          this.tailOffset[tail],
          this.tailRegionStart[tail],
          this.tailRegionLength[tail],
        ) * this.tailGainLeft[tail] * ramp
        right += this.readLinear(
          this.sourceRight,
          tailFrame,
          this.tailOffset[tail],
          this.tailRegionStart[tail],
          this.tailRegionLength[tail],
        ) * this.tailGainRight[tail] * ramp

        this.tailPosition[tail] += this.tailStep[tail]
        this.tailRemaining[tail] = remaining - 1
      }

      const masterGain = this.smoothedInputGain * this.smoothedOutputGain * this.modeTransitionGain
      let mixL = this.colorFx(left * masterGain, this.filterLeft)
      let mixR = this.colorFx(right * masterGain, this.filterRight)

      // Stereo FX chain: tape -> ring mod -> formant -> space (reverb) ->
      // repeat (delay). Each is exact-dry-bypassed at zero and wet-mixed by its
      // smoothed amount (see runStereoFx).
      this.tapeActive = this.runStereoFx(this.tape, this.smoothedTape, this.tapeActive, mixL, mixR)
      mixL = this.fxScratch[0]
      mixR = this.fxScratch[1]
      this.ringModActive = this.runStereoFx(this.ringMod, this.smoothedRingMod, this.ringModActive, mixL, mixR)
      mixL = this.fxScratch[0]
      mixR = this.fxScratch[1]
      this.formantActive = this.runStereoFx(this.formant, this.smoothedFormant, this.formantActive, mixL, mixR)
      mixL = this.fxScratch[0]
      mixR = this.fxScratch[1]
      this.combActive = this.runStereoFx(this.comb, this.smoothedComb, this.combActive, mixL, mixR)
      mixL = this.fxScratch[0]
      mixR = this.fxScratch[1]
      this.wowActive = this.runStereoFx(this.wow, this.smoothedWow, this.wowActive, mixL, mixR)
      mixL = this.fxScratch[0]
      mixR = this.fxScratch[1]
      this.subActive = this.runStereoFx(this.sub, this.smoothedSub, this.subActive, mixL, mixR)
      mixL = this.fxScratch[0]
      mixR = this.fxScratch[1]
      this.spaceActive = this.runStereoFx(this.reverb, this.smoothedSpace, this.spaceActive, mixL, mixR)
      mixL = this.fxScratch[0]
      mixR = this.fxScratch[1]
      this.repeatActive = this.runStereoFx(this.delay, this.smoothedRepeat, this.repeatActive, mixL, mixR)
      mixL = this.fxScratch[0]
      mixR = this.fxScratch[1]

      // Master limiter: stereo-linked brickwall at the ceiling, the final stage.
      this.limiter.processInto(mixL, mixR, this.fxScratch)
      left = this.fxScratch[0]
      right = this.fxScratch[1]
      outputLeft[offset] = left
      outputRight[offset] = right
      peak = Math.max(peak, Math.abs(left), Math.abs(right))
    }

    this.frame += outputLeft.length
    return {
      activeGrains: this.activeGrainCount,
      peak,
      spawnedGrains,
      currentStep: this.lastShatterStep,
    }
  }

  // Recompute pitch bend, glide, and the LFO-modulated parameter snapshot once
  // per audio block. Grains read the mod* fields at spawn.
  private updateModulation(blockFrames: number): void {
    const bendCoeff = 1 - Math.exp(
      -blockFrames / Math.max(1, this.sampleRate * OUTPUT_SMOOTHING_SECONDS),
    )
    this.smoothedPitchBend += (this.targetPitchBend - this.smoothedPitchBend) * bendCoeff

    if (this.patch.glideTime > FX_EPSILON && this.activeNoteCount > 0) {
      const glideCoeff = 1 - Math.exp(
        -blockFrames / Math.max(1, this.sampleRate * this.patch.glideTime),
      )
      this.glidePitch += (this.glideTarget - this.glidePitch) * glideCoeff
    } else {
      this.glidePitch = this.glideTarget
    }

    let position = this.patch.position
    let spray = this.patch.spray
    let grainSizeMs = this.patch.grainSizeMs
    let densityHz = this.patch.densityHz
    let pitchSpread = this.patch.pitchSpreadSemitones

    const timeSeconds = this.frame / this.sampleRate
    for (let index = 0; index < LFO_COUNT; index += 1) {
      const lfo = this.patch.lfos[index]
      if (!lfo || lfo.target === 'none' || lfo.depth <= 0) continue
      const raw = this.evaluateLfo(lfo, index, timeSeconds)
      const shaped = lfo.bipolar ? raw : (raw + 1) * 0.5
      const [lo, hi] = PATCH_RANGES[lfo.target]
      const amount = lfo.depth * shaped * (hi - lo)
      switch (lfo.target) {
        case 'position': position += amount; break
        case 'spray': spray += amount; break
        case 'grainSizeMs': grainSizeMs += amount; break
        case 'densityHz': densityHz += amount; break
        case 'pitchSpreadSemitones': pitchSpread += amount; break
      }
    }

    // Position wraps (it's a phase); the rest clamp to their ranges.
    this.modPosition = position - Math.floor(position)
    this.modSpray = clamp(spray, ...PATCH_RANGES.spray)
    this.modGrainSizeMs = clamp(grainSizeMs, ...PATCH_RANGES.grainSizeMs)
    this.modDensityHz = clamp(densityHz, ...PATCH_RANGES.densityHz)
    this.modPitchSpread = clamp(pitchSpread, ...PATCH_RANGES.pitchSpreadSemitones)
  }

  // Evaluate one LFO to a bipolar -1..1 value. Phase is derived from the frame
  // clock (free) or the patch tempo (link) so it stays glitch-free and needs no
  // per-sample state beyond the S&H/drift hold.
  private evaluateLfo(lfo: LfoConfig, index: number, timeSeconds: number): number {
    const rateHz = lfo.sync === 'link'
      ? this.patch.bpm / (60 * DIVISION_BEATS[lfo.division])
      : lfo.rateHz
    const phase = timeSeconds * rateHz + lfo.phase
    const frac = phase - Math.floor(phase)
    const cycle = Math.floor(phase)

    switch (lfo.shape) {
      case 'sine':
        return Math.sin(Math.PI * 2 * frac)
      case 'saw':
        return 2 * frac - 1
      case 'tri':
        return 1 - 2 * Math.abs(2 * frac - 1)
      case 'sh':
        if (cycle !== this.lfoCycle[index]) {
          this.lfoCycle[index] = cycle
          this.lfoHold[index] = this.lfoRng.nextBipolar()
        }
        return this.lfoHold[index]
      case 'drift':
        if (cycle !== this.lfoCycle[index]) {
          this.lfoCycle[index] = cycle
          this.lfoHold[index] = this.lfoRng.nextBipolar()
        }
        // Slew toward each new target for a smooth continuous wander.
        this.lfoDrift[index] += (this.lfoHold[index] - this.lfoDrift[index]) * 0.05
        return this.lfoDrift[index]
      default:
        return 0
    }
  }

  private quantizeScatter(semitones: number): number {
    if (this.patch.pitchQuantize === 'off') return semitones
    return snapToScale(semitones, SCALE_MASKS[this.patch.pitchQuantize])
  }

  private scheduleShatterEvent(): number {
    const step = this.patch.shatterSteps[this.shatterStepIndex]
    this.lastShatterStep = this.shatterStepIndex
    const stepFrames = shatterStepFrames(
      this.sampleRate,
      this.patch.bpm,
      this.patch.shatterDivision,
    )
    // Shatter's real spawn rate is the step clock (bpm/division × ratchet), not
    // the bloom density control — gain normalization uses the NOMINAL step
    // interval (swing shifts onsets only; feeding swung frames here would flutter
    // per-grain gain between even/odd steps).
    this.spawnIntervalFrames = Math.max(1, stepFrames / step.ratchet)
    const shouldSpawn = step.enabled && this.rng.nextFloat() <= step.probability
    if (shouldSpawn) this.spawnVoices(step.pitchOffsetSemitones, step.reverse, step.positionOffset, step.sizeScale)

    // Swing: delay odd-index onsets. The interval leading OUT of an even step is
    // stretched by +delta (pushing the next odd step late); out of an odd step it
    // is compressed by −delta (returning the next even step to grid). Ratchets
    // subdivide the swung interval; step 0 is even, so it is never swung, which
    // keeps the Link bar anchor (always step 0) exactly on the downbeat.
    const delta = stepFrames * this.patch.shatterSwing * 0.5
    const swungStepFrames = this.shatterStepIndex % 2 === 0 ? stepFrames + delta : stepFrames - delta
    this.nextGrainFrame += Math.max(1, swungStepFrames / step.ratchet)
    this.shatterRatchetIndex += 1
    if (this.shatterRatchetIndex >= step.ratchet) {
      this.shatterRatchetIndex = 0
      this.shatterStepIndex = (this.shatterStepIndex + 1) % this.patch.shatterSteps.length
    }

    return shouldSpawn ? 1 : 0
  }

  // Set the held notes (semitone offset + 0..1 velocity). Empty => grains spawn
  // at the patch's base pitch/level (monophonic); otherwise each grain event
  // spawns one grain per note, transposed and scaled by that note's velocity.
  setActiveNotes(notes: { offset: number; velocity: number }[]): void {
    const count = Math.min(this.activeNotes.length, notes.length)
    for (let index = 0; index < count; index += 1) {
      const note = notes[index]
      this.activeNotes[index] = Number.isFinite(note.offset) ? note.offset : 0
      this.activeVelocities[index] = Number.isFinite(note.velocity)
        ? Math.min(1, Math.max(0, note.velocity))
        : 1
    }
    this.activeNoteCount = count
    if (count > 0) {
      // Glide (mono/last-note): ramp toward the newest held note. Snap on the
      // very first note so a patch doesn't slide up from 0 when playing begins.
      this.glideTarget = this.activeNotes[count - 1]
      if (!this.glideInitialized) {
        this.glidePitch = this.glideTarget
        this.glideInitialized = true
      }
    }
  }

  // Set the global pitch-bend offset in semitones (already scaled by the patch's
  // bend range in the UI). Smoothed per block so wheel moves never zipper.
  setPitchBend(semitones: number): void {
    this.targetPitchBend = Number.isFinite(semitones) ? semitones : 0
  }

  // Gate spawning to held notes only. Held grains finish their envelope
  // naturally; only new autonomous spawns are suppressed, so toggling is clickless.
  setGateToNotes(gated: boolean): void {
    this.gateToNotes = gated === true
  }

  // Spawn one grain per held note (transposed by note + extraSemitones, scaled by
  // the note's velocity), or a single full-velocity grain at the base pitch.
  private spawnVoices(
    extraSemitones: number,
    forceReverse: boolean,
    positionOffset = 0,
    sizeScale = 1,
  ): void {
    if (this.activeNoteCount === 0) {
      // Gated with nothing held → stay silent (covers both bloom and shatter,
      // which both route unheld spawns through here). The scheduler still
      // advances, so the drone/pattern resumes the moment a note arrives.
      if (this.gateToNotes) return
      this.spawnGrain(extraSemitones, forceReverse, 1, 1, positionOffset, sizeScale)
      return
    }
    if (this.patch.glideTime > FX_EPSILON) {
      // Glide collapses polyphony to a single last-note voice that slides
      // between pitches — the standard portamento behavior for a lead.
      const velocity = this.activeVelocities[this.activeNoteCount - 1]
      this.spawnGrain(extraSemitones + this.glidePitch, forceReverse, velocity, 1, positionOffset, sizeScale)
      return
    }
    for (let index = 0; index < this.activeNoteCount; index += 1) {
      this.spawnGrain(
        extraSemitones + this.activeNotes[index],
        forceReverse,
        this.activeVelocities[index],
        this.activeNoteCount,
        positionOffset,
        sizeScale,
      )
    }
  }

  private spawnGrain(
    pitchOffsetSemitones = 0,
    forceReverse = false,
    velocity = 1,
    voiceCount = 1,
    positionOffset = 0,
    sizeScale = 1,
  ): void {
    const slot = this.findGrainSlot()
    if (this.active[slot] === 1) this.beginStealFade(slot)
    const regionStart = Math.floor(this.patch.regionStart * (this.sourceLength - 1))
    const regionEnd = Math.max(regionStart + 2, Math.ceil(this.patch.regionEnd * this.sourceLength))
    const regionLength = Math.max(2, regionEnd - regionStart)
    const elapsedSeconds = this.frame / this.sampleRate
    const movingPosition = this.modPosition + elapsedSeconds * this.patch.scanSpeed
    const normalizedPosition = movingPosition - Math.floor(movingPosition)
    const spray = this.rng.nextBipolar() * this.modSpray * 0.5
    const positionInRegion = this.wrapUnit(normalizedPosition + spray + positionOffset)
    // Scatter is drawn chromatically, then optionally snapped to a scale so a
    // wide spread reads as harmony instead of detuned noise. Bend applies to the
    // whole voice (played note + scatter) so it tracks the pitch wheel.
    const scatter = this.quantizeScatter(this.rng.nextBipolar() * this.modPitchSpread)
    const pitch = this.patch.pitchSemitones + pitchOffsetSemitones
      + scatter + this.smoothedPitchBend
    const direction = forceReverse || this.rng.nextFloat() < this.patch.reverseProbability ? -1 : 1
    const pan = this.rng.nextBipolar() * this.patch.stereoSpread
    // Per-grain filter color, drawn once (uniform in OCTAVES around the center
    // so the band is musically symmetric). Off (dial at max) branches BEFORE
    // the RNG: no draw, no state write — the stream and output stay identical
    // to a filterless v1.7 render.
    if (this.patch.grainFilterHz >= PATCH_RANGES.grainFilterHz[1]) {
      this.filterOn[slot] = 0
    } else {
      const octaves = this.rng.nextBipolar() * this.patch.grainFilterSpread
      const cutoffHz = clampGrainCutoff(
        this.patch.grainFilterHz * 2 ** octaves,
        this.sampleRate,
      )
      this.filterOn[slot] = 1
      this.filterG[slot] = grainFilterG(cutoffHz, this.sampleRate)
      this.filterIc1L[slot] = 0
      this.filterIc2L[slot] = 0
      this.filterIc1R[slot] = 0
      this.filterIc2R[slot] = 0
    }
    // Per-step size scale rides on the live Size dial; clamp to the patch range
    // BEFORE durationFrames so overlap-based gain normalization follows honestly.
    const scaledGrainSizeMs = clamp(this.modGrainSizeMs * sizeScale, ...PATCH_RANGES.grainSizeMs)
    const durationFrames = Math.max(2, scaledGrainSizeMs * 0.001 * this.sampleRate)
    // Overlap from the actual spawn interval (mode-aware), and √N so an N-note
    // chord sums power-correctly instead of N× hotter than a single note.
    const expectedOverlap = Math.max(1, durationFrames / this.spawnIntervalFrames)
    const normalizedGain = velocity / Math.sqrt(expectedOverlap * Math.max(1, voiceCount))

    this.active[slot] = 1
    this.sourcePosition[slot] = regionStart + positionInRegion * (regionLength - 1)
    this.grainSourceOffset[slot] = this.sourceFrameOffset
    this.step[slot] = direction * 2 ** (pitch / 12)
    this.age[slot] = 0
    this.duration[slot] = durationFrames
    this.gainLeft[slot] = normalizedGain * (pan > 0 ? Math.cos(pan * Math.PI * 0.5) : 1)
    this.gainRight[slot] = normalizedGain * (pan < 0 ? Math.cos(-pan * Math.PI * 0.5) : 1)
    this.windowCode[slot] = encodeWindow(this.patch.window)
    this.regionStartFrame[slot] = regionStart
    this.regionLengthFrames[slot] = regionLength
  }

  // Copy a still-sounding grain into a fade tail before its slot is reused.
  // The tail keeps reading the source at the grain's current amplitude and
  // ramps linearly to silence over stealFadeFrames.
  private beginStealFade(slot: number): void {
    const phase = this.age[slot] / this.duration[slot]
    const envelope = grainWindow(
      decodeWindow(this.windowCode[slot]),
      phase,
      this.patch.windowSkew,
      this.patch.windowHardness,
    )
    if (envelope <= 0) return

    let tail = 0
    let shortest = Infinity
    for (let index = 0; index < STEAL_TAIL_COUNT; index += 1) {
      if (this.tailRemaining[index] <= 0) {
        tail = index
        break
      }
      if (this.tailRemaining[index] < shortest) {
        shortest = this.tailRemaining[index]
        tail = index
      }
    }

    this.tailPosition[tail] = this.sourcePosition[slot]
    this.tailOffset[tail] = this.grainSourceOffset[slot]
    this.tailStep[tail] = this.step[slot]
    this.tailRegionStart[tail] = this.regionStartFrame[slot]
    this.tailRegionLength[tail] = this.regionLengthFrames[slot]
    this.tailGainLeft[tail] = this.gainLeft[slot] * envelope
    this.tailGainRight[tail] = this.gainRight[slot] * envelope
    this.tailRemaining[tail] = this.stealFadeFrames
  }

  private findGrainSlot(): number {
    let oldestSlot = 0
    let oldestPhase = -1

    for (let index = 0; index < this.maxGrains; index += 1) {
      if (this.active[index] === 0) return index
      const phase = this.age[index] / this.duration[index]
      if (phase > oldestPhase) {
        oldestPhase = phase
        oldestSlot = index
      }
    }

    return oldestSlot
  }

  private applyPatch(nextPatch: GrainPatch, forceResync = false, schedulerFrame = this.frame): void {
    const previousPatch = this.patch
    const previousSeed = previousPatch.seed
    this.patch = nextPatch
    this.targetOutputGain = nextPatch.outputGain
    this.targetInputGain = nextPatch.inputGain
    this.targetDrive = nextPatch.drive
    this.targetCrush = nextPatch.crush
    this.targetDamp = nextPatch.damp
    this.targetSpace = nextPatch.space
    this.targetRepeat = nextPatch.repeat
    this.targetTape = nextPatch.tapeAmount
    this.tapeTone = nextPatch.tapeTone
    this.targetFormant = nextPatch.formantAmount
    this.formantVowel = nextPatch.formantVowel
    this.targetRingMod = nextPatch.ringModAmount
    this.ringModHz = nextPatch.ringModHz
    this.targetWow = nextPatch.wowAmount
    this.wowRate = nextPatch.wowRate
    this.targetComb = nextPatch.combAmount
    this.combFreq = nextPatch.combFreq
    this.targetSub = nextPatch.subAmount
    this.subTune = nextPatch.subTune
    this.repeatTimeSeconds = repeatDivisionSeconds(nextPatch)
    if (nextPatch.seed !== previousSeed) this.rng.reset(nextPatch.seed)
    if (forceResync || nextPatch.mode !== previousPatch.mode) {
      this.resyncScheduler(schedulerFrame)
    } else if (
      nextPatch.mode === 'shatter'
      && (nextPatch.bpm !== previousPatch.bpm
        || nextPatch.shatterDivision !== previousPatch.shatterDivision)
    ) {
      // Tempo/division nudges keep the pattern phase: rescale the remaining
      // wait to the new step length instead of re-firing step 0 immediately
      // (dragging the BPM dial used to machine-gun step 0 at UI-event rate).
      const previousStep = shatterStepFrames(this.sampleRate, previousPatch.bpm, previousPatch.shatterDivision)
      const nextStep = shatterStepFrames(this.sampleRate, nextPatch.bpm, nextPatch.shatterDivision)
      const remaining = Math.max(0, this.nextGrainFrame - schedulerFrame)
      this.nextGrainFrame = schedulerFrame + remaining * (nextStep / previousStep)
    } else if (
      nextPatch.densityHz !== previousPatch.densityHz
      && nextPatch.mode !== 'shatter'
    ) {
      // A density increase shouldn't have to wait out a grain interval that was
      // scheduled under the previous (sparser) setting — that can stall for
      // seconds. Cap the next grain to at most one new interval away so denser
      // settings respond promptly. Clamping the max only ever pulls the grain
      // earlier on an increase (a decrease leaves the sooner grain untouched),
      // so it never forces a double-trigger or resets grain/RNG phase.
      const intervalFrames = Math.max(1, this.sampleRate / nextPatch.densityHz)
      const earliestNext = schedulerFrame + intervalFrames
      if (this.nextGrainFrame > earliestNext) this.nextGrainFrame = earliestNext
    }
  }

  private advanceModeTransition(absoluteFrame: number): void {
    if (this.modeTransitionState === 'fade-out') {
      this.modeTransitionGain = Math.max(0, this.modeTransitionGain - this.modeTransitionStep)
      if (this.modeTransitionGain <= this.modeTransitionStep * 0.5) {
        this.modeTransitionGain = 0
        if (this.pendingPatch) {
          this.active.fill(0)
          this.age.fill(0)
          this.tailRemaining.fill(0)
          this.filterOn.fill(0)
          this.filterIc1L.fill(0)
          this.filterIc2L.fill(0)
          this.filterIc1R.fill(0)
          this.filterIc2R.fill(0)
          this.applyPatch(this.pendingPatch, true, absoluteFrame)
          this.pendingPatch = null
        }
        this.modeTransitionState = 'fade-in'
      }
    } else if (this.modeTransitionState === 'fade-in') {
      this.modeTransitionGain = Math.min(1, this.modeTransitionGain + this.modeTransitionStep)
      if (this.modeTransitionGain >= 1 - this.modeTransitionStep * 0.5) {
        this.modeTransitionGain = 1
        this.modeTransitionState = 'steady'
      }
    }
  }

  private resyncScheduler(schedulerFrame = this.frame): void {
    this.nextGrainFrame = schedulerFrame
    this.shatterStepIndex = 0
    this.shatterRatchetIndex = 0
    this.lastShatterStep = 0
  }

  private readLinear(
    channel: Float32Array<ArrayBufferLike>,
    frame: number,
    frameOffset: number,
    regionStart: number,
    regionLength: number,
  ): number {
    const logicalFirst = Math.floor(frame)
    const logicalSecond = this.wrapFrameInRegion(logicalFirst + 1, regionStart, regionLength)
    const fraction = frame - logicalFirst
    const first = this.toPhysicalFrame(logicalFirst, frameOffset, channel.length)
    const second = this.toPhysicalFrame(logicalSecond, frameOffset, channel.length)
    return channel[first] + (channel[second] - channel[first]) * fraction
  }

  private wrapFrameInRegion(frame: number, start: number, length: number): number {
    const relative = frame - start
    return start + ((relative % length) + length) % length
  }

  private toPhysicalFrame(logicalFrame: number, frameOffset: number, capacity: number): number {
    return ((Math.floor(logicalFrame + frameOffset) % capacity) + capacity) % capacity
  }

  private wrapUnit(value: number): number {
    return ((value % 1) + 1) % 1
  }
}

// Snap a semitone offset to the nearest degree of a scale mask (pitch classes
// 0..11). The octave is preserved and the mask wraps at the octave so an offset
// just below the octave can snap up to the next root.
function snapToScale(semitones: number, mask: readonly number[]): number {
  const octave = Math.floor(semitones / 12)
  const within = semitones - octave * 12
  let best = mask[0]
  let bestDistance = Infinity
  for (let index = 0; index <= mask.length; index += 1) {
    const pitchClass = index < mask.length ? mask[index] : mask[0] + 12
    const distance = Math.abs(within - pitchClass)
    if (distance < bestDistance) {
      bestDistance = distance
      best = pitchClass
    }
  }
  return octave * 12 + best
}

function encodeWindow(window: GrainWindow): number {
  switch (window) {
    case 'percussive': return 1
    case 'hard': return 2
    case 'reverse': return 3
    case 'morph': return 4
    case 'hann':
    default: return 0
  }
}

function decodeWindow(code: number): GrainWindow {
  switch (code) {
    case 1: return 'percussive'
    case 2: return 'hard'
    case 3: return 'reverse'
    case 4: return 'morph'
    case 0:
    default: return 'hann'
  }
}
