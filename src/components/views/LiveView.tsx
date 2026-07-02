import { memo } from 'react'
import { HeaderSlider } from '../HeaderSlider'
import { MacroControls } from '../MacroControls'
import { Select } from '../select/Select'
import { Waveform } from '../Waveform'
import { XYPad } from '../XYPad'
import { Dial } from '../dial/Dial'
import { DEMO_SOURCES } from '../../audio/demoSource'
import type { GrainMode, GrainPatch } from '../../audio/contracts'
import type { AudioEngineState } from '../../audio/AudioEngine'

// Preserve App's perf boundary: this view re-renders on ~30 Hz telemetry (peak,
// grain visuals — App state, not patch), but XY pad + macros depend only on
// patch fields + stable callbacks, so memo skips them on a telemetry tick.
const XYPadMemo = memo(XYPad)
const MacroControlsMemo = memo(MacroControls)

interface GrainVisualState { count: number; positions: Float32Array; intensities: Float32Array }
interface LiveViewProps {
  patch: GrainPatch
  engineState: AudioEngineState
  peak: number
  peaks: Float32Array | null
  sourceLabel: string
  sourceMode: 'sample' | 'live'
  sourceId: string
  frozen: boolean
  liveBufferSeconds: number
  activeGrains: number
  grainVisuals: GrainVisualState
  macroValues: Record<string, number>
  linkedMacros: Record<string, boolean>
  keysActive: boolean
  linkEnabled: boolean
  motionState: 'idle' | 'recording' | 'playing'
  hasMotion: boolean
  canUndo: boolean
  onStartAudio: () => void
  onToggleView: () => void
  onChangeMode: (mode: GrainMode) => void
  onUpdatePatch: (changes: Partial<GrainPatch>) => void
  onXYChange: (x: number, y: number) => void
  onSetMacro: (id: string, value: number) => void
  onToggleMacroLink: (id: string) => void
  onToggleKeys: () => void
  onToggleLink: () => void
  onSelectSource: (id: string) => void
  onWaveformPosition: (position: number) => void
  onRecordMotion: () => void
  onFinishRecording: () => void
  onPlayMotion: () => void
  onStopMotion: () => void
  onClearMotion: () => void
  onMutate: () => void
  onUndo: () => void
  onSaveSession: () => void
  onLoadSession: () => void
}

export function LiveView(props: LiveViewProps) {
  const { patch } = props
  return (
    <div className="view">
      <div className="live-topbar">
        <span className={`status-dot status-dot--${props.engineState}`} />
        <span className="live-status">{props.engineState}</span>
        <span className="meter" aria-label={`Output peak ${Math.round(props.peak * 100)} percent`}>
          <span style={{ width: `${Math.min(100, props.peak * 100)}%` }} />
        </span>
        <button type="button" className="mode-pill" onClick={() => props.onChangeMode(patch.mode === 'bloom' ? 'shatter' : 'bloom')}>
          {patch.mode === 'bloom' ? 'Bloom' : 'Shatter'} ⇄
        </button>
        {patch.mode === 'shatter' && (
          <Dial label="Tempo" value={patch.bpm} minimum={30} maximum={300} step={1} unit="bpm" decimals={0}
            variant="readout" size={40} onChange={(bpm) => props.onUpdatePatch({ bpm })} />
        )}
        <span className="live-source">{props.sourceLabel}</span>
        <span className="live-actions">
          <button type="button" className={`file-button ${props.keysActive ? 'is-active' : ''}`} onClick={props.onToggleKeys}>Keys</button>
          <button type="button" className={`file-button ${props.linkEnabled ? 'is-active' : ''}`} onClick={props.onToggleLink}>Link</button>
          <Select label="Source" value={props.sourceId}
            options={DEMO_SOURCES.map((s) => ({ value: s.id, label: s.label }))}
            onChange={props.onSelectSource} />
          <button type="button" className="studio-toggle" onClick={props.onToggleView}>Studio ▸</button>
        </span>
      </div>
      {props.engineState !== 'running' && (
        <div className="live-start" role="status">
          <p>Start the audio engine to play mgrains.</p>
          <button type="button" className="audio-button" onClick={props.onStartAudio}
            disabled={props.engineState === 'starting'}>
            {props.engineState === 'starting' ? 'Starting…' : 'Tap to start audio'}
          </button>
        </div>
      )}
      <p className="live-hint">Shape FX, sequencer &amp; advanced in Studio ▸</p>

      <Waveform
        peaks={props.peaks} mode={patch.mode} position={patch.position}
        regionStart={patch.regionStart} regionEnd={patch.regionEnd}
        activeGrains={props.activeGrains} visualGrainCount={props.grainVisuals.count}
        grainPositions={props.grainVisuals.positions} grainIntensities={props.grainVisuals.intensities}
        emptyLabel={props.sourceMode === 'live'
          ? `${props.frozen ? 'Frozen' : 'Capturing'} · ${props.liveBufferSeconds.toFixed(1)} of 20.0 seconds`
          : 'Choose a source to begin'}
        onPositionChange={props.onWaveformPosition}
      />

      <div className="live-perform">
        <XYPadMemo mode={patch.mode} x={patch.position} y={patch.spray} onChange={props.onXYChange} />
        <MacroControlsMemo mode={patch.mode} values={props.macroValues} linked={props.linkedMacros}
          onChange={props.onSetMacro} onToggleLink={props.onToggleMacroLink} />
      </div>

      <div className="live-readouts">
        <Dial label="Grain size" value={patch.grainSizeMs} minimum={5} maximum={4000} unit="ms" scale="log" decimals={0}
          variant="readout" onChange={(grainSizeMs) => props.onUpdatePatch({ grainSizeMs })} />
        {patch.mode === 'bloom' ? (
          <Dial label="Density" value={patch.densityHz} minimum={0.25} maximum={80} unit="g/s" scale="log"
            variant="readout" onChange={(densityHz) => props.onUpdatePatch({ densityHz })} />
        ) : (
          <Dial label="Pitch spread" value={patch.pitchSpreadSemitones} minimum={0} maximum={24} unit="st"
            variant="readout" onChange={(pitchSpreadSemitones) => props.onUpdatePatch({ pitchSpreadSemitones })} />
        )}
        <Dial label="Position" value={patch.position * 100} minimum={0} maximum={100} unit="%" decimals={0}
          variant="readout" onChange={(position) => props.onUpdatePatch({ position: position / 100 })} />
      </div>

      <div className="live-toolbar">
        <span className="motion-label">Motion</span>
        <button type="button" className={`file-button ${props.motionState === 'recording' ? 'is-active' : ''}`}
          onClick={() => (props.motionState === 'recording' ? props.onFinishRecording() : props.onRecordMotion())}>
          {props.motionState === 'recording' ? 'Stop rec' : 'Record'}
        </button>
        <button type="button" className={`file-button ${props.motionState === 'playing' ? 'is-active' : ''}`} disabled={!props.hasMotion}
          onClick={() => (props.motionState === 'playing' ? props.onStopMotion() : props.onPlayMotion())}>
          {props.motionState === 'playing' ? 'Stop' : 'Play'}
        </button>
        <button type="button" className="file-button" disabled={!props.hasMotion} onClick={props.onClearMotion}>Clear</button>
        <span className="live-toolbar-sep" />
        <button type="button" className="file-button" onClick={props.onMutate}>Mutate</button>
        <button type="button" className="file-button" disabled={!props.canUndo} onClick={props.onUndo}>Undo</button>
        <span className="live-toolbar-sep" />
        <button type="button" className="file-button" onClick={props.onSaveSession}>Save session</button>
        <button type="button" className="file-button" onClick={props.onLoadSession}>Load session</button>
        <span className="live-toolbar-sep" />
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
      </div>
    </div>
  )
}
