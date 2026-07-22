import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { AudioEngine, type AudioEngineState } from './audio/AudioEngine'
import {
  filterAudioInputs,
  filterAudioOutputs,
  MIC_DEVICE_HINT_KEY,
  OUTPUT_DEVICE_HINT_KEY,
  resolvePreferredDevice,
  supportsOutputRouting,
  type DeviceOption,
} from './audio/devices'
import { DevicesMidiPanel } from './components/DevicesMidiPanel'
import {
  DEFAULT_PATCH,
  resetAdvancedToDefault,
  sanitizePatch,
  type AudioSourceMode,
  type GrainMode,
  type GrainPatch,
} from './audio/contracts'
import { createDemoSource, DEMO_SOURCES } from './audio/demoSource'
import { findScene } from './audio/factoryScenes'
import {
  KNOWN_SCENE_IDS,
  KNOWN_SOURCE_IDS,
  planSourceRestore,
  relinkMessage,
  resolveSourceIdentityForSave,
  shouldClearSceneId,
} from './storage/sourceIdentity'
import {
  dragEnter,
  dragLeave,
  isOverlayVisible,
  transferHasFiles,
  validateDrop,
  type DropFileInfo,
} from './components/dropTarget'
import { applyMacro, MACROS } from './audio/macros'
import { mutatePatch } from './audio/mutate'
import { MidiInput } from './instrument/midi'
import {
  applyLearn,
  deserializeMidiMappings,
  matchMapping,
  MIDI_MAPPINGS_KEY,
  removeMapping,
  scaleCcToTarget,
  serializeMidiMappings,
  type MidiMapping,
} from './midi/midiMapping'
import {
  createMidiState,
  reduceMidiEvent,
  resetState,
  SUSTAIN_CC,
  type MidiAction,
  type MidiRuntimeState,
} from './midi/midiRuntime'
import { controlForKey, hasCommandModifier, isEditableTarget, isNoteKey, keyToSemitone } from './instrument/qwertyKeymap'
import { VoiceAllocator } from './instrument/voiceAllocator'
import {
  GestureCapture,
  laneValuesAt,
  resolveMotionLanes,
  serializeMotionLanes,
  type MotionLane,
  type MotionLanePlayback,
} from './performance/motionLanes'
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

// Lazy state initializers (localStorage read once, at mount) so we don't call
// setState synchronously inside an effect. Both tolerate storage being unavailable.
function loadMidiMappings(): MidiMapping[] {
  try {
    return deserializeMidiMappings(localStorage.getItem(MIDI_MAPPINGS_KEY))
  } catch {
    return []
  }
}

function loadDeviceHint(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

interface SampleView {
  label: string
  peaks: Float32Array
  sourceId: string
}

// Extract dropped entries as validation info plus the concrete File list. Prefer
// the DataTransferItemList because it exposes directory entries the files list
// omits (a dropped folder has no File entry); fall back to files when needed.
function collectDropFiles(dt: DataTransfer): { infos: DropFileInfo[]; files: File[] } {
  const files = Array.from(dt.files ?? [])
  const items = dt.items ? Array.from(dt.items).filter((item) => item.kind === 'file') : []
  if (items.length > 0) {
    const infos = items.map((item, index): DropFileInfo => {
      const entry = item.webkitGetAsEntry?.()
      const file = files[index]
      return {
        name: file?.name ?? entry?.name ?? 'file',
        type: file?.type ?? '',
        isDirectory: entry?.isDirectory ?? false,
      }
    })
    return { infos, files }
  }
  return { infos: files.map((file): DropFileInfo => ({ name: file.name, type: file.type })), files }
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
  // The factory scene currently loaded, or '' when the patch/source no longer
  // corresponds to one (user file, live input, manual source pick, user preset).
  const [activeSceneId, setActiveSceneId] = useState('')
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
  // Latest patch/source for async startup: startAudio awaits worklet boot, and a
  // scene chosen meanwhile updates these so completion honours the newer choice.
  const patchRef = useRef(patch)
  const sourceIdRef = useRef(sourceId)
  // Latest scene identity for the stable updatePatch callback, so a manual edit
  // can drop the scene label once the patch no longer truthfully matches it.
  const activeSceneIdRef = useRef(activeSceneId)
  // A file dropped (or picked) before audio started: retained and loaded once the
  // user completes the explicit Start-audio gesture. Never creates a context here.
  const pendingFileRef = useRef<File | null>(null)
  // Nested dragenter/leave depth so the drop overlay can't get stuck; state drives
  // the overlay's visibility only when it actually changes.
  const dragDepthRef = useRef(0)
  const [dropActive, setDropActive] = useState(false)
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
  const motionLanesRef = useRef<MotionLanePlayback[]>([])
  const captureRef = useRef<GestureCapture | null>(null)
  const captureLastTMsRef = useRef(0)
  // Params a linked macro fanned out to during the current take; the recorder
  // skips them so only the gestured macro becomes a lane, not its downstream fan-out.
  const macroDrivenParamsRef = useRef<Set<string>>(new Set())
  const motionValuesRef = useRef<Record<string, number>>({})
  const setMacroRef = useRef<(id: string, value: number) => void>(() => {})
  // Latest updatePatch for the MIDI callback (which is declared before updatePatch),
  // so CC-mapped parameter changes route through the same sanitize/engine path.
  const updatePatchRef = useRef<(changes: Partial<GrainPatch>) => void>(() => {})
  const [motionLaneCount, setMotionLaneCount] = useState(0)
  const motionRafRef = useRef<number | null>(null)
  const motionT0Ref = useRef(0)
  const motionLoopRef = useRef(0)
  const motionLastUpdateRef = useRef(0)
  const [motionState, setMotionState] = useState<'idle' | 'recording' | 'playing'>('idle')
  const [hasMotion, setHasMotion] = useState(false)
  const [keysActive, setKeysActive] = useState(false)
  // When on, the autonomous drone/pattern is muted — the instrument only sounds
  // while a QWERTY or MIDI note is held.
  const [gateToNotes, setGateToNotes] = useState(false)
  const octaveRef = useRef(0)
  const heldNotesRef = useRef<Map<string, number>>(new Map())
  const voiceAllocatorRef = useRef(new VoiceAllocator(8))
  // MIDI: pure runtime state (sustain/held/bend, per device+channel) plus the
  // persisted CC→parameter mappings and the current learn target. Refs feed the
  // MIDI event callback without re-subscribing; state mirrors drive the UI.
  const midiStateRef = useRef<MidiRuntimeState>(createMidiState())
  const [midiMappings, setMidiMappings] = useState<MidiMapping[]>(loadMidiMappings)
  const midiMappingsRef = useRef<MidiMapping[]>(midiMappings)
  const midiLearnTargetRef = useRef<string | null>(null)
  const [midiLearnTarget, setMidiLearnTarget] = useState<string | null>(null)
  // Audio-device selection. Browser device ids can change between sessions, so the
  // persisted selection is only a best-effort hint resolved against what's present.
  const [inputDevices, setInputDevices] = useState<DeviceOption[]>([])
  const [outputDevices, setOutputDevices] = useState<DeviceOption[]>([])
  const [selectedInputId, setSelectedInputId] = useState(() => loadDeviceHint(MIC_DEVICE_HINT_KEY))
  const [selectedOutputId, setSelectedOutputId] = useState(() => loadDeviceHint(OUTPUT_DEVICE_HINT_KEY))
  const [deviceLabelsAvailable, setDeviceLabelsAvailable] = useState(false)
  const outputRoutingSupported = typeof AudioContext !== 'undefined'
    && supportsOutputRouting(AudioContext.prototype)
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

  // Persist MIDI mappings (ref + state + localStorage). Stable so the MIDI effect
  // can depend on it without re-subscribing on every render.
  const persistMidiMappings = useCallback((next: MidiMapping[]) => {
    midiMappingsRef.current = next
    setMidiMappings(next)
    try { localStorage.setItem(MIDI_MAPPINGS_KEY, serializeMidiMappings(next)) } catch { /* ignore */ }
  }, [])
  const startMidiLearn = useCallback((target: string) => {
    midiLearnTargetRef.current = target
    setMidiLearnTarget(target)
  }, [])
  const cancelMidiLearn = useCallback(() => {
    midiLearnTargetRef.current = null
    setMidiLearnTarget(null)
  }, [])
  const removeMidiMapping = useCallback((target: string) => {
    persistMidiMappings(removeMapping(midiMappingsRef.current, target))
  }, [persistMidiMappings])

  // Enumerate audio devices (labels are empty until the user has granted mic
  // permission at least once — hence the explicit "enable names" gesture below).
  const refreshDevices = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      setInputDevices(filterAudioInputs(devices))
      setOutputDevices(filterAudioOutputs(devices))
      setDeviceLabelsAvailable(devices.some((device) => device.label !== ''))
    } catch { /* enumeration unavailable */ }
  }, [])

  // Reveal device names via an explicit user gesture: open then immediately release
  // a mic stream (never left running), then re-enumerate now that labels exist.
  const requestDevicePermission = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((track) => track.stop())
      await refreshDevices()
    } catch {
      setError('Microphone permission was denied — device names will stay hidden.')
    }
  }, [refreshDevices])

  // Enumerate now (device hints are lazy-loaded into state above) and keep the
  // lists fresh as devices are plugged/unplugged. State is set from the promise
  // callback (never synchronously in the effect body); listener removed on unmount.
  useEffect(() => {
    const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined
    if (!media?.enumerateDevices) return
    let cancelled = false
    const load = () => {
      media.enumerateDevices().then((devices) => {
        if (cancelled) return
        setInputDevices(filterAudioInputs(devices))
        setOutputDevices(filterAudioOutputs(devices))
        setDeviceLabelsAvailable(devices.some((device) => device.label !== ''))
      }).catch(() => { /* enumeration unavailable */ })
    }
    load()
    media.addEventListener('devicechange', load)
    return () => {
      cancelled = true
      media.removeEventListener('devicechange', load)
    }
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

  // Keep the current values of all watchable targets (5 grain params + the
  // active mode's macros) available to the rAF motion loops without
  // re-subscribing.
  useEffect(() => {
    const values: Record<string, number> = {
      position: patch.position,
      spray: patch.spray,
      grainSizeMs: patch.grainSizeMs,
      densityHz: patch.densityHz,
      pitchSpreadSemitones: patch.pitchSpreadSemitones,
    }
    for (const macro of MACROS) {
      if (macro.mode === patch.mode) values[`macro:${macro.id}`] = macroValues[macro.id] ?? 0
    }
    motionValuesRef.current = values
  }, [patch, macroValues])

  // Keep the latest mode available to the Link callback without re-subscribing.
  useEffect(() => {
    patchModeRef.current = patch.mode
  }, [patch.mode])

  // Keep the latest bend range available to the MIDI callback without re-subscribing.
  useEffect(() => {
    pitchBendRangeRef.current = patch.pitchBendRange
  }, [patch.pitchBendRange])

  // Keep the latest patch/source available to the async startAudio without
  // capturing stale values across its worklet-startup await.
  useEffect(() => {
    patchRef.current = patch
    sourceIdRef.current = sourceId
    activeSceneIdRef.current = activeSceneId
  }, [patch, sourceId, activeSceneId])

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
      const motionLanes = hasMotion ? serializeMotionLanes(motionLanesRef.current) : undefined
      const identity = resolveSourceIdentityForSave({ sourceMode, sourceId, activeSceneId, sourceLabel })
      writeLastSession(serializeSession(patch, viewMode, epochMs(), { motionLanes, ...identity }))
    }, 500)
    return () => window.clearTimeout(handle)
  }, [patch, viewMode, sourceLabel, sourceMode, sourceId, activeSceneId, hasMotion, pendingSession])

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
      // Also drop any sustain/held MIDI state and recentre bend, so losing the
      // window mid-bend or with the pedal down can't leave notes stuck or detuned.
      midiStateRef.current = createMidiState()
      engineRef.current?.setPitchBend(0)
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
    // Apply the pure runtime's action descriptors to the allocator + engine. MIDI
    // plays the same 8-voice allocator (steal); middle C (60) = offset 0, velocity
    // scales each voice. Owner per device+channel keeps controllers/QWERTY independent.
    const applyActions = (actions: MidiAction[]) => {
      let notesChanged = false
      for (const action of actions) {
        if (action.type === 'noteOn') {
          alloc.noteOn(action.note - 60, action.velocity / 127, action.owner)
          notesChanged = true
        } else if (action.type === 'noteOff') {
          if (alloc.noteOff(action.note - 60, action.owner) !== null) notesChanged = true
        } else if (action.type === 'releaseOwner') {
          if (alloc.releaseOwnerPrefix(action.ownerPrefix)) notesChanged = true
        } else if (action.type === 'pitchBend') {
          engineRef.current?.setPitchBend(action.semitones)
        }
      }
      if (notesChanged) pushNotes()
    }
    const midi = new MidiInput((event) => {
      // Notes, sustain (CC64), pitch bend, and disconnect all flow through the pure
      // runtime, which tracks held/sustained notes and per-device bend.
      const result = reduceMidiEvent(midiStateRef.current, event, { pitchBendRange: pitchBendRangeRef.current })
      midiStateRef.current = result.state
      applyActions(result.actions)
      // Non-sustain control changes drive learn / parameter mapping.
      if (event.type === 'cc' && event.controller !== SUSTAIN_CC) {
        const learnTarget = midiLearnTargetRef.current
        if (learnTarget) {
          persistMidiMappings(applyLearn(midiMappingsRef.current, learnTarget, { channel: event.channel, cc: event.controller }))
          midiLearnTargetRef.current = null
          setMidiLearnTarget(null)
          return
        }
        const mapping = matchMapping(midiMappingsRef.current, event.channel, event.controller)
        if (mapping) {
          const value = scaleCcToTarget(event.value, mapping.target)
          if (mapping.target.startsWith('macro:')) setMacroRef.current(mapping.target.slice(6), value)
          else updatePatchRef.current({ [mapping.target]: value } as Partial<GrainPatch>)
        }
      }
    })
    void midi.enable().catch(() => { /* Web MIDI unavailable or permission denied */ })
    return () => {
      midi.disable()
      // Teardown: release every MIDI-held voice and recentre pitch bend so nothing
      // sticks and no residual transposition leaks onto QWERTY or future notes.
      applyActions(resetState(midiStateRef.current).actions)
      midiStateRef.current = createMidiState()
    }
  }, [engineState, persistMidiMappings])

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
    // A manual edit that moves a scene-pinned field off its value means the patch
    // is no longer truthfully that factory scene: drop the scene label so it isn't
    // persisted or displayed dishonestly. Guarded so the common (no-scene) path is
    // free; sanitize is recomputed only while a scene is active.
    const sceneId = activeSceneIdRef.current
    if (sceneId) {
      const base = findScene(sceneId)?.patch ?? null
      const current = patchRef.current
      const next = sanitizePatch({ ...current, ...changes })
      if (shouldClearSceneId(base, current, next)) setActiveSceneId('')
    }
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
      const changes = applyMacro(patch, id, value)
      // Tag the params this macro drives so the recorder attributes the gesture to
      // the macro lane alone, not the several patch params it fans out to.
      for (const key of Object.keys(changes)) macroDrivenParamsRef.current.add(key)
      updatePatch(changes)
    }
  }, [linkedMacros, patch, updatePatch])

  // setMacro's identity changes with `patch`; rAF motion playback must call the
  // latest one without re-subscribing, so mirror it into a ref each render.
  useEffect(() => { setMacroRef.current = setMacro }, [setMacro])
  useEffect(() => { updatePatchRef.current = updatePatch }, [updatePatch])

  const toggleMacroLink = useCallback((id: string) => {
    setLinkedMacros((previous) => ({ ...previous, [id]: previous[id] === false }))
  }, [])

  const refreshPresets = () => {
    presetStoreRef.current.list().then(setPresets).catch(() => { /* storage unavailable */ })
  }

  // What source/scene identity to persist for the current state: a known factory
  // source keeps its stable id, a factory scene its scene id; imported files and
  // live input persist only a sourceLabel relink hint and never masquerade as
  // factory sources.
  const currentSourceIdentity = () =>
    resolveSourceIdentityForSave({ sourceMode, sourceId, activeSceneId, sourceLabel })

  const savePreset = () => {
    const name = presetName.trim() || 'Untitled'
    const motionLanes = hasMotion ? serializeMotionLanes(motionLanesRef.current) : undefined
    presetStoreRef.current.save(serializePreset(name, patch, epochMs(), { motionLanes, ...currentSourceIdentity() }))
      .then(() => {
        setPresetName('')
        refreshPresets()
      })
      .catch(() => setError('Could not save preset — local storage is unavailable.'))
  }

  // Reset the motion lanes when loading any preset (user OR factory): stop active
  // playback first, then swap in the preset's lanes if it has any, otherwise
  // clear them so no stale automation can immediately overwrite the just-loaded
  // patch.
  const applyPresetMotion = (lanes?: MotionLane[]) => {
    cancelMotionLoop()
    const resolved = resolveMotionLanes(lanes)
    motionLanesRef.current = resolved.lanes
    motionLoopRef.current = resolved.loopMs
    setHasMotion(resolved.hasMotion)
    setMotionLaneCount(resolved.lanes.length)
    setMotionState('idle')
  }

  // Restore the source/scene a preset or session was saved with. A known factory
  // source is regenerated and loaded (or remembered for startAudio when the engine
  // isn't running yet); a known factory scene restores its source and scene label;
  // an unknown/removed id or an imported-file/live label falls back to an
  // actionable relink message. Clears stale errors on a clean restore.
  const restoreSourceIdentity = (stored: { sourceId?: string; sceneId?: string; sourceLabel?: string }) => {
    const plan = planSourceRestore(stored, { sourceIds: KNOWN_SOURCE_IDS, sceneIds: KNOWN_SCENE_IDS })
    // A restore is the newest source intent: supersede any in-flight decode and
    // drop a pre-start dropped file so neither can clobber it later.
    fileLoadGenerationRef.current += 1
    pendingFileRef.current = null
    if (plan.kind === 'none') { setError(null); return }
    if (plan.kind === 'relink') { setError(relinkMessage(plan.label)); return }
    setError(null)
    const targetSourceId = plan.kind === 'factory-scene'
      ? (plan.sourceId ?? findScene(plan.sceneId)?.sourceId ?? '')
      : plan.sourceId
    setSourceId(targetSourceId)
    setActiveSceneId(plan.kind === 'factory-scene' ? plan.sceneId : '')
    setSourceMode('sample')
    const engine = engineRef.current
    if (engine && engineState === 'running' && targetSourceId) {
      const source = createDemoSource(engine.sampleRate ?? 48_000, targetSourceId)
      engine.setSource(source)
      setPeaks(source.peaks)
      setSourceLabel(source.label)
      setSampleView({ label: source.label, peaks: source.peaks, sourceId: targetSourceId })
      setFrozen(false)
    }
  }

  const loadPreset = (name: string) => {
    const generation = (presetLoadGenerationRef.current += 1)
    presetStoreRef.current.load(name)
      .then((preset) => {
        // Ignore a stale load that resolved after a newer preset was requested.
        if (!preset || generation !== presetLoadGenerationRef.current) return
        applyPatch(preset.patch)
        applyPresetMotion(preset.motionLanes)
        restoreSourceIdentity({ sourceId: preset.sourceId, sceneId: preset.sceneId, sourceLabel: preset.sourceLabel })
      })
      .catch(() => setError('Could not load preset.'))
  }

  // Load a factory scene: switch to its generated source AND apply its patch, so
  // two scenes on the same source clearly sound different. Works before the
  // engine starts (patch applies to state; the source is remembered in sourceId
  // and loaded by startAudio) so first-run selection needs no live engine.
  const loadScene = (id: string) => {
    const scene = findScene(id)
    if (!scene) return
    // Picking a scene supersedes any in-flight file decode (shares the file-load
    // token) and any pre-start dropped file so neither can later clobber this
    // source, and clears stale errors.
    fileLoadGenerationRef.current += 1
    pendingFileRef.current = null
    setError(null)
    applyPatch(sanitizePatch({ ...DEFAULT_PATCH, ...scene.patch }))
    // Scenes carry no motion, so this stops/clears any existing lanes.
    applyPresetMotion()
    setActiveSceneId(id)
    setSourceId(scene.sourceId)
    const engine = engineRef.current
    if (engine && engineState === 'running') {
      const source = createDemoSource(engine.sampleRate ?? 48_000, scene.sourceId)
      engine.setSource(source)
      setPeaks(source.peaks)
      setSourceLabel(source.label)
      setSampleView({ label: source.label, peaks: source.peaks, sourceId: scene.sourceId })
      setSourceMode('sample')
      setFrozen(false)
    }
  }

  const deletePreset = (name: string) => {
    presetStoreRef.current.delete(name).then(refreshPresets).catch(() => { /* ignore */ })
  }

  // Restore a full session (from the Continue banner or an imported file). Same
  // path for both: swap patch + motion + view, and prompt a relink if the saved
  // source differs, mirroring loadPreset.
  const applySession = (session: Session) => {
    applyPatch(session.patch)
    applyPresetMotion(session.motionLanes)
    setViewMode(session.viewMode)
    writeViewMode(session.viewMode)
    restoreSourceIdentity({ sourceId: session.sourceId, sceneId: session.sceneId, sourceLabel: session.sourceLabel })
  }

  const continueLastSession = () => {
    if (pendingSession) applySession(pendingSession)
    setPendingSession(null)
  }

  const saveSessionFile = () => {
    const motionLanes = hasMotion ? serializeMotionLanes(motionLanesRef.current) : undefined
    const session = serializeSession(patch, viewMode, epochMs(), { motionLanes, ...currentSourceIdentity() })
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

  // Tear down any live publication/socket on unmount or hot reload so an enabled
  // bus can't outlive the component. Kept unmount-only (empty deps) so it never
  // churns the publication on the reconciliation effect's ordinary re-runs.
  useEffect(() => () => {
    mbusPubRef.current?.stop()
    mbusPubRef.current = null
    mbusTapRef.current = null
    mbusClientRef.current?.disconnect()
  }, [])

  const cancelMotionLoop = () => {
    if (motionRafRef.current !== null) {
      cancelAnimationFrame(motionRafRef.current)
      motionRafRef.current = null
    }
  }

  const recordMotion = () => {
    cancelMotionLoop()
    captureRef.current = new GestureCapture(motionValuesRef.current)
    captureLastTMsRef.current = 0
    motionT0Ref.current = -1
    // Fresh take: forget fan-out tags accrued by earlier macro moves.
    macroDrivenParamsRef.current = new Set()
    setMotionState('recording')
    const frame = (now: number) => {
      if (motionT0Ref.current < 0) motionT0Ref.current = now
      const tMs = now - motionT0Ref.current
      captureLastTMsRef.current = tMs
      captureRef.current?.sample(tMs, motionValuesRef.current, macroDrivenParamsRef.current)
      motionRafRef.current = requestAnimationFrame(frame)
    }
    motionRafRef.current = requestAnimationFrame(frame)
  }

  const finishRecording = () => {
    cancelMotionLoop()
    const lanes = captureRef.current?.finish(captureLastTMsRef.current) ?? []
    captureRef.current = null
    const resolved = resolveMotionLanes(lanes)
    motionLanesRef.current = resolved.lanes
    motionLoopRef.current = resolved.loopMs
    setHasMotion(resolved.hasMotion)
    setMotionLaneCount(resolved.lanes.length)
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
      // Throttle writes to ~30 Hz to respect the worklet patch-rate contract.
      if (elapsed - motionLastUpdateRef.current >= 33) {
        motionLastUpdateRef.current = elapsed
        const values = laneValuesAt(motionLanesRef.current, elapsed, motionLoopRef.current)
        const changes: Partial<GrainPatch> = {}
        for (const [target, value] of values) {
          if (target.startsWith('macro:')) {
            // Skip macro lanes that don't exist in the current mode: motionValuesRef
            // only ever carries the active mode's macros.
            if (target in motionValuesRef.current) setMacroRef.current(target.slice(6), value)
          } else {
            (changes as Record<string, number>)[target] = value
          }
        }
        if (Object.keys(changes).length > 0) updatePatch(changes)
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
    motionLanesRef.current = []
    motionLoopRef.current = 0
    setHasMotion(false)
    setMotionLaneCount(0)
    setMotionState('idle')
  }

  // Decode a file on an already-running engine and swap it in. Bumps the shared
  // file-load token and drops its own result if a newer source intent (another
  // file, scene, source pick, live input, drop, or restore) superseded it while
  // decoding — so the newest choice always wins. Shared by the picker and drop.
  const decodeAndApplyFile = async (engine: AudioEngine, file: File) => {
    const generation = (fileLoadGenerationRef.current += 1)
    const source = await engine.decodeFile(file)
    if (generation !== fileLoadGenerationRef.current) return
    engine.setSource(source)
    setPeaks(source.peaks)
    setSourceLabel(source.label)
    setSampleView({ label: source.label, peaks: source.peaks, sourceId: '' })
    setSourceMode('sample')
    setSourceId('')
    setActiveSceneId('')
    setFrozen(false)
  }

  // Load a file that was dropped/picked before audio started, once the engine is
  // live. Runs on the fresh-start gesture only — it never creates a context itself.
  const maybeLoadPendingFile = async (engine: AudioEngine) => {
    const file = pendingFileRef.current
    if (!file) return
    pendingFileRef.current = null
    try {
      await decodeAndApplyFile(engine, file)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The audio file could not be loaded.')
    }
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
      // reload (already running) generates and loads the demo source. Either way a
      // file dropped/picked before start is the newest intent and loads now.
      if (status === 'resumed') {
        await maybeLoadPendingFile(engine)
        return
      }
      // Honour a source/scene chosen before the engine started (default is
      // harmonic-pad). Re-read via refs after the await so a scene picked while
      // audio was "Starting…" wins over the value captured at click time.
      // createDemoSource falls back to the first entry for an unknown id, so
      // resolve the id we actually loaded to keep state honest.
      const latestSourceId = sourceIdRef.current
      const desiredId = DEMO_SOURCES.some((entry) => entry.id === latestSourceId) ? latestSourceId : 'harmonic-pad'
      const source = createDemoSource(engine.sampleRate ?? 48_000, desiredId)
      setSourceId(desiredId)
      setPeaks(source.peaks)
      setSourceLabel(source.label)
      setSampleView({ label: source.label, peaks: source.peaks, sourceId: desiredId })
      setSourceMode('sample')
      setFrozen(false)
      engine.setPatch(patchRef.current)
      engine.setGateToNotes(gateToNotes)
      engine.setSource(source)
      await maybeLoadPendingFile(engine)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The audio engine could not start.')
    }
  }

  const loadFile = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    const engine = engineRef.current
    if (!engine || engineState !== 'running') {
      // Before audio starts, retain the file and load it on the Start gesture so
      // the picker matches drag-and-drop and never opens a context implicitly.
      pendingFileRef.current = file
      setError('Press Start audio to load this file.')
      return
    }
    try {
      await decodeAndApplyFile(engine, file)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The audio file could not be loaded.')
    }
  }

  const returnToSample = () => {
    // Switching back off live input clears the "device disconnected" notice.
    setError(null)
    engineRef.current?.useSampleSource()
    setSourceMode('sample')
    setSourceId(sampleView.sourceId)
    setActiveSceneId('')
    setFrozen(false)
    setPeaks(sampleView.peaks)
    setSourceLabel(sampleView.label)
  }

  const startLiveInput = async (deviceId?: string) => {
    if (liveInputPendingRef.current) return
    liveInputPendingRef.current = true
    setLiveInputPending(true)
    setError(null)
    // Enabling live input supersedes any in-flight file decode (shares the file-load
    // token) and any pre-start dropped file so neither can later stop live input
    // and swap the source.
    fileLoadGenerationRef.current += 1
    pendingFileRef.current = null
    try {
      const engine = engineRef.current
      if (!engine || engineState !== 'running') {
        throw new Error('Start audio before enabling live input.')
      }
      // Resolve the chosen input against what's actually present (the persisted id
      // may have vanished); null falls back to the browser default.
      const resolvedInput = resolvePreferredDevice(deviceId ?? selectedInputId ?? null, inputDevices)
      const settings = await engine.enableLiveInput(resolvedInput ?? undefined)
      const channels = settings.channelCount ? ` · ${settings.channelCount} ch` : ''
      setSourceMode('live')
      setSourceId('')
      setActiveSceneId('')
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

  const selectInputDevice = (deviceId: string) => {
    setSelectedInputId(deviceId)
    try {
      if (deviceId) localStorage.setItem(MIC_DEVICE_HINT_KEY, deviceId)
      else localStorage.removeItem(MIC_DEVICE_HINT_KEY)
    } catch { /* storage unavailable */ }
    // Re-open live input on the newly chosen device if it's currently active.
    if (sourceMode === 'live') void startLiveInput(deviceId || undefined)
  }

  const selectOutputDevice = (deviceId: string) => {
    setSelectedOutputId(deviceId)
    try {
      if (deviceId) localStorage.setItem(OUTPUT_DEVICE_HINT_KEY, deviceId)
      else localStorage.removeItem(OUTPUT_DEVICE_HINT_KEY)
    } catch { /* storage unavailable */ }
    const engine = engineRef.current
    if (!engine) return
    void engine.setOutputDevice(deviceId || null).then((ok) => {
      // A false result means the device vanished or the browser can't route; the
      // engine has already fallen back to the default, so just surface a notice.
      if (!ok) setError('Could not switch the output device; using the default.')
    })
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
    // Supersede any in-flight file decode (shares the file-load token) and any
    // pre-start dropped file, and clear stale errors so neither can later replace
    // this pick.
    fileLoadGenerationRef.current += 1
    pendingFileRef.current = null
    setError(null)
    const source = createDemoSource(engine.sampleRate ?? 48_000, id)
    engine.setSource(source)
    setSourceId(id)
    setActiveSceneId('')
    setPeaks(source.peaks)
    setSourceLabel(source.label)
    setSampleView({ label: source.label, peaks: source.peaks, sourceId: id })
    setSourceMode('sample')
    setFrozen(false)
  }, [engineState])

  // Drag-and-drop audio loading. Only file drags are claimed (text/link drags fall
  // through to the browser, and preventDefault stops it navigating to the file).
  // A nested enter/leave depth keeps the overlay from sticking; the drop reuses the
  // one central loadFile path, so all size/duration/decode/stale-request/ordering
  // safeguards apply, and a drop before audio starts is retained as a pending file.
  const handleDragEnter = (event: DragEvent<HTMLElement>) => {
    if (!transferHasFiles(event.dataTransfer.types)) return
    event.preventDefault()
    dragDepthRef.current = dragEnter(dragDepthRef.current)
    if (isOverlayVisible(dragDepthRef.current)) setDropActive(true)
  }
  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    if (!transferHasFiles(event.dataTransfer.types)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }
  const handleDragLeave = (event: DragEvent<HTMLElement>) => {
    if (!transferHasFiles(event.dataTransfer.types)) return
    dragDepthRef.current = dragLeave(dragDepthRef.current)
    if (!isOverlayVisible(dragDepthRef.current)) setDropActive(false)
  }
  const handleDrop = (event: DragEvent<HTMLElement>) => {
    if (!transferHasFiles(event.dataTransfer.types)) return
    event.preventDefault()
    dragDepthRef.current = 0
    setDropActive(false)
    const { infos, files } = collectDropFiles(event.dataTransfer)
    const result = validateDrop(infos)
    if (!result.ok) {
      setError(result.error)
      return
    }
    const file = files[result.index]
    if (!file) {
      setError('No file found — drop an audio file.')
      return
    }
    void loadFile(file)
  }
  const dropHandlers = {
    onDragEnter: handleDragEnter,
    onDragOver: handleDragOver,
    onDragLeave: handleDragLeave,
    onDrop: handleDrop,
  }
  const dropOverlay = dropActive ? (
    <div className="drop-overlay" aria-hidden="true">
      <span className="drop-overlay__label">Drop audio to load</span>
    </div>
  ) : null

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
      <main className={`app app--${patch.mode} view-${viewMode}`} {...dropHandlers}>
        {sessionChrome}
        {dropOverlay}
        <LiveView
          patch={patch}
          engineState={engineState}
          peak={peak}
          peaks={peaks}
          sourceLabel={sourceLabel}
          sourceMode={sourceMode}
          sourceId={sourceId}
          activeSceneId={activeSceneId}
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
          motionLaneCount={motionLaneCount}
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
          onLoadScene={loadScene}
          onWaveformPosition={(position) => updatePatch({ position })}
          onRegionChange={(regionStart, regionEnd) => updatePatch({ regionStart, regionEnd })}
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
    <main className={`app app--${patch.mode} view-${viewMode}`} {...dropHandlers}>
      {sessionChrome}
      {dropOverlay}
      <StudioView
        patch={patch}
        engineState={engineState}
        peak={peak}
        peaks={peaks}
        sourceLabel={sourceLabel}
        sourceMode={sourceMode}
        sourceId={sourceId}
        activeSceneId={activeSceneId}
        frozen={frozen}
        liveBufferSeconds={liveBufferSeconds}
        error={error}
        activeGrains={activeGrains}
        grainVisuals={grainVisuals}
        currentShatterStep={currentShatterStep}
        macroValues={macroValues}
        linkedMacros={linkedMacros}
        presets={presets}
        presetName={presetName}
        linkEnabled={linkEnabled}
        busEnabled={busEnabled}
        linkState={linkState}
        keysActive={keysActive}
        gateToNotes={gateToNotes}
        canUndo={canUndo}
        motionState={motionState}
        hasMotion={hasMotion}
        motionLaneCount={motionLaneCount}
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
        onRegionChange={(regionStart, regionEnd) => updatePatch({ regionStart, regionEnd })}
        audioDevicesSlot={
          <DevicesMidiPanel
            inputDevices={inputDevices}
            outputDevices={outputDevices}
            selectedInputId={selectedInputId}
            selectedOutputId={selectedOutputId}
            outputSupported={outputRoutingSupported}
            deviceLabelsAvailable={deviceLabelsAvailable}
            onRequestDevicePermission={() => void requestDevicePermission()}
            onRefreshDevices={() => void refreshDevices()}
            onSelectInput={selectInputDevice}
            onSelectOutput={selectOutputDevice}
            midiMappings={midiMappings}
            midiLearnTarget={midiLearnTarget}
            onStartMidiLearn={startMidiLearn}
            onCancelMidiLearn={cancelMidiLearn}
            onRemoveMidiMapping={removeMidiMapping}
          />
        }
        onRecordMotion={recordMotion}
        onFinishRecording={finishRecording}
        onPlayMotion={playMotion}
        onStopMotion={stopMotionPlayback}
        onClearMotion={clearMotion}
        onPresetNameChange={setPresetName}
        onSavePreset={savePreset}
        onLoadPreset={loadPreset}
        onLoadScene={loadScene}
        onDeletePreset={deletePreset}
        onSaveSession={saveSessionFile}
        onLoadSession={openSessionFile}
      />
    </main>
  )
}
