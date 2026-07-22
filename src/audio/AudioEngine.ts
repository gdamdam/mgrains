import granularWorkletUrl from './granular.worklet.ts?worker&url'
import type {
  EngineTelemetry,
  EngineToMainMessage,
  GrainPatch,
  MainToEngineMessage,
} from './contracts'
import { createWaveformPeaks, type AudioSourceData } from './demoSource'
import { supportsOutputRouting } from './devices'

// setSinkId on AudioContext is Chromium-only (Safari/Firefox lack it) and is not
// yet in the standard lib types. Narrow to the shape we call rather than casting
// through any.
type SinkCapableContext = AudioContext & { setSinkId(sinkId: string): Promise<void> }

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
  // Bumped on every live-input teardown so a getUserMedia() call still pending
  // from an earlier enableLiveInput() can detect it has been superseded and
  // discard its stream instead of attaching it as an orphan.
  private liveInputGeneration = 0
  // In-flight start(), so concurrent callers coalesce onto one AudioContext
  // instead of each creating their own before the worklet finishes loading.
  private startPromise: Promise<'started' | 'resumed' | 'running'> | null = null
  private stateListener: ((state: AudioEngineState) => void) | null = null
  private telemetryListener: ((telemetry: EngineTelemetry) => void) | null = null
  private liveInputEndedListener: (() => void) | null = null

  get sampleRate(): number | null {
    return this.context?.sampleRate ?? null
  }

  // Current AudioContext time (the shared audio clock the worklet also reads).
  // null until the engine is running.
  get contextTime(): number | null {
    return this.context?.currentTime ?? null
  }

  // Full processed output (post-limiter, pre-destination) for publishing to
  // the mbus patchbay. null until the engine is running.
  getMasterTap(): AudioNode | null {
    return this.limiter
  }

  // Whether this browser can route output to a chosen device via
  // AudioContext.setSinkId (Chromium-only). Safari/Firefox return false → App
  // shows a "use your system/browser audio settings" message instead of a picker.
  // Guarded for SSR / environments where AudioContext is undefined.
  get outputRoutingSupported(): boolean {
    const proto = typeof AudioContext !== 'undefined' ? AudioContext.prototype : null
    return supportsOutputRouting(proto)
  }

  // Route processed output to a specific speaker. deviceId null (or '') selects
  // the system default. Returns false when unsupported or on failure (e.g. the
  // chosen device vanished) — in the failure case we fall back to the default
  // sink so audio is never left routed to a dead device. The graph and master
  // tap/limiter are untouched; only the context's sink changes.
  async setOutputDevice(deviceId: string | null): Promise<boolean> {
    if (!this.context || !this.outputRoutingSupported) return false
    const context = this.context as SinkCapableContext
    try {
      await context.setSinkId(deviceId ?? '')
      return true
    } catch {
      // Chosen device unavailable: revert to the system default so output keeps
      // flowing, then report failure so the UI can reset its selection.
      try {
        await context.setSinkId('')
      } catch {
        // Even the default sink refused; nothing more we can safely do.
      }
      return false
    }
  }

  // Anchor the shatter sequence's step 0 to a shared Link downbeat `secondsFromNow`
  // away. Sent as an absolute AudioContext timestamp so the worklet maps it to its
  // frame clock precisely. No-op until the engine is running.
  alignShatter(secondsFromNow: number): void {
    const context = this.context
    if (!context) return
    this.send({ type: 'align-shatter', time: context.currentTime + Math.max(0, secondsFromNow) })
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

  // Returns how the engine reached a running state so the caller can tell a
  // resume apart from a fresh start: 'resumed' must NOT replace the current
  // source (a loaded file / frozen capture would be lost), whereas 'started'
  // (first init) and 'running' (an explicit reload while already running) may.
  // Concurrent calls share one in-flight promise so the worklet/context is only
  // built once.
  start(): Promise<'started' | 'resumed' | 'running'> {
    this.startPromise ??= this.runStart().finally(() => { this.startPromise = null })
    return this.startPromise
  }

  private async runStart(): Promise<'started' | 'resumed' | 'running'> {
    // A user-triggered Start must recover both a suspended context and a Safari
    // "interrupted" one (e.g. after a phone call) — the latter also maps to the
    // suspended UI state, so resuming only literal "suspended" left it stuck.
    if (this.context
      && (this.context.state === 'suspended' || this.context.state === 'interrupted')) {
      await this.context.resume()
      this.emitState('running')
      return 'resumed'
    }
    if (this.context && this.node) return 'running'

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
      return 'started'
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

  // Global pitch-bend offset in semitones (UI scales the wheel by the patch's
  // bend range before calling this).
  setPitchBend(semitones: number): void {
    this.send({ type: 'set-pitch-bend', semitones })
  }

  // When gated, grains spawn only while a note is held (no autonomous drone).
  setGateToNotes(gated: boolean): void {
    this.send({ type: 'set-gate-to-notes', gated })
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

  // deviceId (optional) pins a specific input; omitted (or exact-match failure at
  // the browser level) falls back to the system default input. The stop/teardown
  // of any prior input below guarantees no leaked stream and no duplicate input
  // node when switching devices. The echoCancellation/noiseSuppression/
  // autoGainControl processing stays disabled for a clean granular capture.
  async enableLiveInput(deviceId?: string): Promise<MediaTrackSettings> {
    if (!this.context || !this.node) {
      throw new Error('Start the audio engine before enabling live input.')
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser does not provide microphone or line-input access.')
    }

    this.stopLiveInput()
    // Capture the generation AFTER tearing down: any later teardown (re-entry,
    // source switch, close) bumps it, marking this request stale on resolve.
    const generation = this.liveInputGeneration
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 2 },
      },
    })
    // Superseded while getUserMedia() was pending (rapid clicks, a source switch,
    // or shutdown): stop the just-acquired stream and bail without attaching it,
    // so we never leave an orphaned mic stream wired into the worklet.
    if (generation !== this.liveInputGeneration || !this.context || !this.node) {
      stream.getTracks().forEach((streamTrack) => streamTrack.stop())
      throw new DOMException('Live input request was superseded.', 'AbortError')
    }
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

    // decodeAudioData() offers no pre-decode metadata: a file's duration — and
    // thus its decoded PCM footprint — is only known once the WHOLE file has
    // been decoded into memory, so the authoritative ten-minute rule below can
    // only run post-decode. Without a guard, a highly compressed long file
    // (e.g. low-bitrate Opus/MP3 within the 100 MB encoded cap) would allocate
    // gigabytes of PCM before that rule ever runs. As a backstop we reject up
    // front when the encoded size, expanded by a conservative worst-case ratio,
    // exceeds a safe decode budget. This is a coarse upper bound — encoded size
    // does not determine decoded size — so it deliberately errs toward catching
    // pathological expansion and may reject some large short lossless files; the
    // ten-minute check remains the precise, authoritative limit.
    const WORST_CASE_DECODE_RATIO = 50 // decoded PCM bytes per encoded byte at very low bitrates
    const MAX_DECODED_BYTES = 2 * 1024 * 1024 * 1024
    if (file.size * WORST_CASE_DECODE_RATIO > MAX_DECODED_BYTES) {
      throw new Error('This audio file is too large to decode safely. Choose a shorter file (under ten minutes).')
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
    // Invalidate any in-flight enableLiveInput(): its pending getUserMedia()
    // result is now stale and must be discarded rather than attached.
    this.liveInputGeneration += 1
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
