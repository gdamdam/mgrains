import {
  DEFAULT_PATCH,
  sanitizePatch,
  type GrainMode,
  type GrainPatch,
  type GrainWindow,
} from '../contracts'
import { bitcrush, OnePole, softClipDrive } from './effects'
import { Reverb } from './reverb'
import { XorShift32 } from './rng'
import { shatterStepFrames } from './shatterTiming'
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
const OUTPUT_SMOOTHING_SECONDS = 0.02
// Below this smoothed amount an effect is bypassed entirely, so a patch with the
// FX at zero renders a bit-identical dry signal.
const FX_EPSILON = 1e-4
// Darkest lowpass the damping macro reaches (normalized cutoff), keeping some body.
const DAMP_MIN_CUTOFF = 0.04
// Repeat (delay) time as a fraction of a whole note — a dotted eighth (3/16),
// the classic tempo-synced delay feel.
const REPEAT_DIVISION = 0.1875

type ModeTransitionState = 'steady' | 'fade-out' | 'fade-in'

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
  private pendingPatch: GrainPatch | null = null
  private modeTransitionState: ModeTransitionState = 'steady'
  private modeTransitionGain = 1
  private readonly modeTransitionStep: number
  private smoothedOutputGain = DEFAULT_PATCH.outputGain
  private targetOutputGain = DEFAULT_PATCH.outputGain
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
    this.reverb = new Reverb(this.sampleRate)
    this.delay = new TempoDelay(this.sampleRate)
    this.repeatTimeSeconds = divisionToSeconds(REPEAT_DIVISION, this.patch.bpm)
  }

  get currentFrame(): number {
    return this.frame
  }

  get activeGrainCount(): number {
    let count = 0
    for (let index = 0; index < this.maxGrains; index += 1) {
      count += this.active[index]
    }
    return count
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
      intensities[count] = grainWindow(decodeWindow(this.windowCode[grain]), phase)
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
    this.frame = 0
    this.nextGrainFrame = 0
    this.shatterStepIndex = 0
    this.shatterRatchetIndex = 0
    this.lastShatterStep = 0
    this.modeTransitionState = 'steady'
    this.modeTransitionGain = 1
    this.smoothedOutputGain = this.targetOutputGain
    this.snapFxToTargets()
    this.filterLeft.reset()
    this.filterRight.reset()
    this.reverb.reset()
    this.delay.reset()
    this.spaceActive = false
    this.repeatActive = false
    this.rng.reset(seed ?? this.patch.seed)
  }

  private snapFxToTargets(): void {
    this.smoothedDrive = this.targetDrive
    this.smoothedCrush = this.targetCrush
    this.smoothedDamp = this.targetDamp
    this.smoothedSpace = this.targetSpace
    this.smoothedRepeat = this.targetRepeat
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
      feedback: this.targetRepeat * 0.85,
      tone: 0.4,
      width: 0.7,
    })

    for (let offset = 0; offset < outputLeft.length; offset += 1) {
      const absoluteFrame = this.frame + offset
      this.advanceModeTransition(absoluteFrame)
      this.smoothedOutputGain += (
        this.targetOutputGain - this.smoothedOutputGain
      ) * this.outputSmoothingCoefficient
      this.smoothedDrive += (this.targetDrive - this.smoothedDrive) * this.outputSmoothingCoefficient
      this.smoothedCrush += (this.targetCrush - this.smoothedCrush) * this.outputSmoothingCoefficient
      this.smoothedDamp += (this.targetDamp - this.smoothedDamp) * this.outputSmoothingCoefficient
      this.smoothedSpace += (this.targetSpace - this.smoothedSpace) * this.outputSmoothingCoefficient
      this.smoothedRepeat += (this.targetRepeat - this.smoothedRepeat) * this.outputSmoothingCoefficient

      if (absoluteFrame >= this.nextGrainFrame) {
        if (this.patch.mode === 'shatter') {
          spawnedGrains += this.scheduleShatterEvent()
        } else {
          this.spawnGrain()
          spawnedGrains += 1
          const intervalFrames = this.sampleRate / this.patch.densityHz
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

        const envelope = grainWindow(decodeWindow(this.windowCode[grain]), phase)
        const sourceFrame = this.wrapFrameInRegion(
          this.sourcePosition[grain],
          this.regionStartFrame[grain],
          this.regionLengthFrames[grain],
        )
        const sourceLeft = this.readLinear(
          this.sourceLeft,
          sourceFrame,
          this.grainSourceOffset[grain],
          this.regionStartFrame[grain],
          this.regionLengthFrames[grain],
        )
        const sourceRight = this.readLinear(
          this.sourceRight,
          sourceFrame,
          this.grainSourceOffset[grain],
          this.regionStartFrame[grain],
          this.regionLengthFrames[grain],
        )

        left += sourceLeft * envelope * this.gainLeft[grain]
        right += sourceRight * envelope * this.gainRight[grain]

        this.sourcePosition[grain] += this.step[grain]
        this.age[grain] += 1
      }

      const masterGain = this.smoothedOutputGain * this.modeTransitionGain
      let mixL = this.colorFx(left * masterGain, this.filterLeft)
      let mixR = this.colorFx(right * masterGain, this.filterRight)

      // Stereo Space (reverb), wet-mixed by the smoothed amount. Reset on
      // disengage so a re-engaged reverb starts from a clean tail.
      if (this.smoothedSpace > FX_EPSILON) {
        this.reverb.processInto(mixL, mixR, this.fxScratch)
        mixL += (this.fxScratch[0] - mixL) * this.smoothedSpace
        mixR += (this.fxScratch[1] - mixR) * this.smoothedSpace
        this.spaceActive = true
      } else if (this.spaceActive) {
        this.reverb.reset()
        this.spaceActive = false
      }

      // Stereo Repeat (tempo-synced delay), same wet-mix + disengage handling.
      if (this.smoothedRepeat > FX_EPSILON) {
        this.delay.processInto(mixL, mixR, this.fxScratch)
        mixL += (this.fxScratch[0] - mixL) * this.smoothedRepeat
        mixR += (this.fxScratch[1] - mixR) * this.smoothedRepeat
        this.repeatActive = true
      } else if (this.repeatActive) {
        this.delay.reset()
        this.repeatActive = false
      }

      left = this.sanitizeSample(mixL)
      right = this.sanitizeSample(mixR)
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

  private scheduleShatterEvent(): number {
    const step = this.patch.shatterSteps[this.shatterStepIndex]
    this.lastShatterStep = this.shatterStepIndex
    const shouldSpawn = step.enabled && this.rng.nextFloat() <= step.probability
    if (shouldSpawn) this.spawnGrain(step.pitchOffsetSemitones, step.reverse)

    const stepFrames = shatterStepFrames(
      this.sampleRate,
      this.patch.bpm,
      this.patch.shatterDivision,
    )
    this.nextGrainFrame += Math.max(1, stepFrames / step.ratchet)
    this.shatterRatchetIndex += 1
    if (this.shatterRatchetIndex >= step.ratchet) {
      this.shatterRatchetIndex = 0
      this.shatterStepIndex = (this.shatterStepIndex + 1) % this.patch.shatterSteps.length
    }

    return shouldSpawn ? 1 : 0
  }

  private spawnGrain(pitchOffsetSemitones = 0, forceReverse = false): void {
    const slot = this.findGrainSlot()
    const regionStart = Math.floor(this.patch.regionStart * (this.sourceLength - 1))
    const regionEnd = Math.max(regionStart + 2, Math.ceil(this.patch.regionEnd * this.sourceLength))
    const regionLength = Math.max(2, regionEnd - regionStart)
    const elapsedSeconds = this.frame / this.sampleRate
    const movingPosition = this.patch.position + elapsedSeconds * this.patch.scanSpeed
    const normalizedPosition = movingPosition - Math.floor(movingPosition)
    const spray = this.rng.nextBipolar() * this.patch.spray * 0.5
    const positionInRegion = this.wrapUnit(normalizedPosition + spray)
    const pitch = this.patch.pitchSemitones + pitchOffsetSemitones
      + this.rng.nextBipolar() * this.patch.pitchSpreadSemitones
    const direction = forceReverse || this.rng.nextFloat() < this.patch.reverseProbability ? -1 : 1
    const pan = this.rng.nextBipolar() * this.patch.stereoSpread
    const durationFrames = Math.max(2, this.patch.grainSizeMs * 0.001 * this.sampleRate)
    const expectedOverlap = Math.max(1, this.patch.densityHz * durationFrames / this.sampleRate)
    const normalizedGain = 1 / Math.sqrt(expectedOverlap)

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
    this.targetDrive = nextPatch.drive
    this.targetCrush = nextPatch.crush
    this.targetDamp = nextPatch.damp
    this.targetSpace = nextPatch.space
    this.targetRepeat = nextPatch.repeat
    this.repeatTimeSeconds = divisionToSeconds(REPEAT_DIVISION, nextPatch.bpm)
    if (nextPatch.seed !== previousSeed) this.rng.reset(nextPatch.seed)
    if (
      forceResync
      || nextPatch.mode !== previousPatch.mode
      || nextPatch.bpm !== previousPatch.bpm
      || nextPatch.shatterDivision !== previousPatch.shatterDivision
    ) {
      this.resyncScheduler(schedulerFrame)
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

  private sanitizeSample(value: number): number {
    if (!Number.isFinite(value)) return 0
    const magnitude = Math.abs(value)
    if (magnitude <= 0.95) return value
    const compressed = 0.95 + 0.05 * Math.tanh((magnitude - 0.95) / 0.05)
    return Math.sign(value) * compressed
  }
}

function encodeWindow(window: GrainWindow): number {
  switch (window) {
    case 'percussive': return 1
    case 'hard': return 2
    case 'reverse': return 3
    case 'hann':
    default: return 0
  }
}

function decodeWindow(code: number): GrainWindow {
  switch (code) {
    case 1: return 'percussive'
    case 2: return 'hard'
    case 3: return 'reverse'
    case 0:
    default: return 'hann'
  }
}
