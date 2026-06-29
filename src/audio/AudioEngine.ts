import granularWorkletUrl from './granular.worklet.ts?worker&url'
import type {
  EngineTelemetry,
  EngineToMainMessage,
  GrainPatch,
  MainToEngineMessage,
} from './contracts'
import { createWaveformPeaks, type AudioSourceData } from './demoSource'

export type AudioEngineState = 'idle' | 'starting' | 'running' | 'suspended' | 'closed'

export class AudioEngine {
  private context: AudioContext | null = null
  private node: AudioWorkletNode | null = null
  private master: GainNode | null = null
  private limiter: DynamicsCompressorNode | null = null
  private stateListener: ((state: AudioEngineState) => void) | null = null
  private telemetryListener: ((telemetry: EngineTelemetry) => void) | null = null

  get sampleRate(): number | null {
    return this.context?.sampleRate ?? null
  }

  onStateChange(listener: (state: AudioEngineState) => void): () => void {
    this.stateListener = listener
    return () => {
      if (this.stateListener === listener) this.stateListener = null
    }
  }

  onTelemetry(listener: (telemetry: EngineTelemetry) => void): () => void {
    this.telemetryListener = listener
    return () => {
      if (this.telemetryListener === listener) this.telemetryListener = null
    }
  }

  async start(): Promise<void> {
    if (this.context?.state === 'suspended') {
      await this.context.resume()
      this.emitState('running')
      return
    }
    if (this.context && this.node) return

    this.emitState('starting')
    const context = new AudioContext({ latencyHint: 'interactive' })
    this.context = context

    try {
      if (context.state !== 'running') {
        await withTimeout(
          context.resume(),
          5_000,
          'Audio output did not become available. Check the browser audio permissions and try again.',
        )
      }
      await withTimeout(
        context.audioWorklet.addModule(granularWorkletUrl),
        5_000,
        'The granular audio processor did not finish loading. Reload the page and try again.',
      )
      const node = new AudioWorkletNode(context, 'mgrains-granular', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
      })
      const master = context.createGain()
      const limiter = context.createDynamicsCompressor()
      master.gain.value = 0.82
      limiter.threshold.value = -5
      limiter.knee.value = 6
      limiter.ratio.value = 8
      limiter.attack.value = 0.002
      limiter.release.value = 0.12

      node.port.onmessage = (event: MessageEvent<EngineToMainMessage>) => {
        if (event.data.type === 'telemetry') this.telemetryListener?.(event.data)
      }
      node.connect(master).connect(limiter).connect(context.destination)

      this.node = node
      this.master = master
      this.limiter = limiter
      context.onstatechange = () => this.emitState(this.mapContextState(context.state))
      this.emitState(this.mapContextState(context.state))
    } catch (error) {
      await context.close()
      this.context = null
      this.emitState('closed')
      throw error
    }
  }

  setPatch(patch: GrainPatch): void {
    this.send({ type: 'set-patch', patch })
  }

  setSource(source: AudioSourceData): void {
    const left = source.left.slice()
    const right = source.right.slice()
    const message: MainToEngineMessage = { type: 'set-source', channels: [left, right] }
    this.node?.port.postMessage(message, [left.buffer, right.buffer])
  }

  async decodeFile(file: File): Promise<AudioSourceData> {
    if (!this.context) throw new Error('Start the audio engine before loading a file.')
    if (file.size > 100 * 1024 * 1024) {
      throw new Error('Choose an audio file smaller than 100 MB for this foundation build.')
    }

    const encoded = await file.arrayBuffer()
    const decoded = await this.context.decodeAudioData(encoded)
    if (decoded.duration > 10 * 60) {
      throw new Error('Choose an audio file shorter than ten minutes.')
    }

    const left = decoded.getChannelData(0).slice()
    const right = decoded.numberOfChannels > 1
      ? decoded.getChannelData(1).slice()
      : left.slice()

    return {
      label: file.name,
      left,
      right,
      peaks: createWaveformPeaks(left, right),
      durationSeconds: decoded.duration,
    }
  }

  async close(): Promise<void> {
    this.node?.disconnect()
    this.master?.disconnect()
    this.limiter?.disconnect()
    await this.context?.close()
    this.node = null
    this.master = null
    this.limiter = null
    this.context = null
    this.emitState('closed')
  }

  private send(message: MainToEngineMessage): void {
    this.node?.port.postMessage(message)
  }

  private emitState(state: AudioEngineState): void {
    this.stateListener?.(state)
  }

  private mapContextState(state: AudioContextState): AudioEngineState {
    if (state === 'running') return 'running'
    if (state === 'suspended' || state === 'interrupted') return 'suspended'
    return 'closed'
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then(
      (value) => {
        window.clearTimeout(timeout)
        resolve(value)
      },
      (error: unknown) => {
        window.clearTimeout(timeout)
        reject(error)
      },
    )
  })
}
