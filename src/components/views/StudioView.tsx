import { memo, type ReactNode } from 'react'
import { SHATTER_DIVISIONS, type AudioSourceMode, type GrainMode, type GrainPatch } from '../../audio/contracts'
import { FACTORY_SCENES } from '../../audio/factoryScenes'
import type { AudioEngineState } from '../../audio/AudioEngine'
import type { Preset } from '../../storage/presets'
import type { LinkState } from '../../transport/abletonLink'
import { AdvancedControls } from '../AdvancedControls'
import { MacroControls } from '../MacroControls'
import { FxRack } from '../fx/FxRack'
import { ParameterControl } from '../ParameterControl'
import { HeaderSlider } from '../HeaderSlider'
import { PresetControls } from '../PresetControls'
import { Select } from '../select/Select'
import { ShatterSequencer } from '../ShatterSequencer'
import { Waveform } from '../Waveform'
import { Wordmark } from '../Wordmark'
import { XYPad } from '../XYPad'
import { Dial } from '../dial/Dial'
import { DEMO_SOURCES } from '../../audio/demoSource'

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

interface GrainVisualState {
  count: number
  positions: Float32Array<ArrayBufferLike>
  intensities: Float32Array<ArrayBufferLike>
}

interface StudioViewProps {
  patch: GrainPatch
  engineState: AudioEngineState
  peak: number
  peaks: Float32Array | null
  sourceLabel: string
  sourceMode: AudioSourceMode
  sourceId: string
  frozen: boolean
  liveBufferSeconds: number
  error: string | null
  activeGrains: number
  grainVisuals: GrainVisualState
  currentShatterStep: number
  macroValues: Record<string, number>
  linkedMacros: Record<string, boolean>
  presets: Preset[]
  activeSceneId: string
  presetName: string
  linkEnabled: boolean
  busEnabled: boolean
  linkState: LinkState
  keysActive: boolean
  canUndo: boolean
  motionState: 'idle' | 'recording' | 'playing'
  hasMotion: boolean
  motionLaneCount: number
  liveInputPending: boolean
  onToggleView: () => void
  onChangeMode: (mode: GrainMode) => void
  onUpdatePatch: (changes: Partial<GrainPatch>) => void
  onXYChange: (x: number, y: number) => void
  onShatterStepsChange: (steps: GrainPatch['shatterSteps']) => void
  onSetMacro: (id: string, value: number) => void
  onToggleMacroLink: (id: string) => void
  onResetAdvanced: () => void
  onMutate: () => void
  onUndo: () => void
  onToggleKeys: () => void
  onToggleLink: () => void
  onToggleBus: () => void
  onStartAudio: () => void
  onLoadFile: (file: File | undefined) => void
  onLiveInput: () => void
  onReturnToSample: () => void
  onSelectSource: (id: string) => void
  onToggleFreeze: () => void
  onClearLiveBuffer: () => void
  onWaveformPosition: (position: number) => void
  onRegionChange?: (start: number, end: number) => void
  // Audio-device + MIDI-mapping panel, composed by App and slotted in here so the
  // large device/MIDI prop set doesn't have to thread through this view.
  audioDevicesSlot?: ReactNode
  onRecordMotion: () => void
  onFinishRecording: () => void
  onPlayMotion: () => void
  onStopMotion: () => void
  onClearMotion: () => void
  onPresetNameChange: (name: string) => void
  onSavePreset: () => void
  onLoadPreset: (name: string) => void
  onLoadScene: (id: string) => void
  onDeletePreset: (name: string) => void
  onSaveSession: () => void
  onLoadSession: () => void
  gateToNotes: boolean
  onToggleGate: () => void
}

export function StudioView(props: StudioViewProps) {
  const { patch } = props
  return (
    <div className="view view-studio-inner">
      <header className="app-header">
        <div>
          <h1 className="brand"><Wordmark height={26} /></h1>
          <p className="eyebrow">granular instrument · v{__APP_VERSION__}</p>
        </div>
        <div className="engine-status" aria-live="polite">
          <span className={`status-dot status-dot--${props.engineState}`} />
          <span>{props.engineState}</span>
          <span className="meter" aria-label={`Output peak ${Math.round(props.peak * 100)} percent`}>
            <span style={{ width: `${Math.min(100, props.peak * 100)}%` }} />
          </span>
        </div>
        <div className="source-actions">
          <button className="file-button" type="button" onClick={props.onToggleView}>
            ◂ Live
          </button>
          <button className="file-button" type="button" onClick={props.onSaveSession}>
            Save session
          </button>
          <button className="file-button" type="button" onClick={props.onLoadSession}>
            Load session
          </button>
          <HeaderSlider
            label="Vol"
            value={patch.outputGain}
            min={0}
            max={1}
            step={0.01}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(outputGain) => props.onUpdatePatch({ outputGain })}
          />
          <HeaderSlider
            label="Gain"
            value={patch.inputGain}
            min={0}
            max={2}
            step={0.01}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(inputGain) => props.onUpdatePatch({ inputGain })}
          />
          <Select label="Scene" value={props.activeSceneId}
            placeholder="Load scene…"
            options={FACTORY_SCENES.map((s) => ({ value: s.id, label: s.name }))}
            onChange={props.onLoadScene} />
          <Select label="Source" value={props.sourceId}
            options={DEMO_SOURCES.map((s) => ({ value: s.id, label: s.label }))}
            onChange={props.onSelectSource} />
          <label className={`file-button ${props.engineState !== 'running' ? 'is-disabled' : ''}`}>
            Load file
            <input
              type="file"
              accept="audio/*,.wav,.aiff,.aif,.mp3,.m4a,.ogg,.flac"
              disabled={props.engineState !== 'running'}
              onChange={(event) => props.onLoadFile(event.currentTarget.files?.[0])}
            />
          </label>
          <button
            className="file-button"
            type="button"
            disabled={props.engineState !== 'running' || props.liveInputPending}
            aria-pressed={props.sourceMode === 'live'}
            onClick={() => {
              if (props.sourceMode === 'live') props.onReturnToSample()
              else props.onLiveInput()
            }}
          >
            {props.sourceMode === 'live' ? 'Use sample' : props.liveInputPending ? 'Enabling…' : 'Live input'}
          </button>
          <button
            className={`file-button ${props.frozen ? 'is-active' : ''}`}
            type="button"
            disabled={props.sourceMode !== 'live' || props.liveBufferSeconds < 0.05}
            aria-pressed={props.frozen}
            onClick={props.onToggleFreeze}
          >
            {props.frozen ? 'Frozen' : 'Freeze'}
          </button>
          <button
            className={`file-button ${props.keysActive ? 'is-active' : ''}`}
            type="button"
            aria-pressed={props.keysActive}
            onClick={props.onToggleKeys}
          >
            {props.keysActive ? 'Keys on' : 'Play keys'}
          </button>
          <button
            className={`file-button ${props.gateToNotes ? 'is-active' : ''}`}
            type="button"
            aria-pressed={props.gateToNotes}
            title="Mute the autonomous drone/pattern; sound only while a note is held"
            onClick={props.onToggleGate}
          >
            {props.gateToNotes ? 'Notes only' : 'Auto-play'}
          </button>
          <button
            className={`file-button ${props.linkEnabled ? 'is-active' : ''}`}
            type="button"
            aria-pressed={props.linkEnabled}
            onClick={props.onToggleLink}
          >
            {props.linkEnabled ? 'Link on' : 'Link'}
          </button>
          <button
            className={`file-button ${props.busEnabled ? 'is-active' : ''}`}
            type="button"
            aria-pressed={props.busEnabled}
            title="Publish the master output to the mbus patchbay (needs the local link-bridge; harmless without it)"
            onClick={props.onToggleBus}
          >
            {props.busEnabled ? 'Bus on' : 'Bus'}
          </button>
          <button
            className="audio-button"
            type="button"
            onClick={props.onStartAudio}
            disabled={props.engineState === 'starting'}
          >
            {props.engineState === 'running' ? 'Reload demo' : 'Start audio'}
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
              onClick={() => props.onChangeMode(mode)}
            >
              {MODE_COPY[mode].title}
            </button>
          ))}
        </div>
      </section>

      {props.error && <p className="error-message" role="alert">{props.error}</p>}

      {props.linkEnabled && (
        <div className="link-strip" aria-live="polite">
          <span className={`link-dot ${props.linkState.connected ? 'is-connected' : ''}`} />
          <span>{props.linkState.connected ? 'Linked' : 'Searching for Link…'}</span>
          {props.linkState.connected && (
            <span>{props.linkState.peers} peer{props.linkState.peers === 1 ? '' : 's'}</span>
          )}
          {props.linkState.connected && <span>{Math.round(props.linkState.bpm)} BPM</span>}
          <span className="link-hint">Run the mpump link-bridge to sync tempo.</span>
        </div>
      )}

      <div className="patch-actions">
        <button type="button" className="file-button" onClick={props.onMutate}>Mutate</button>
        <button type="button" className="file-button" onClick={props.onUndo} disabled={!props.canUndo}>Undo</button>
        <span className="patch-actions-hint">Deterministic variation · Undo restores the prior patch</span>
      </div>

      <Waveform
        peaks={props.peaks}
        mode={patch.mode}
        position={patch.position}
        regionStart={patch.regionStart}
        regionEnd={patch.regionEnd}
        activeGrains={props.activeGrains}
        visualGrainCount={props.grainVisuals.count}
        grainPositions={props.grainVisuals.positions}
        grainIntensities={props.grainVisuals.intensities}
        emptyLabel={props.sourceMode === 'live'
          ? `${props.frozen ? 'Frozen' : 'Capturing'} · ${props.liveBufferSeconds.toFixed(1)} of 20.0 seconds`
          : 'Choose a source to begin'}
        onPositionChange={props.onWaveformPosition}
        onRegionChange={props.onRegionChange}
      />
      {props.audioDevicesSlot}

      <div className="motion-strip">
        <span className="motion-label">Motion · position</span>
        <button
          type="button"
          className={`file-button ${props.motionState === 'recording' ? 'is-active' : ''}`}
          aria-pressed={props.motionState === 'recording'}
          onClick={() => (props.motionState === 'recording' ? props.onFinishRecording() : props.onRecordMotion())}
        >
          {props.motionState === 'recording' ? 'Stop rec' : 'Record'}
        </button>
        <button
          type="button"
          className={`file-button ${props.motionState === 'playing' ? 'is-active' : ''}`}
          aria-pressed={props.motionState === 'playing'}
          disabled={!props.hasMotion}
          onClick={() => (props.motionState === 'playing' ? props.onStopMotion() : props.onPlayMotion())}
        >
          {props.motionState === 'playing' ? 'Stop' : 'Play'}
        </button>
        <button type="button" className="file-button" disabled={!props.hasMotion} onClick={props.onClearMotion}>
          Clear
        </button>
        {props.hasMotion && props.motionLaneCount > 0 && (
          <span className="motion-lane-count">
            {props.motionLaneCount} {props.motionLaneCount === 1 ? 'lane' : 'lanes'}
          </span>
        )}
      </div>

      {props.sourceMode === 'live' && (
        <div className="live-strip" aria-live="polite">
          <span className={`live-indicator ${props.frozen ? 'is-frozen' : ''}`} />
          <span>{props.frozen ? 'Buffer frozen' : 'Capturing live input'}</span>
          <span>{props.liveBufferSeconds.toFixed(1)} / 20.0 s</span>
          <button type="button" onClick={props.onClearLiveBuffer}>Clear buffer</button>
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
              disabled={props.linkEnabled && props.linkState.connected}
              onChange={(bpm) => props.onUpdatePatch({ bpm })}
            />
            {props.linkEnabled && props.linkState.connected && (
              <span className="tempo-lock-hint">Tempo set by Link</span>
            )}
            <Select
              label="Trigger division"
              value={patch.shatterDivision}
              options={SHATTER_DIVISIONS.map((d) => ({ value: d, label: d }))}
              onChange={(shatterDivision) => props.onUpdatePatch({ shatterDivision })}
            />
            <ParameterControl
              label="Swing"
              value={patch.shatterSwing * 100}
              minimum={0}
              maximum={60}
              step={1}
              unit="%"
              decimals={0}
              onChange={(value) => props.onUpdatePatch({ shatterSwing: value / 100 })}
            />
          </div>
          <ShatterSequencerMemo
            steps={patch.shatterSteps}
            currentStep={props.currentShatterStep}
            onChange={props.onShatterStepsChange}
          />
        </section>
      )}

      <section className="performance-grid">
        <XYPadMemo
          mode={patch.mode}
          x={patch.position}
          y={patch.spray}
          onChange={props.onXYChange}
        />

        <div className="direct-controls">
          <div className="panel-heading">
            <span>Grain controls</span>
            <span>direct · always available</span>
          </div>
          <div className="parameter-grid">
            <Dial
              label="Grain size"
              value={patch.grainSizeMs}
              minimum={5}
              maximum={4000}
              unit="ms"
              scale="log"
              decimals={0}
              onChange={(grainSizeMs) => props.onUpdatePatch({ grainSizeMs })}
            />
            {patch.mode === 'bloom' ? (
              <Dial
                label="Density"
                value={patch.densityHz}
                minimum={0.25}
                maximum={80}
                unit="grains/s"
                scale="log"
                onChange={(densityHz) => props.onUpdatePatch({ densityHz })}
              />
            ) : (
              <Dial
                label="Pitch spread"
                value={patch.pitchSpreadSemitones}
                minimum={0}
                maximum={24}
                unit="st"
                onChange={(pitchSpreadSemitones) => props.onUpdatePatch({ pitchSpreadSemitones })}
              />
            )}
            <Dial
              label="Position"
              value={patch.position * 100}
              minimum={0}
              maximum={100}
              unit="%"
              decimals={0}
              onChange={(position) => props.onUpdatePatch({ position: position / 100 })}
            />
            <Dial
              label="Spray"
              value={patch.spray * 100}
              minimum={0}
              maximum={100}
              unit="%"
              decimals={0}
              onChange={(spray) => props.onUpdatePatch({ spray: spray / 100 })}
            />
          </div>
        </div>
      </section>

      <MacroControlsMemo
        mode={patch.mode}
        values={props.macroValues}
        linked={props.linkedMacros}
        onChange={props.onSetMacro}
        onToggleLink={props.onToggleMacroLink}
      />

      <FxRackMemo patch={patch} onChange={props.onUpdatePatch} />

      <AdvancedControlsMemo patch={patch} onChange={props.onUpdatePatch} onReset={props.onResetAdvanced} />

      <PresetControls
        presets={props.presets}
        scenes={FACTORY_SCENES}
        name={props.presetName}
        onNameChange={props.onPresetNameChange}
        onSave={props.onSavePreset}
        onLoad={props.onLoadPreset}
        onLoadScene={props.onLoadScene}
        onDelete={props.onDeletePreset}
      />

      <footer>
        <span>Source · {props.sourceLabel}{props.sourceMode === 'live' ? ` · ${props.frozen ? 'frozen' : 'rolling'}` : ''}</span>
        <span>AudioWorklet · deterministic 64-grain pool</span>
      </footer>
    </div>
  )
}
