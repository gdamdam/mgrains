import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { StudioView } from './StudioView'
import { DEFAULT_PATCH } from '../../audio/contracts'
import { initialLinkState } from '../../transport/abletonLink'

const noop = () => {}
const studioProps = {
  patch: DEFAULT_PATCH,
  engineState: 'idle' as const,
  peak: 0,
  peaks: null,
  sourceLabel: 'Generated tone field',
  sourceMode: 'sample' as const,
  sourceId: 'harmonic-pad',
  frozen: false,
  liveBufferSeconds: 0,
  error: null,
  activeGrains: 0,
  grainVisuals: { count: 0, positions: new Float32Array(0), intensities: new Float32Array(0) },
  currentShatterStep: 0,
  macroValues: {},
  linkedMacros: {},
  presets: [],
  activeSceneId: '',
  presetName: '',
  linkEnabled: false,
  busEnabled: false,
  linkState: initialLinkState(),
  keysActive: false,
  canUndo: false,
  motionState: 'idle' as const,
  hasMotion: false,
  motionLaneCount: 0,
  liveInputPending: false,
  onToggleView: noop,
  onChangeMode: noop,
  onUpdatePatch: noop,
  onXYChange: noop,
  onShatterStepsChange: noop,
  onSetMacro: noop,
  onToggleMacroLink: noop,
  onResetAdvanced: noop,
  onMutate: noop,
  onUndo: noop,
  onToggleKeys: noop,
  onToggleLink: noop,
  onToggleBus: noop,
  onStartAudio: noop,
  onLoadFile: noop,
  onLiveInput: noop,
  onReturnToSample: noop,
  onSelectSource: noop,
  onToggleFreeze: noop,
  onClearLiveBuffer: noop,
  onWaveformPosition: noop,
  onRecordMotion: noop,
  onFinishRecording: noop,
  onPlayMotion: noop,
  onStopMotion: noop,
  onClearMotion: noop,
  onPresetNameChange: noop,
  onSavePreset: noop,
  onLoadPreset: noop,
  onLoadScene: noop,
  onDeletePreset: noop,
  onSaveSession: noop,
  onLoadSession: noop,
  gateToNotes: false,
  onToggleGate: noop,
}

describe('StudioView', () => {
  it('renders the full instrument: FX rack, advanced, presets, Live toggle', () => {
    const html = renderToStaticMarkup(<StudioView {...studioProps} />)
    expect(html).toContain('fx-bar')          // FX rack present
    expect(html).toContain('advanced-panel')  // advanced panel present
    expect(html).toContain('preset-controls') // presets present
    expect(html).toContain('Voice — Frozen Choir') // factory scenes listed
    expect(html).toContain('Load scene…')     // the Scene picker (no scene active)
    expect(html).toContain('Live')            // ◂ Live toggle
  })
})

describe('StudioView tempo lock', () => {
  it('disables the Tempo control and says so while Link drives the tempo', () => {
    const html = renderToStaticMarkup(<StudioView
      {...studioProps}
      patch={{ ...DEFAULT_PATCH, mode: 'shatter' }}
      linkEnabled
      linkState={{ ...initialLinkState(), connected: true, bpm: 120 }}
    />)
    expect(html).toContain('parameter-control--locked')
    expect(html).toContain('Tempo set by Link')
  })

  it('keeps the Tempo control editable when Link is not connected', () => {
    const html = renderToStaticMarkup(<StudioView
      {...studioProps}
      patch={{ ...DEFAULT_PATCH, mode: 'shatter' }}
    />)
    expect(html).not.toContain('parameter-control--locked')
    expect(html).not.toContain('Tempo set by Link')
  })
})

describe('motion lane indicator', () => {
  it('shows the lane count when a take exists', () => {
    const html = renderToStaticMarkup(<StudioView {...studioProps} hasMotion motionLaneCount={3} />)
    expect(html).toContain('3 lanes')
  })

  it('hides the indicator when there is no take', () => {
    const html = renderToStaticMarkup(<StudioView {...studioProps} motionLaneCount={0} />)
    expect(html).not.toContain('lanes')
  })
})

describe('StudioView shatter swing control', () => {
  it('renders a Swing control in the shatter clock row, never disabled', () => {
    const html = renderToStaticMarkup(<StudioView
      {...studioProps}
      patch={{ ...DEFAULT_PATCH, mode: 'shatter', shatterSwing: 0.3 }}
    />)
    expect(html).toContain('Swing')
    expect(html).toContain('30 %')   // 0.3 rendered as a 0-decimal percentage
  })

  it('keeps Swing editable even while Link locks the tempo', () => {
    const html = renderToStaticMarkup(<StudioView
      {...studioProps}
      patch={{ ...DEFAULT_PATCH, mode: 'shatter' }}
      linkEnabled
      linkState={{ ...initialLinkState(), connected: true, bpm: 120 }}
    />)
    // The only locked control is Tempo; Swing has no locked modifier.
    expect((html.match(/parameter-control--locked/g) ?? []).length).toBe(1)
  })
})
