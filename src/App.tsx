import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { AudioEngine, type AudioEngineState } from './audio/AudioEngine'
import {
  DEFAULT_PATCH,
  resetAdvancedToDefault,
  SHATTER_DIVISIONS,
  sanitizePatch,
  type AudioSourceMode,
  type GrainMode,
  type GrainPatch,
} from './audio/contracts'
import { createDemoSource } from './audio/demoSource'
import { FACTORY_PRESETS } from './audio/factoryPresets'
import { applyMacro } from './audio/macros'
import { mutatePatch } from './audio/mutate'
import { MidiInput } from './instrument/midi'
import { controlForKey, isEditableTarget, isNoteKey, keyToSemitone } from './instrument/qwertyKeymap'
import { VoiceAllocator } from './instrument/voiceAllocator'
import { MotionRecorder, resolvePresetMotion, type MotionData } from './performance/motion'
import { PresetStore, serializePreset, type Preset } from './storage/presets'
import { AbletonLinkClient, initialLinkState, type LinkState } from './transport/abletonLink'
import { AdvancedControls } from './components/AdvancedControls'
import { MacroControls } from './components/MacroControls'
import { FxRack } from './components/fx/FxRack'
import { ParameterControl } from './components/ParameterControl'
import { PresetControls } from './components/PresetControls'
import { ShatterSequencer } from './components/ShatterSequencer'
import { Waveform } from './components/Waveform'
import { Wordmark } from './components/Wordmark'
import { XYPad } from './components/XYPad'
import './styles.css'

// Memoized patch-editing panels. Telemetry updates several top-level states ~30 Hz;
// without these, the whole tree re-renders on every tick. These panels depend only
// on `patch` + stable callbacks (not telemetry), so memo lets them skip telemetry
// renders entirely — the largest mobile-perf win. (Waveform/meter intentionally
// still update, since they ARE the telemetry-driven UI.)
const FxRackMemo = memo(FxRack)
const AdvancedControlsMemo = memo(AdvancedControls)
const MacroControlsMemo = memo(MacroControls)
const XYPadMemo = memo(XYPad)
const ShatterSequencerMemo = memo(ShatterSequencer)

// Wall-clock millis for preset timestamps. Kept at module scope so the call site
// inside event handlers does not trip the react-hooks purity rule.
const epochMs = (): number => Date.now()

const MODE_COPY: Record<GrainMode, { title: string; detail: string }> = {
  bloom: {
    title: 'Bloom',
    detail: 'Slow clouds, suspended detail, open air.',
  },
  shatter: {
    title: 'Shatter',
    detail: 'Tight fragments, repetition, controlled damage.',
  },
}

const INITIAL_DEMO_PEAKS = createDemoSource(8_000).peaks

interface SampleView {
  label: string
  peaks: Float32Array
}

const EMPTY_GRAIN_VISUALS = new Float32Array(0)

interface GrainVisualState {
  count: number
  positions: Float32Array<ArrayBufferLike>
  intensities: Float32Array<ArrayBufferLike>
}

export default function App() {
  const engineRef = useRef<AudioEngine | null>(null)
  const [engineState, setEngineState] = useState<AudioEngineState>('idle')
  const [patch, setPatchState] = useState<GrainPatch>({ ...DEFAULT_PATCH })
  const [peaks, setPeaks] = useState<Float32Array | null>(INITIAL_DEMO_PEAKS)
  const [sourceLabel, setSourceLabel] = useState('Generated tone field')
  const [sampleView, setSampleView] = useState<SampleView>({
    label: 'Generated tone field',
    peaks: INITIAL_DEMO_PEAKS,
  })
  const [sourceMode, setSourceMode] = useState<AudioSourceMode>('sample')
  const [frozen, setFrozen] = useState(false)
  const [liveBufferSeconds, setLiveBufferSeconds] = useState(0)
  // Guards against firing a second getUserMedia() while one is in flight (rapid
  // clicks); the ref blocks re-entry, the state disables the button.
  const [liveInputPending, setLiveInputPending] = useState(false)
  const liveInputPendingRef = useRef(false)
  // Generation tokens so a slower async load that resolves after a newer one is
  // discarded instead of clobbering the current selection (file decode / preset).
  const fileLoadGenerationRef = useRef(0)
  const presetLoadGenerationRef = useRef(0)
  const [activeGrains, setActiveGrains] = useState(0)
  const [peak, setPeak] = useState(0)
  const [currentShatterStep, setCurrentShatterStep] = useState(0)
  const [grainVisuals, setGrainVisuals] = useState<GrainVisualState>({
    count: 0,
    positions: EMPTY_GRAIN_VISUALS,
    intensities: EMPTY_GRAIN_VISUALS,
  })
  const [error, setError] = useState<string | null>(null)
  const undoStackRef = useRef<GrainPatch[]>([])
  const mutationSeedRef = useRef(1)
  const [canUndo, setCanUndo] = useState(false)
  const [macroValues, setMacroValues] = useState<Record<string, number>>({})
  const [linkedMacros, setLinkedMacros] = useState<Record<string, boolean>>({})
  const motionRef = useRef(new MotionRecorder())
  const motionRafRef = useRef<number | null>(null)
  const motionT0Ref = useRef(0)
  const motionLoopRef = useRef(0)
  const motionLastUpdateRef = useRef(0)
  const positionRef = useRef(patch.position)
  const [motionState, setMotionState] = useState<'idle' | 'recording' | 'playing'>('idle')
  const [hasMotion, setHasMotion] = useState(false)
  const [keysActive, setKeysActive] = useState(false)
  const octaveRef = useRef(0)
  const heldNotesRef = useRef<Map<string, number>>(new Map())
  const voiceAllocatorRef = useRef(new VoiceAllocator(8))
  const presetStoreRef = useRef(new PresetStore())
  const [presets, setPresets] = useState<Preset[]>([])
  const [presetName, setPresetName] = useState('')
  const linkClientRef = useRef(new AbletonLinkClient())
  const linkEnabledRef = useRef(false)
  const [linkEnabled, setLinkEnabled] = useState(false)
  const [linkState, setLinkState] = useState<LinkState>(initialLinkState())

  useEffect(() => () => {
    void engineRef.current?.close()
  }, [])

  // Load the saved preset list once on mount (IndexedDB may be unavailable).
  useEffect(() => {
    let cancelled = false
    presetStoreRef.current.list()
      .then((list) => { if (!cancelled) setPresets(list) })
      .catch(() => { /* storage unavailable — presets stay empty */ })
    return () => { cancelled = true }
  }, [])

  // Subscribe to the Ableton Link bridge. While Link is enabled and connected it
  // is the tempo master: the session BPM drives the patch (rounded to whole BPM).
  useEffect(() => {
    const client = linkClientRef.current
    const unsubscribe = client.onChange((state) => {
      setLinkState(state)
      if (!linkEnabledRef.current || !state.connected || state.bpm <= 0) return
      setPatchState((current) => {
        const target = Math.round(state.bpm)
        if (target === current.bpm) return current
        const next = sanitizePatch({ ...current, bpm: target })
        engineRef.current?.setPatch(next)
        return next
      })
    })
    return () => {
      unsubscribe()
      client.disconnect()
    }
  }, [])

  // Keep the latest position available to the rAF motion loop without re-subscribing.
  useEffect(() => {
    positionRef.current = patch.position
  }, [patch.position])

  // Cancel any in-flight motion loop on unmount.
  useEffect(() => () => {
    if (motionRafRef.current !== null) cancelAnimationFrame(motionRafRef.current)
  }, [])

  // QWERTY instrument: while active, the computer keyboard plays the source
  // chromatically and polyphonically. Held note keys accumulate as pitch
  // offsets and stream to the engine as voices; keyup releases them. Octave
  // keys shift range, velocity keys nudge output level, and we preventDefault
  // so note keys never collide with other shortcuts.
  useEffect(() => {
    if (!keysActive) return
    const alloc = voiceAllocatorRef.current
    const codeToNote = heldNotesRef.current
    const pushNotes = () => engineRef.current?.setNotes(
      alloc.activeVoices().map((voice) => ({ offset: voice.note, velocity: voice.velocity })),
    )
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return
      // Don't capture keystrokes meant for a text field / select (e.g. the preset
      // name box). Releases of already-held keys still flow through onKeyUp below,
      // which is focus-agnostic, so notes started before the focus moved still stop.
      if (isEditableTarget(event.target)) return
      const { code } = event
      if (isNoteKey(code)) {
        event.preventDefault()
        // Map by code so an octave change between press and release still releases
        // the right note. Computer keys play at full velocity.
        const note = octaveRef.current * 12 + (keyToSemitone(code) ?? 0)
        codeToNote.set(code, note)
        // Owner 'kbd' keeps the computer keyboard's voices independent of MIDI, so
        // releasing a key never silences the same pitch held on a MIDI device.
        alloc.noteOn(note, 1, 'kbd')
        pushNotes()
        return
      }
      const intent = controlForKey(code)
      if (!intent) return
      event.preventDefault()
      if (intent === 'octave-down') octaveRef.current = Math.max(-3, octaveRef.current - 1)
      else if (intent === 'octave-up') octaveRef.current = Math.min(3, octaveRef.current + 1)
      else {
        const delta = intent === 'velocity-up' ? 0.1 : -0.1
        setPatchState((current) => {
          const next = sanitizePatch({ ...current, outputGain: current.outputGain + delta })
          engineRef.current?.setPatch(next)
          return next
        })
      }
    }
    const onKeyUp = (event: KeyboardEvent) => {
      const note = codeToNote.get(event.code)
      if (note === undefined) return
      codeToNote.delete(event.code)
      alloc.noteOff(note, 'kbd')
      pushNotes()
    }
    // MIDI plays the same allocator voices (8-voice steal); middle C (60) = offset 0,
    // and note velocity scales each voice's level.
    const midi = new MidiInput((event) => {
      // Owner per device + channel so the same pitch from different controllers,
      // channels, or the computer keyboard stays independent and releases correctly.
      if (event.type === 'noteon') {
        alloc.noteOn(event.note - 60, event.velocity / 127, `midi:${event.device}:${event.channel}`)
        pushNotes()
      } else if (event.type === 'noteoff') {
        if (alloc.noteOff(event.note - 60, `midi:${event.device}:${event.channel}`) !== null) pushNotes()
      } else if (event.type === 'disconnect') {
        // Unplugged device: release every voice it still holds so notes don't stick.
        if (alloc.releaseOwnerPrefix(`midi:${event.device}:`)) pushNotes()
      }
    })
    // Release every held QWERTY/MIDI voice and tell the engine to play nothing.
    // Shared by the blur/hidden handlers and the effect teardown so the release
    // path is defined once.
    const releaseAllVoices = () => {
      alloc.reset()
      codeToNote.clear()
      engineRef.current?.setNotes([])
    }
    // Losing the window (blur) or tab visibility drops keyup events, which would
    // otherwise leave notes stuck on. Release everything when that happens.
    const onBlur = () => releaseAllVoices()
    const onVisibilityChange = () => {
      if (document.hidden) releaseAllVoices()
    }
    void midi.enable().catch(() => { /* Web MIDI unavailable or permission denied */ })
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      midi.disable()
      releaseAllVoices()
    }
  }, [keysActive])

  // Push a patch onto the bounded undo history before a destructive change.
  const pushUndo = (snapshot: GrainPatch) => {
    undoStackRef.current = [...undoStackRef.current, snapshot].slice(-16)
    setCanUndo(true)
  }

  const applyPatch = (next: GrainPatch) => {
    engineRef.current?.setPatch(next)
    setPatchState(next)
  }

  // Stable across renders (functional setState + refs only) so the memoized
  // panels below skip re-rendering on every ~30 Hz telemetry tick.
  const updatePatch = useCallback((changes: Partial<GrainPatch>) => {
    setPatchState((current) => {
      const next = sanitizePatch({ ...current, ...changes })
      engineRef.current?.setPatch(next)
      return next
    })
  }, [])

  // Stable callbacks for the memoized XY pad / shatter sequencer (avoid inline
  // arrows in JSX, which would defeat memoization).
  const handleXYChange = useCallback((position: number, spray: number) => {
    updatePatch({ position, spray })
  }, [updatePatch])
  const handleShatterStepsChange = useCallback((shatterSteps: GrainPatch['shatterSteps']) => {
    updatePatch({ shatterSteps })
  }, [updatePatch])

  const resetAdvanced = useCallback(() => {
    setPatchState((current) => {
      const next = resetAdvancedToDefault(current)
      engineRef.current?.setPatch(next)
      return next
    })
  }, [])

  const mutate = () => {
    const seed = mutationSeedRef.current
    mutationSeedRef.current += 1
    pushUndo(patch)
    applyPatch(mutatePatch(patch, seed))
  }

  const undo = () => {
    const stack = undoStackRef.current
    if (stack.length === 0) return
    const previous = stack[stack.length - 1]
    undoStackRef.current = stack.slice(0, -1)
    setCanUndo(undoStackRef.current.length > 0)
    applyPatch(previous)
  }

  const setMacro = useCallback((id: string, value: number) => {
    setMacroValues((previous) => ({ ...previous, [id]: value }))
    if (linkedMacros[id] !== false) {
      updatePatch(applyMacro(patch, id, value))
    }
  }, [linkedMacros, patch, updatePatch])

  const toggleMacroLink = useCallback((id: string) => {
    setLinkedMacros((previous) => ({ ...previous, [id]: previous[id] === false }))
  }, [])

  const refreshPresets = () => {
    presetStoreRef.current.list().then(setPresets).catch(() => { /* storage unavailable */ })
  }

  const savePreset = () => {
    const name = presetName.trim() || 'Untitled'
    const motion = hasMotion ? motionRef.current.serialize() : undefined
    presetStoreRef.current.save(serializePreset(name, patch, epochMs(), { motion, sourceLabel }))
      .then(() => {
        setPresetName('')
        refreshPresets()
      })
      .catch(() => setError('Could not save preset — local storage is unavailable.'))
  }

  // Reset the motion lane when loading any preset (user OR factory): stop active
  // playback first, then swap in the preset's recording if it has one, otherwise
  // clear the recording/duration/hasMotion/playback so stale automation can't
  // immediately overwrite the just-loaded patch.
  const applyPresetMotion = (motion?: MotionData) => {
    cancelMotionLoop()
    const resolved = resolvePresetMotion(motion)
    motionRef.current = resolved.recorder
    motionLoopRef.current = resolved.loopMs
    setHasMotion(resolved.hasMotion)
    setMotionState('idle')
  }

  const loadPreset = (name: string) => {
    const generation = (presetLoadGenerationRef.current += 1)
    presetStoreRef.current.load(name)
      .then((preset) => {
        // Ignore a stale load that resolved after a newer preset was requested.
        if (!preset || generation !== presetLoadGenerationRef.current) return
        applyPatch(preset.patch)
        applyPresetMotion(preset.motion)
        if (preset.sourceLabel && preset.sourceLabel !== sourceLabel) {
          setError(`Preset "${name}" was saved with source "${preset.sourceLabel}". Load that source to match its motion and position.`)
        }
      })
      .catch(() => setError('Could not load preset.'))
  }

  const loadFactory = (name: string) => {
    const preset = FACTORY_PRESETS.find((entry) => entry.name === name)
    if (!preset) return
    applyPatch(sanitizePatch({ ...DEFAULT_PATCH, ...preset.patch }))
    // Factory presets carry no motion, so this stops/clears any existing lane.
    applyPresetMotion()
  }

  const deletePreset = (name: string) => {
    presetStoreRef.current.delete(name).then(refreshPresets).catch(() => { /* ignore */ })
  }

  const toggleLink = () => {
    const client = linkClientRef.current
    if (linkEnabled) {
      linkEnabledRef.current = false
      setLinkEnabled(false)
      client.disconnect()
    } else {
      linkEnabledRef.current = true
      setLinkEnabled(true)
      client.connect()
    }
  }

  const cancelMotionLoop = () => {
    if (motionRafRef.current !== null) {
      cancelAnimationFrame(motionRafRef.current)
      motionRafRef.current = null
    }
  }

  const recordMotion = () => {
    cancelMotionLoop()
    motionRef.current.start()
    motionT0Ref.current = -1
    setMotionState('recording')
    const frame = (now: number) => {
      if (motionT0Ref.current < 0) motionT0Ref.current = now
      motionRef.current.record(now - motionT0Ref.current, positionRef.current)
      motionRafRef.current = requestAnimationFrame(frame)
    }
    motionRafRef.current = requestAnimationFrame(frame)
  }

  const finishRecording = () => {
    cancelMotionLoop()
    motionRef.current.stop()
    motionLoopRef.current = motionRef.current.serialize().durationMs
    setHasMotion(motionLoopRef.current > 0)
    setMotionState('idle')
  }

  const playMotion = () => {
    cancelMotionLoop()
    motionT0Ref.current = -1
    motionLastUpdateRef.current = 0
    setMotionState('playing')
    const frame = (now: number) => {
      if (motionT0Ref.current < 0) motionT0Ref.current = now
      const elapsed = now - motionT0Ref.current
      // Throttle position writes to ~30 Hz to respect the worklet patch-rate contract.
      if (elapsed - motionLastUpdateRef.current >= 33) {
        motionLastUpdateRef.current = elapsed
        const value = motionRef.current.value(elapsed, motionLoopRef.current || undefined)
        if (value !== null) updatePatch({ position: value })
      }
      motionRafRef.current = requestAnimationFrame(frame)
    }
    motionRafRef.current = requestAnimationFrame(frame)
  }

  const stopMotionPlayback = () => {
    cancelMotionLoop()
    setMotionState('idle')
  }

  const clearMotion = () => {
    cancelMotionLoop()
    motionRef.current.clear()
    motionLoopRef.current = 0
    setHasMotion(false)
    setMotionState('idle')
  }

  const startAudio = async () => {
    setError(null)
    try {
      const engine = engineRef.current ?? new AudioEngine()
      engineRef.current = engine
      engine.onStateChange(setEngineState)
      engine.onTelemetry((telemetry) => {
        setActiveGrains(telemetry.activeGrains)
        setPeak(telemetry.peak)
        setSourceMode(telemetry.sourceMode)
        setFrozen(telemetry.frozen)
        setLiveBufferSeconds(telemetry.liveBufferSeconds)
        setCurrentShatterStep(telemetry.shatterStep)
        setGrainVisuals({
          count: telemetry.visualGrainCount,
          positions: telemetry.grainPositions,
          intensities: telemetry.grainIntensities,
        })
      })
      engine.onLiveInputEnded(() => {
        // The engine has already frozen the captured buffer; reflect that and tell
        // the player why capture stopped (telemetry will keep the frozen state).
        setFrozen(true)
        setError('Live input device disconnected — the captured buffer is frozen. Press “Use sample” to switch back.')
      })
      const status = await engine.start()
      // Resuming a suspended/interrupted context must keep the current source — a
      // loaded file or frozen live capture — so only a fresh start or an explicit
      // reload (already running) generates and loads the demo source.
      if (status === 'resumed') return
      const source = createDemoSource(engine.sampleRate ?? 48_000)
      setPeaks(source.peaks)
      setSourceLabel(source.label)
      setSampleView({ label: source.label, peaks: source.peaks })
      setSourceMode('sample')
      setFrozen(false)
      engine.setPatch(patch)
      engine.setSource(source)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The audio engine could not start.')
    }
  }

  const loadFile = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    const generation = (fileLoadGenerationRef.current += 1)
    try {
      const engine = engineRef.current
      if (!engine || engineState !== 'running') {
        throw new Error('Start audio before loading a file.')
      }
      const source = await engine.decodeFile(file)
      // A newer file selection started while this one was decoding — drop this
      // (now stale) result so a slow decode can't replace the newer choice.
      if (generation !== fileLoadGenerationRef.current) return
      engine.setSource(source)
      setPeaks(source.peaks)
      setSourceLabel(source.label)
      setSampleView({ label: source.label, peaks: source.peaks })
      setSourceMode('sample')
      setFrozen(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The audio file could not be loaded.')
    }
  }

  const returnToSample = () => {
    engineRef.current?.useSampleSource()
    setSourceMode('sample')
    setFrozen(false)
    setPeaks(sampleView.peaks)
    setSourceLabel(sampleView.label)
  }

  const startLiveInput = async () => {
    if (liveInputPendingRef.current) return
    liveInputPendingRef.current = true
    setLiveInputPending(true)
    setError(null)
    try {
      const engine = engineRef.current
      if (!engine || engineState !== 'running') {
        throw new Error('Start audio before enabling live input.')
      }
      const settings = await engine.enableLiveInput()
      const channels = settings.channelCount ? ` · ${settings.channelCount} ch` : ''
      setSourceMode('live')
      setFrozen(false)
      setLiveBufferSeconds(0)
      setPeaks(null)
      setSourceLabel(`Live input${channels}`)
      updatePatch({ position: 0.92, regionStart: 0, regionEnd: 1, scanSpeed: 0 })
    } catch (caught) {
      // The request was superseded (a newer enable / source switch / shutdown
      // raced this one): not a user-facing error, just drop it.
      if (caught instanceof DOMException && caught.name === 'AbortError') return
      const message = caught instanceof DOMException && caught.name === 'NotAllowedError'
        ? 'Live input permission was denied. Allow microphone access and try again.'
        : caught instanceof Error
          ? caught.message
          : 'Live input could not be enabled.'
      setError(message)
    } finally {
      liveInputPendingRef.current = false
      setLiveInputPending(false)
    }
  }

  const toggleFreeze = () => {
    if (sourceMode !== 'live') return
    const nextFrozen = !frozen
    engineRef.current?.setFrozen(nextFrozen)
    setFrozen(nextFrozen)
  }

  const clearLiveBuffer = () => {
    if (sourceMode !== 'live') return
    engineRef.current?.clearLiveBuffer()
    setFrozen(false)
    setLiveBufferSeconds(0)
  }

  const changeMode = (mode: GrainMode) => {
    updatePatch(mode === 'bloom'
      ? { mode, grainSizeMs: Math.max(140, patch.grainSizeMs), densityHz: 14, timingJitter: 0.08 }
      : { mode, grainSizeMs: Math.min(58, patch.grainSizeMs), densityHz: 24, timingJitter: 0.015 })
  }

  return (
    <main className={`app app--${patch.mode}`}>
      <header className="app-header">
        <div>
          <h1 className="brand"><Wordmark height={26} /></h1>
          <p className="eyebrow">granular instrument · v{__APP_VERSION__}</p>
        </div>
        <div className="engine-status" aria-live="polite">
          <span className={`status-dot status-dot--${engineState}`} />
          <span>{engineState}</span>
          <span className="meter" aria-label={`Output peak ${Math.round(peak * 100)} percent`}>
            <span style={{ width: `${Math.min(100, peak * 100)}%` }} />
          </span>
        </div>
        <div className="source-actions">
          <label className={`file-button ${engineState !== 'running' ? 'is-disabled' : ''}`}>
            Load file
            <input
              type="file"
              accept="audio/*,.wav,.aiff,.aif,.mp3,.m4a,.ogg,.flac"
              disabled={engineState !== 'running'}
              onChange={(event) => void loadFile(event.currentTarget.files?.[0])}
            />
          </label>
          <button
            className="file-button"
            type="button"
            disabled={engineState !== 'running' || liveInputPending}
            aria-pressed={sourceMode === 'live'}
            onClick={() => {
              if (sourceMode === 'live') returnToSample()
              else void startLiveInput()
            }}
          >
            {sourceMode === 'live' ? 'Use sample' : liveInputPending ? 'Enabling…' : 'Live input'}
          </button>
          <button
            className={`file-button ${frozen ? 'is-active' : ''}`}
            type="button"
            disabled={sourceMode !== 'live' || liveBufferSeconds < 0.05}
            aria-pressed={frozen}
            onClick={toggleFreeze}
          >
            {frozen ? 'Frozen' : 'Freeze'}
          </button>
          <button
            className={`file-button ${keysActive ? 'is-active' : ''}`}
            type="button"
            aria-pressed={keysActive}
            onClick={() => setKeysActive((value) => !value)}
          >
            {keysActive ? 'Keys on' : 'Play keys'}
          </button>
          <button
            className={`file-button ${linkEnabled ? 'is-active' : ''}`}
            type="button"
            aria-pressed={linkEnabled}
            onClick={toggleLink}
          >
            {linkEnabled ? 'Link on' : 'Link'}
          </button>
          <button
            className="audio-button"
            type="button"
            onClick={() => void startAudio()}
            disabled={engineState === 'starting'}
          >
            {engineState === 'running' ? 'Reload demo' : 'Start audio'}
          </button>
        </div>
      </header>

      <section className="intro-row">
        <div>
          <h2>{MODE_COPY[patch.mode].title} it.</h2>
          <p>{MODE_COPY[patch.mode].detail}</p>
        </div>
        <div className="mode-switch" aria-label="Granular mode">
          {(['bloom', 'shatter'] as const).map((mode) => (
            <button
              type="button"
              key={mode}
              className={patch.mode === mode ? 'is-active' : ''}
              aria-pressed={patch.mode === mode}
              onClick={() => changeMode(mode)}
            >
              {MODE_COPY[mode].title}
            </button>
          ))}
        </div>
      </section>

      {error && <p className="error-message" role="alert">{error}</p>}

      {linkEnabled && (
        <div className="link-strip" aria-live="polite">
          <span className={`link-dot ${linkState.connected ? 'is-connected' : ''}`} />
          <span>{linkState.connected ? 'Linked' : 'Searching for Link…'}</span>
          {linkState.connected && (
            <span>{linkState.peers} peer{linkState.peers === 1 ? '' : 's'}</span>
          )}
          {linkState.connected && <span>{Math.round(linkState.bpm)} BPM</span>}
          <span className="link-hint">Run the mpump link-bridge to sync tempo.</span>
        </div>
      )}

      <div className="patch-actions">
        <button type="button" className="file-button" onClick={mutate}>Mutate</button>
        <button type="button" className="file-button" onClick={undo} disabled={!canUndo}>Undo</button>
        <span className="patch-actions-hint">Deterministic variation · Undo restores the prior patch</span>
      </div>

      <Waveform
        peaks={peaks}
        mode={patch.mode}
        position={patch.position}
        regionStart={patch.regionStart}
        regionEnd={patch.regionEnd}
        activeGrains={activeGrains}
        visualGrainCount={grainVisuals.count}
        grainPositions={grainVisuals.positions}
        grainIntensities={grainVisuals.intensities}
        emptyLabel={sourceMode === 'live'
          ? `${frozen ? 'Frozen' : 'Capturing'} · ${liveBufferSeconds.toFixed(1)} of 20.0 seconds`
          : 'Choose a source to begin'}
        onPositionChange={(position) => updatePatch({ position })}
      />

      <div className="motion-strip">
        <span className="motion-label">Motion · position</span>
        <button
          type="button"
          className={`file-button ${motionState === 'recording' ? 'is-active' : ''}`}
          aria-pressed={motionState === 'recording'}
          onClick={() => (motionState === 'recording' ? finishRecording() : recordMotion())}
        >
          {motionState === 'recording' ? 'Stop rec' : 'Record'}
        </button>
        <button
          type="button"
          className={`file-button ${motionState === 'playing' ? 'is-active' : ''}`}
          aria-pressed={motionState === 'playing'}
          disabled={!hasMotion}
          onClick={() => (motionState === 'playing' ? stopMotionPlayback() : playMotion())}
        >
          {motionState === 'playing' ? 'Stop' : 'Play'}
        </button>
        <button type="button" className="file-button" disabled={!hasMotion} onClick={clearMotion}>
          Clear
        </button>
      </div>

      {sourceMode === 'live' && (
        <div className="live-strip" aria-live="polite">
          <span className={`live-indicator ${frozen ? 'is-frozen' : ''}`} />
          <span>{frozen ? 'Buffer frozen' : 'Capturing live input'}</span>
          <span>{liveBufferSeconds.toFixed(1)} / 20.0 s</span>
          <button type="button" onClick={clearLiveBuffer}>Clear buffer</button>
          <span className="live-warning">Use headphones to prevent feedback.</span>
        </div>
      )}

      {patch.mode === 'shatter' && (
        <section className="shatter-workspace">
          <div className="shatter-clock">
            <ParameterControl
              label="Tempo"
              value={patch.bpm}
              minimum={30}
              maximum={300}
              step={1}
              unit="BPM"
              decimals={0}
              onChange={(bpm) => updatePatch({ bpm })}
            />
            <label className="division-control">
              <span>Trigger division</span>
              <strong>{patch.shatterDivision}</strong>
              <select
                value={patch.shatterDivision}
                onChange={(event) => updatePatch({
                  shatterDivision: event.currentTarget.value as GrainPatch['shatterDivision'],
                })}
              >
                {SHATTER_DIVISIONS.map((division) => (
                  <option value={division} key={division}>{division}</option>
                ))}
              </select>
            </label>
          </div>
          <ShatterSequencerMemo
            steps={patch.shatterSteps}
            currentStep={currentShatterStep}
            onChange={handleShatterStepsChange}
          />
        </section>
      )}

      <section className="performance-grid">
        <XYPadMemo
          mode={patch.mode}
          x={patch.position}
          y={patch.spray}
          onChange={handleXYChange}
        />

        <div className="direct-controls">
          <div className="panel-heading">
            <span>Grain controls</span>
            <span>direct · always available</span>
          </div>
          <div className="parameter-grid">
            <ParameterControl
              label="Grain size"
              value={patch.grainSizeMs}
              minimum={5}
              maximum={4000}
              unit="ms"
              scale="log"
              decimals={0}
              onChange={(grainSizeMs) => updatePatch({ grainSizeMs })}
            />
            {patch.mode === 'bloom' ? (
              <ParameterControl
                label="Density"
                value={patch.densityHz}
                minimum={0.25}
                maximum={80}
                unit="grains/s"
                scale="log"
                onChange={(densityHz) => updatePatch({ densityHz })}
              />
            ) : (
              <ParameterControl
                label="Pitch spread"
                value={patch.pitchSpreadSemitones}
                minimum={0}
                maximum={24}
                unit="st"
                onChange={(pitchSpreadSemitones) => updatePatch({ pitchSpreadSemitones })}
              />
            )}
            <ParameterControl
              label="Position"
              value={patch.position * 100}
              minimum={0}
              maximum={100}
              unit="%"
              decimals={0}
              onChange={(position) => updatePatch({ position: position / 100 })}
            />
            <ParameterControl
              label="Spray"
              value={patch.spray * 100}
              minimum={0}
              maximum={100}
              unit="%"
              decimals={0}
              onChange={(spray) => updatePatch({ spray: spray / 100 })}
            />
          </div>
        </div>
      </section>

      <MacroControlsMemo
        mode={patch.mode}
        values={macroValues}
        linked={linkedMacros}
        onChange={setMacro}
        onToggleLink={toggleMacroLink}
      />

      <FxRackMemo patch={patch} onChange={updatePatch} />

      <AdvancedControlsMemo patch={patch} onChange={updatePatch} onReset={resetAdvanced} />

      <PresetControls
        presets={presets}
        factory={FACTORY_PRESETS}
        name={presetName}
        onNameChange={setPresetName}
        onSave={savePreset}
        onLoad={loadPreset}
        onLoadFactory={loadFactory}
        onDelete={deletePreset}
      />

      <footer>
        <span>Source · {sourceLabel}{sourceMode === 'live' ? ` · ${frozen ? 'frozen' : 'rolling'}` : ''}</span>
        <span>AudioWorklet · deterministic 64-grain pool</span>
      </footer>
    </main>
  )
}
