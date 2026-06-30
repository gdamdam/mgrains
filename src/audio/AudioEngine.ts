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
  private liveStream: MediaStream | null = null
  private liveInputNode: MediaStreamAudioSourceNode | null = null
  private liveTrack: MediaStreamTrack | null = null
  private liveTrackEndedHandler: (() => void) | null = null
  private stateListener: ((state: AudioEngineState) => void) | null = null
  private telemetryListener: ((telemetry: EngineTelemetry) => void) | null = null
  private liveInputEndedListener: (() => void) | null = null

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

  // Fired when the live-input device ends unexpectedly (e.g. unplugged), after
  // the engine has torn the input down and frozen the captured buffer. Lets the
  // UI surface the change without the engine importing React.
  onLiveInputEnded(listener: () => void): () => void {
    this.liveInputEndedListener = listener
    return () => {
      if (this.liveInputEndedListener === listener) this.liveInputEndedListener = null
    }
  }

  async start(): Promise<void> {
    // A user-triggered Start must recover both a suspended context and a Safari
    // "interrupted" one (e.g. after a phone call) — the latter also maps to the
    // suspended UI state, so resuming only literal "suspended" left it stuck.
    if (this.context
      && (this.context.state === 'suspended' || this.context.state === 'interrupted')) {
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
        numberOfInputs: 1,
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

  // Held notes (semitone offset + 0..1 velocity) for chromatic polyphony.
  setNotes(notes: { offset: number; velocity: number }[]): void {
    this.send({ type: 'set-notes', notes })
  }

  setSource(source: AudioSourceData): void {
    this.stopLiveInput()
    const left = source.left.slice()
    const right = source.right.slice()
    const message: MainToEngineMessage = { type: 'set-source', channels: [left, right] }
    this.node?.port.postMessage(message, [left.buffer, right.buffer])
    this.send({ type: 'set-source-mode', mode: 'sample' })
    this.send({ type: 'set-freeze', frozen: false })
  }

  async enableLiveInput(): Promise<MediaTrackSettings> {
    if (!this.context || !this.node) {
      throw new Error('Start the audio engine before enabling live input.')
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser does not provide microphone or line-input access.')
    }

    this.stopLiveInput()
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 2 },
      },
    })
    const track = stream.getAudioTracks()[0]
    if (!track) {
      stream.getTracks().forEach((streamTrack) => streamTrack.stop())
      throw new Error('The selected input did not provide an audio track.')
    }
    if ('contentHint' in track) track.contentHint = 'music'

    const inputNode = this.context.createMediaStreamSource(stream)
    inputNode.connect(this.node)
    // An "ended" event here means the device dropped out unexpectedly — calling
    // track.stop() ourselves does not fire it. stopLiveInput() detaches this
    // handler before any intentional teardown, so a source switch is never
    // mistaken for a disconnect.
    const onEnded = () => this.handleLiveInputDisconnect(stream)
    track.addEventListener('ended', onEnded)

    this.liveStream = stream
    this.liveInputNode = inputNode
    this.liveTrack = track
    this.liveTrackEndedHandler = onEnded
    this.send({ type: 'clear-live-buffer' })
    this.send({ type: 'set-source-mode', mode: 'live' })
    this.send({ type: 'set-freeze', frozen: false })
    return track.getSettings()
  }

  setFrozen(frozen: boolean): void {
    this.send({ type: 'set-freeze', frozen })
  }

  useSampleSource(): void {
    this.stopLiveInput()
    this.send({ type: 'set-source-mode', mode: 'sample' })
    this.send({ type: 'set-freeze', frozen: false })
  }

  clearLiveBuffer(): void {
    this.send({ type: 'clear-live-buffer' })
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
    this.stopLiveInput()
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

  private stopLiveInput(): void {
    // Detach the disconnect handler first so the track.stop() below — an
    // intentional shutdown — is never reported as an unexpected disconnect.
    if (this.liveTrack && this.liveTrackEndedHandler) {
      this.liveTrack.removeEventListener('ended', this.liveTrackEndedHandler)
    }
    this.liveTrack = null
    this.liveTrackEndedHandler = null
    this.liveInputNode?.disconnect()
    this.liveStream?.getTracks().forEach((track) => track.stop())
    this.liveInputNode = null
    this.liveStream = null
  }

  // The live device ended unexpectedly. Tear the input down, then freeze the
  // captured buffer so playback continues from the last live audio with an
  // accurate (frozen) state instead of a dead "Capturing live input", and notify
  // the UI. Ignored if this stream is no longer the active input (already torn
  // down by an intentional source switch).
  private handleLiveInputDisconnect(stream: MediaStream): void {
    if (this.liveStream !== stream) return
    this.stopLiveInput()
    this.send({ type: 'set-freeze', frozen: true })
    this.liveInputEndedListener?.()
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
