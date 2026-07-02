import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { StudioView } from './StudioView'
import { DEFAULT_PATCH } from '../../audio/contracts'
import { FACTORY_PRESETS } from '../../audio/factoryPresets'
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
  factory: FACTORY_PRESETS,
  presetName: '',
  linkEnabled: false,
  linkState: initialLinkState(),
  keysActive: false,
  canUndo: false,
  motionState: 'idle' as const,
  hasMotion: false,
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
  onLoadFactoryPreset: noop,
  onDeletePreset: noop,
  onSaveSession: noop,
  onLoadSession: noop,
}

describe('StudioView', () => {
  it('renders the full instrument: FX rack, advanced, presets, Live toggle', () => {
    const html = renderToStaticMarkup(<StudioView {...studioProps} />)
    expect(html).toContain('fx-bar')          // FX rack present
    expect(html).toContain('advanced-panel')  // advanced panel present
    expect(html).toContain('preset-controls') // presets present
    expect(html).toContain('Live')            // ◂ Live toggle
  })
})
