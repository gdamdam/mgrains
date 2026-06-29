import type { EngineToMainMessage, MainToEngineMessage } from './contracts'
import { GranularCore } from './dsp/GranularCore'

declare const sampleRate: number

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
  private framesUntilTelemetry = 0

  constructor() {
    super()
    this.port.onmessage = (event: MessageEvent<MainToEngineMessage>) => {
      const message = event.data
      switch (message.type) {
        case 'set-patch':
          this.core.setPatch(message.patch)
          break
        case 'set-source':
          this.core.setSource(message.channels[0], message.channels[1])
          break
        case 'clear-source':
          this.core.clearSource()
          break
        case 'reset':
          this.core.reset(message.seed)
          break
      }
    }
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>,
  ): boolean {
    void _parameters
    const output = outputs[0]
    const left = output?.[0]
    if (!left) return true

    const right = output[1] ?? left
    const result = this.core.process(left, right)
    this.framesUntilTelemetry -= left.length

    if (this.framesUntilTelemetry <= 0) {
      const message: EngineToMainMessage = {
        type: 'telemetry',
        frame: this.core.currentFrame,
        activeGrains: result.activeGrains,
        peak: result.peak,
      }
      this.port.postMessage(message)
      this.framesUntilTelemetry = Math.max(1, Math.round(sampleRate / 30))
    }

    return true
  }
}

registerProcessor('mgrains-granular', MgrainsGranularProcessor)
