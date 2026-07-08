import { useCallback, useEffect, useRef, useState } from 'react'
import { AudioEngine, type AudioEngineState } from './audio/AudioEngine'
import {
  DEFAULT_PATCH,
  resetAdvancedToDefault,
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
import { controlForKey, hasCommandModifier, isEditableTarget, isNoteKey, keyToSemitone } from './instrument/qwertyKeymap'
import { VoiceAllocator } from './instrument/voiceAllocator'
import { MotionRecorder, resolvePresetMotion, type MotionData } from './performance/motion'
import { PresetStore, serializePreset, type Preset } from './storage/presets'
import {
  deserializeSession,
  readLastSession,
  serializeSession,
  writeLastSession,
  type Session,
} from './storage/session'
import { SessionBanner } from './components/SessionBanner'
import {
  AbletonLinkClient,
  initialLinkState,
  LINK_QUANTUM,
  secondsUntilDownbeat,
  type LinkState,
} from './transport/abletonLink'
import { createMbusClient, type MbusClient, type Publication } from './transport/mbus'
import { readViewMode, writeViewMode, type ViewMode } from './ui/viewMode'
import { LiveView } from './components/views/LiveView'
import { StudioView } from './components/views/StudioView'
import './styles.css'

// Wall-clock millis for preset timestamps. Kept at module scope so the call site
// inside event handlers does not trip the react-hooks purity rule.
const epochMs = (): number => Date.now()

const INITIAL_DEMO_PEAKS = createDemoSource(8_000).peaks

interface SampleView {
  label: string
  peaks: Float32Array
  sourceId: string
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
    sourceId: 'harmonic-pad',
  })
  const [sourceMode, setSourceMode] = useState<AudioSourceMode>('sample')
  const [sourceId, setSourceId] = useState('harmonic-pad')
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
  // When on, the autonomous drone/pattern is muted — the instrument only sounds
  // while a QWERTY or MIDI note is held.
  const [gateToNotes, setGateToNotes] = useState(false)
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
  // mbus publish (see src/transport/mbus): offer the master output to the mbus
  // patchbay over the same local link-bridge. Off by default and session-
  // transient; until enabled no client exists and no socket is opened.
  const mbusClientRef = useRef<MbusClient | null>(null)
  const mbusPubRef = useRef<Publication | null>(null)
  const mbusTapRef = useRef<AudioNode | null>(null)
  const [busEnabled, setBusEnabled] = useState(false)
  // Latest patch mode, read from the Link callback without re-subscribing.
  const patchModeRef = useRef(patch.mode)
  const pitchBendRangeRef = useRef(patch.pitchBendRange)
  // Last whole BPM pushed from Link, so we can tell a real tempo change (re-anchor)
  // from the fractional jitter the bridge sends every ~20Hz frame.
  const linkBpmRef = useRef(0)
  // Shatter bar-alignment gate: re-anchor on (re)activation and at most once per
  // bar for drift, never per Link frame. lastAnchorTime is an AudioContext time.
  const linkAlignRef = useRef({ active: false, lastAnchorTime: Number.NEGATIVE_INFINITY })
  const [viewMode, setViewMode] = useState<ViewMode>(readViewMode)
  const toggleViewMode = useCallback(() => {
    setViewMode((current) => {
      const next: ViewMode = current === 'live' ? 'studio' : 'live'
      writeViewMode(next)
      return next
    })
  }, [])
  // The auto-saved last session, captured once at mount, offered via a banner
  // until the user continues or dismisses it. Autosave holds off until then so a
  // fresh page's default state can't overwrite it before the user chooses.
  const [pendingSession, setPendingSession] = useState<Session | null>(readLastSession)
  const sessionFileInputRef = useRef<HTMLInputElement | null>(null)

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
      if (!linkEnabledRef.current || !state.connected || state.bpm <= 0) {
        // Disabled / disconnected: leave the shatter sequencer free-running exactly
        // as before, and forget any anchor so re-connecting re-anchors cleanly.
        linkAlignRef.current.active = false
        return
      }
      const target = Math.round(state.bpm)
      const bpmChanged = target !== linkBpmRef.current
      linkBpmRef.current = target
      setPatchState((current) => {
        if (target === current.bpm) return current
        const next = sanitizePatch({ ...current, bpm: target })
        engineRef.current?.setPatch(next)
        return next
      })

      // Ableton Link bar alignment. Only meaningful while the session is playing
      // and we're in shatter mode: anchor step 0 to the shared downbeat. We do NOT
      // send any transport command (mgrains reads Link's transport, never drives
      // it — so there is no command echo to guard against). Re-anchor on becoming
      // active, on a genuine tempo change, and at most once per bar to correct
      // drift — never on every ~20Hz frame, and always forward onto a future bar.
      const engine = engineRef.current
      const contextTime = engine?.contextTime ?? null
      const shouldAlign = state.playing && patchModeRef.current === 'shatter'
      if (engine && contextTime !== null && shouldAlign) {
        const align = linkAlignRef.current
        const barSeconds = LINK_QUANTUM * 60 / state.bpm
        if (bpmChanged || !align.active || contextTime - align.lastAnchorTime >= barSeconds) {
          engine.alignShatter(secondsUntilDownbeat(state.phase, state.bpm, LINK_QUANTUM))
          align.lastAnchorTime = contextTime
        }
        align.active = true
      } else {
        // Remote stop, non-shatter mode, or engine not running: stop re-anchoring.
        // The granular instrument keeps sounding (it is always-on, not a Play/Stop
        // transport), it simply free-runs until the session starts again.
        linkAlignRef.current.active = false
      }
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

  // Keep the latest mode available to the Link callback without re-subscribing.
  useEffect(() => {
    patchModeRef.current = patch.mode
  }, [patch.mode])

  // Keep the latest bend range available to the MIDI callback without re-subscribing.
  useEffect(() => {
    pitchBendRangeRef.current = patch.pitchBendRange
  }, [patch.pitchBendRange])

  // Push the note-gate toggle to the engine when it changes (a fresh start also
  // seeds it in startAudio, for the case it was toggled before audio began).
  useEffect(() => {
    engineRef.current?.setGateToNotes(gateToNotes)
  }, [gateToNotes])

  // Auto-persist the working state (debounced) so it can be restored next launch.
  // Held off while a restore banner is pending so a fresh default state can't
  // clobber the stored session before the user continues or dismisses.
  useEffect(() => {
    if (pendingSession) return
    const handle = window.setTimeout(() => {
      const motion = hasMotion ? motionRef.current.serialize() : undefined
      writeLastSession(serializeSession(patch, viewMode, epochMs(), { motion, sourceLabel }))
    }, 500)
    return () => window.clearTimeout(handle)
  }, [patch, viewMode, sourceLabel, hasMotion, pendingSession])

  // Cancel any in-flight motion loop on unmount.
  useEffect(() => () => {
    if (motionRafRef.current !== null) cancelAnimationFrame(motionRafRef.current)
  }, [])

  // Note-safety net: always on — any input path (QWERTY or MIDI) can hold
  // notes, so the blur/hidden release-all must outlive the Keys toggle.
  useEffect(() => {
    const alloc = voiceAllocatorRef.current
    // Release every held QWERTY/MIDI voice and tell the engine to play nothing.
    // Losing the window (blur) or tab visibility drops keyup events, which would
    // otherwise leave notes stuck on.
    const releaseAllVoices = () => {
      alloc.reset()
      heldNotesRef.current.clear()
      engineRef.current?.setNotes([])
    }
    const onBlur = () => releaseAllVoices()
    const onVisibilityChange = () => {
      if (document.hidden) releaseAllVoices()
    }
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      releaseAllVoices()
    }
  }, [])

  // MIDI input: independent of the Keys toggle, so a plugged controller just
  // works — but enabled only once audio runs, because requestMIDIAccess() can
  // prompt for permission and must stay tied to the start-audio gesture, never
  // page load (README privacy promise).
  useEffect(() => {
    if (engineState !== 'running') return
    const alloc = voiceAllocatorRef.current
    const pushNotes = () => engineRef.current?.setNotes(
      alloc.activeVoices().map((voice) => ({ offset: voice.note, velocity: voice.velocity })),
    )
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
      } else if (event.type === 'pitchbend') {
        // Normalized -1..1 → semitones scaled by the patch's bend range.
        engineRef.current?.setPitchBend(event.value * pitchBendRangeRef.current)
      } else if (event.type === 'disconnect') {
        // Unplugged device: release every voice it still holds so notes don't stick.
        if (alloc.releaseOwnerPrefix(`midi:${event.device}:`)) pushNotes()
      }
    })
    void midi.enable().catch(() => { /* Web MIDI unavailable or permission denied */ })
    return () => {
      midi.disable()
      // Release only MIDI-held voices — QWERTY voices belong to their own effect.
      if (alloc.releaseOwnerPrefix('midi:')) pushNotes()
    }
  }, [engineState])

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
      // Never hijack browser/OS shortcuts. Releasing QWERTY voices here also
      // prevents a stuck note when macOS suppresses the letter keyup in a Cmd
      // chord; MIDI voices remain untouched.
      if (hasCommandModifier(event)) {
        if (alloc.releaseOwnerPrefix('kbd')) pushNotes()
        codeToNote.clear()
        return
      }
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
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      // Toggling Keys off releases only keyboard-held voices — notes held on a
      // MIDI controller keep sounding (MIDI lives in its own effect above).
      if (alloc.releaseOwnerPrefix('kbd')) pushNotes()
      codeToNote.clear()
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
        // TEMPORARY (removed in Task 5): read the position lane back out of
        // motionLanes until App migrates off the single-lane motion API.
        applyPresetMotion(preset.motionLanes?.find((lane) => lane.target === 'position')?.data)
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

  // Restore a full session (from the Continue banner or an imported file). Same
  // path for both: swap patch + motion + view, and prompt a relink if the saved
  // source differs, mirroring loadPreset.
  const applySession = (session: Session) => {
    applyPatch(session.patch)
    applyPresetMotion(session.motion)
    setViewMode(session.viewMode)
    writeViewMode(session.viewMode)
    if (session.sourceLabel && session.sourceLabel !== sourceLabel) {
      setError(`Session was saved with source "${session.sourceLabel}". Load that source to match its motion and position.`)
    }
  }

  const continueLastSession = () => {
    if (pendingSession) applySession(pendingSession)
    setPendingSession(null)
  }

  const saveSessionFile = () => {
    const motion = hasMotion ? motionRef.current.serialize() : undefined
    const session = serializeSession(patch, viewMode, epochMs(), { motion, sourceLabel })
    const blob = new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `mgrains-session-${session.savedAt}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const onSessionFileChange = (file: File | undefined) => {
    if (!file) return
    file.text()
      .then((text) => {
        applySession(deserializeSession(JSON.parse(text)))
        setPendingSession(null)
      })
      .catch(() => setError('Could not read that session file.'))
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

  const toggleBus = () => setBusEnabled((value) => !value)

  // Reconcile the bus intent with the live graph. Re-runs when the engine
  // (re)starts or closes so the publication always feeds the current limiter;
  // disable unannounces the source and drops the bridge socket.
  useEffect(() => {
    const tap = engineRef.current?.getMasterTap() ?? null
    if (mbusPubRef.current && (mbusTapRef.current !== tap || !busEnabled)) {
      mbusPubRef.current.stop()
      mbusPubRef.current = null
      mbusTapRef.current = null
    }
    if (busEnabled && tap && !mbusPubRef.current) {
      mbusClientRef.current ??= createMbusClient()
      mbusClientRef.current.connect()
      mbusPubRef.current = mbusClientRef.current.publishOutput(tap, 'mgrains')
      mbusTapRef.current = tap
    }
    if (!busEnabled) mbusClientRef.current?.disconnect()
  }, [busEnabled, engineState])

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
      setSourceId('harmonic-pad')
      setPeaks(source.peaks)
      setSourceLabel(source.label)
      setSampleView({ label: source.label, peaks: source.peaks, sourceId: 'harmonic-pad' })
      setSourceMode('sample')
      setFrozen(false)
      engine.setPatch(patch)
      engine.setGateToNotes(gateToNotes)
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
      setSampleView({ label: source.label, peaks: source.peaks, sourceId: '' })
      setSourceMode('sample')
      setSourceId('')
      setFrozen(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The audio file could not be loaded.')
    }
  }

  const returnToSample = () => {
    engineRef.current?.useSampleSource()
    setSourceMode('sample')
    setSourceId(sampleView.sourceId)
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
      setSourceId('')
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

  // Loads a curated demo source by id from the Source dropdown (both views).
  // Only meaningful while the engine is running; otherwise there's nothing to
  // push the source into.
  const onSelectSource = useCallback((id: string) => {
    const engine = engineRef.current
    if (!engine || engineState !== 'running') return
    const source = createDemoSource(engine.sampleRate ?? 48_000, id)
    engine.setSource(source)
    setSourceId(id)
    setPeaks(source.peaks)
    setSourceLabel(source.label)
    setSampleView({ label: source.label, peaks: source.peaks, sourceId: id })
    setSourceMode('sample')
    setFrozen(false)
  }, [engineState])

  // Session chrome shared by both views: the Continue banner (when a last session
  // exists) and the hidden file input backing "Load session".
  const sessionChrome = (
    <>
      {pendingSession && (
        <SessionBanner
          sourceLabel={pendingSession.sourceLabel}
          onContinue={continueLastSession}
          onDismiss={() => setPendingSession(null)}
        />
      )}
      <input
        ref={sessionFileInputRef}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(event) => {
          onSessionFileChange(event.currentTarget.files?.[0])
          event.currentTarget.value = ''
        }}
      />
    </>
  )
  const openSessionFile = () => sessionFileInputRef.current?.click()

  if (viewMode === 'live') {
    return (
      <main className={`app app--${patch.mode} view-${viewMode}`}>
        {sessionChrome}
        <LiveView
          patch={patch}
          engineState={engineState}
          peak={peak}
          peaks={peaks}
          sourceLabel={sourceLabel}
          sourceMode={sourceMode}
          sourceId={sourceId}
          frozen={frozen}
          liveBufferSeconds={liveBufferSeconds}
          error={error}
          activeGrains={activeGrains}
          grainVisuals={grainVisuals}
          macroValues={macroValues}
          linkedMacros={linkedMacros}
          keysActive={keysActive}
          linkEnabled={linkEnabled}
          busEnabled={busEnabled}
          gateToNotes={gateToNotes}
          motionState={motionState}
          hasMotion={hasMotion}
          canUndo={canUndo}
          onStartAudio={() => void startAudio()}
          onToggleGate={() => setGateToNotes((value) => !value)}
          onToggleView={toggleViewMode}
          onChangeMode={changeMode}
          onUpdatePatch={updatePatch}
          onXYChange={handleXYChange}
          onSetMacro={setMacro}
          onToggleMacroLink={toggleMacroLink}
          onToggleKeys={() => setKeysActive((value) => !value)}
          onToggleLink={toggleLink}
          onToggleBus={toggleBus}
          onSelectSource={onSelectSource}
          onWaveformPosition={(position) => updatePatch({ position })}
          onRecordMotion={recordMotion}
          onFinishRecording={finishRecording}
          onPlayMotion={playMotion}
          onStopMotion={stopMotionPlayback}
          onClearMotion={clearMotion}
          onMutate={mutate}
          onUndo={undo}
          onSaveSession={saveSessionFile}
          onLoadSession={openSessionFile}
        />
      </main>
    )
  }

  return (
    <main className={`app app--${patch.mode} view-${viewMode}`}>
      {sessionChrome}
      <StudioView
        patch={patch}
        engineState={engineState}
        peak={peak}
        peaks={peaks}
        sourceLabel={sourceLabel}
        sourceMode={sourceMode}
        sourceId={sourceId}
        frozen={frozen}
        liveBufferSeconds={liveBufferSeconds}
        error={error}
        activeGrains={activeGrains}
        grainVisuals={grainVisuals}
        currentShatterStep={currentShatterStep}
        macroValues={macroValues}
        linkedMacros={linkedMacros}
        presets={presets}
        factory={FACTORY_PRESETS}
        presetName={presetName}
        linkEnabled={linkEnabled}
        busEnabled={busEnabled}
        linkState={linkState}
        keysActive={keysActive}
        gateToNotes={gateToNotes}
        canUndo={canUndo}
        motionState={motionState}
        hasMotion={hasMotion}
        liveInputPending={liveInputPending}
        onToggleView={toggleViewMode}
        onToggleGate={() => setGateToNotes((value) => !value)}
        onChangeMode={changeMode}
        onUpdatePatch={updatePatch}
        onXYChange={handleXYChange}
        onShatterStepsChange={handleShatterStepsChange}
        onSetMacro={setMacro}
        onToggleMacroLink={toggleMacroLink}
        onResetAdvanced={resetAdvanced}
        onMutate={mutate}
        onUndo={undo}
        onToggleKeys={() => setKeysActive((value) => !value)}
        onToggleLink={toggleLink}
        onToggleBus={toggleBus}
        onStartAudio={() => void startAudio()}
        onLoadFile={(file) => void loadFile(file)}
        onLiveInput={() => void startLiveInput()}
        onReturnToSample={returnToSample}
        onSelectSource={onSelectSource}
        onToggleFreeze={toggleFreeze}
        onClearLiveBuffer={clearLiveBuffer}
        onWaveformPosition={(position) => updatePatch({ position })}
        onRecordMotion={recordMotion}
        onFinishRecording={finishRecording}
        onPlayMotion={playMotion}
        onStopMotion={stopMotionPlayback}
        onClearMotion={clearMotion}
        onPresetNameChange={setPresetName}
        onSavePreset={savePreset}
        onLoadPreset={loadPreset}
        onLoadFactoryPreset={loadFactory}
        onDeletePreset={deletePreset}
        onSaveSession={saveSessionFile}
        onLoadSession={openSessionFile}
      />
    </main>
  )
}
