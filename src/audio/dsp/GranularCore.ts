import {
  DEFAULT_PATCH,
  sanitizePatch,
  type GrainPatch,
} from '../contracts'
import { XorShift32 } from './rng'
import { shatterStepFrames } from './shatterTiming'
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

  private readonly active: Uint8Array
  private readonly sourcePosition: Float64Array
  private readonly grainSourceOffset: Float64Array
  private readonly step: Float64Array
  private readonly age: Float64Array
  private readonly duration: Float64Array
  private readonly gainLeft: Float32Array
  private readonly gainRight: Float32Array

  constructor({ sampleRate, maxGrains = DEFAULT_MAX_GRAINS }: GranularCoreOptions) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new RangeError('sampleRate must be a finite positive number')
    }

    this.sampleRate = sampleRate
    this.maxGrains = Math.max(1, Math.floor(maxGrains))
    this.rng = new XorShift32(this.patch.seed)
    this.active = new Uint8Array(this.maxGrains)
    this.sourcePosition = new Float64Array(this.maxGrains)
    this.grainSourceOffset = new Float64Array(this.maxGrains)
    this.step = new Float64Array(this.maxGrains)
    this.age = new Float64Array(this.maxGrains)
    this.duration = new Float64Array(this.maxGrains)
    this.gainLeft = new Float32Array(this.maxGrains)
    this.gainRight = new Float32Array(this.maxGrains)
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

  setPatch(nextPatch: GrainPatch): void {
    const previousPatch = this.patch
    const previousSeed = this.patch.seed
    this.patch = sanitizePatch(nextPatch)
    if (this.patch.seed !== previousSeed) this.rng.reset(this.patch.seed)
    if (
      this.patch.mode !== previousPatch.mode
      || this.patch.bpm !== previousPatch.bpm
      || this.patch.shatterDivision !== previousPatch.shatterDivision
    ) {
      this.resyncScheduler()
    }
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

  reset(seed = this.patch.seed): void {
    this.active.fill(0)
    this.age.fill(0)
    this.frame = 0
    this.nextGrainFrame = 0
    this.shatterStepIndex = 0
    this.shatterRatchetIndex = 0
    this.lastShatterStep = 0
    this.rng.reset(seed)
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

    for (let offset = 0; offset < outputLeft.length; offset += 1) {
      const absoluteFrame = this.frame + offset

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

        const envelope = grainWindow(this.patch.window, phase)
        const sourceFrame = this.wrapLogicalFrame(this.sourcePosition[grain])
        const sourceLeft = this.readLinear(
          this.sourceLeft,
          sourceFrame,
          this.grainSourceOffset[grain],
        )
        const sourceRight = this.readLinear(
          this.sourceRight,
          sourceFrame,
          this.grainSourceOffset[grain],
        )

        left += sourceLeft * envelope * this.gainLeft[grain]
        right += sourceRight * envelope * this.gainRight[grain]

        this.sourcePosition[grain] += this.step[grain]
        this.age[grain] += 1
      }

      left = this.sanitizeSample(left)
      right = this.sanitizeSample(right)
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
    const normalizedGain = this.patch.outputGain / Math.sqrt(expectedOverlap)

    this.active[slot] = 1
    this.sourcePosition[slot] = regionStart + positionInRegion * (regionLength - 1)
    this.grainSourceOffset[slot] = this.sourceFrameOffset
    this.step[slot] = direction * 2 ** (pitch / 12)
    this.age[slot] = 0
    this.duration[slot] = durationFrames
    this.gainLeft[slot] = normalizedGain * (pan > 0 ? Math.cos(pan * Math.PI * 0.5) : 1)
    this.gainRight[slot] = normalizedGain * (pan < 0 ? Math.cos(-pan * Math.PI * 0.5) : 1)
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

  private resyncScheduler(): void {
    this.nextGrainFrame = this.frame
    this.shatterStepIndex = 0
    this.shatterRatchetIndex = 0
    this.lastShatterStep = 0
  }

  private readLinear(
    channel: Float32Array<ArrayBufferLike>,
    frame: number,
    frameOffset: number,
  ): number {
    const logicalFirst = Math.floor(frame)
    const logicalSecond = this.wrapLogicalFrame(logicalFirst + 1)
    const fraction = frame - logicalFirst
    const first = this.toPhysicalFrame(logicalFirst, frameOffset, channel.length)
    const second = this.toPhysicalFrame(logicalSecond, frameOffset, channel.length)
    return channel[first] + (channel[second] - channel[first]) * fraction
  }

  private wrapLogicalFrame(frame: number): number {
    const start = Math.floor(this.patch.regionStart * (this.sourceLength - 1))
    const end = Math.max(start + 2, Math.ceil(this.patch.regionEnd * this.sourceLength))
    const length = Math.max(2, end - start)
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
