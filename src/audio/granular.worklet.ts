import type {
  AudioSourceMode,
  EngineToMainMessage,
  MainToEngineMessage,
} from './contracts'
import { GranularCore } from './dsp/GranularCore'
import { StereoCircularBuffer } from './dsp/StereoCircularBuffer'

declare const sampleRate: number
// AudioWorkletGlobalScope clock, in seconds, updated per render quantum. Used to
// convert a shared AudioContext timestamp into this engine's frame counter.
declare const currentTime: number

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort
  abstract process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean
}

declare function registerProcessor(
  name: string,
  processorCtor: new () => AudioWorkletProcessor,
): void

class MgrainsGranularProcessor extends AudioWorkletProcessor {
  private readonly core = new GranularCore({ sampleRate, maxGrains: 64 })
  private readonly liveBuffer = new StereoCircularBuffer(Math.round(sampleRate * 20))
  private staticLeft: Float32Array<ArrayBufferLike> = new Float32Array(0)
  private staticRight: Float32Array<ArrayBufferLike> = new Float32Array(0)
  private sourceMode: AudioSourceMode = 'sample'
  private framesUntilTelemetry = 0
  private readonly visualPositions = new Float32Array(24)
  private readonly visualIntensities = new Float32Array(24)

  constructor() {
    super()
    this.port.onmessage = (event: MessageEvent<MainToEngineMessage>) => {
      const message = event.data
      switch (message.type) {
        case 'set-patch':
          this.core.setPatch(message.patch)
          break
        case 'set-source':
          this.staticLeft = message.channels[0]
          this.staticRight = message.channels[1]
          if (this.sourceMode === 'sample') {
            this.core.setSource(this.staticLeft, this.staticRight)
          }
          break
        case 'set-source-mode':
          this.sourceMode = message.mode
          if (message.mode === 'sample') {
            this.core.setSource(this.staticLeft, this.staticRight)
          } else {
            this.updateLiveSourceView()
            this.core.reset()
          }
          break
        case 'set-freeze':
          this.liveBuffer.setFrozen(message.frozen)
          break
        case 'clear-live-buffer':
          this.liveBuffer.clear()
          if (this.sourceMode === 'live') {
            this.updateLiveSourceView()
            this.core.reset()
          }
          break
        case 'clear-source':
          this.core.clearSource()
          break
        case 'set-notes':
          this.core.setActiveNotes(message.notes)
          break
        case 'set-pitch-bend':
          this.core.setPitchBend(message.semitones)
          break
        case 'set-gate-to-notes':
          this.core.setGateToNotes(message.gated)
          break
        case 'reset':
          this.core.reset(message.seed)
          break
        case 'align-shatter': {
          // message.time is a shared AudioContext timestamp. Convert to a frame in
          // the core's clock using this worklet's own currentTime, so main->worklet
          // message latency is absorbed rather than baked into the anchor.
          const framesFromNow = Math.max(0, Math.round((message.time - currentTime) * sampleRate))
          this.core.alignShatterAtFrame(this.core.currentFrame + framesFromNow)
          break
        }
      }
    }
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>,
  ): boolean {
    const input = _inputs[0]
    const inputLeft = input?.[0]
    if (inputLeft) this.liveBuffer.write(inputLeft, input[1])
    if (this.sourceMode === 'live') this.updateLiveSourceView()

    void _parameters
    const output = outputs[0]
    const left = output?.[0]
    if (!left) return true

    const right = output[1] ?? left
    const result = this.core.process(left, right)
    this.framesUntilTelemetry -= left.length

    if (this.framesUntilTelemetry <= 0) {
      const visualGrainCount = this.core.writeVisualState(
        this.visualPositions,
        this.visualIntensities,
      )
      const message: EngineToMainMessage = {
        type: 'telemetry',
        frame: this.core.currentFrame,
        activeGrains: result.activeGrains,
        peak: result.peak,
        sourceMode: this.sourceMode,
        liveBufferSeconds: this.liveBuffer.validLength / sampleRate,
        frozen: this.liveBuffer.frozen,
        shatterStep: result.currentStep,
        visualGrainCount,
        grainPositions: this.visualPositions,
        grainIntensities: this.visualIntensities,
      }
      this.port.postMessage(message)
      this.framesUntilTelemetry = Math.max(1, Math.round(sampleRate / 30))
    }

    return true
  }

  private updateLiveSourceView(): void {
    this.core.setSourceView(
      this.liveBuffer.left,
      this.liveBuffer.right,
      this.liveBuffer.validLength,
      this.liveBuffer.chronologicalOffset,
    )
  }
}

registerProcessor('mgrains-granular', MgrainsGranularProcessor)
