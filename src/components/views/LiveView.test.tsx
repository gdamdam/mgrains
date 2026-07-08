import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LiveView } from './LiveView'
import { DEFAULT_PATCH } from '../../audio/contracts'

const noop = () => {}
export const baseProps = {
  patch: DEFAULT_PATCH, engineState: 'running' as const, peak: 0, peaks: null,
  sourceLabel: 'Tone field', sourceMode: 'sample' as const, sourceId: 'harmonic-pad', frozen: false, liveBufferSeconds: 0, error: null,
  activeGrains: 0, grainVisuals: { count: 0, positions: new Float32Array(0), intensities: new Float32Array(0) },
  macroValues: {}, linkedMacros: {}, keysActive: false, linkEnabled: false, busEnabled: false,
  motionState: 'idle' as const, hasMotion: false, motionLaneCount: 0, canUndo: false,
  onStartAudio: noop,
  onToggleView: noop, onChangeMode: noop, onUpdatePatch: noop, onXYChange: noop, onSetMacro: noop,
  onToggleMacroLink: noop, onToggleKeys: noop, onToggleLink: noop, onToggleBus: noop, onSelectSource: noop, onWaveformPosition: noop,
  onRecordMotion: noop, onFinishRecording: noop, onPlayMotion: noop, onStopMotion: noop, onClearMotion: noop,
  onMutate: noop, onUndo: noop, onSaveSession: noop, onLoadSession: noop,
  gateToNotes: false, onToggleGate: noop,
}

describe('LiveView', () => {
  it('shows the play surface (Studio toggle, XY pad, macros) and hides deep editors', () => {
    const html = renderToStaticMarkup(<LiveView {...baseProps} />)
    expect(html).toContain('Studio')             // Studio ▸ toggle text
    expect(html).toContain('xy-pad')              // XY pad rendered
    expect(html).toContain('macro')               // MacroControls rendered (.macro*)
    expect(html).not.toContain('fx-bar')          // no FX rack
    expect(html).not.toContain('advanced-panel')  // no advanced panel
    expect(html).not.toContain('preset-controls') // no presets
    expect(html).toContain('role="combobox"')     // the Source picker trigger
  })

  it('offers an immediate audio start action when the engine is idle', () => {
    const html = renderToStaticMarkup(<LiveView {...baseProps} engineState="idle" />)
    expect(html).toContain('Tap to start audio')
  })
})

describe('LiveView errors', () => {
  it('surfaces engine errors with an alert (parity with StudioView)', () => {
    const html = renderToStaticMarkup(<LiveView {...baseProps} error="Mic unavailable" />)
    expect(html).toContain('role="alert"')
    expect(html).toContain('Mic unavailable')
  })
})

describe('motion lane indicator', () => {
  it('shows the lane count when a take exists', () => {
    const html = renderToStaticMarkup(<LiveView {...baseProps} hasMotion motionLaneCount={3} />)
    expect(html).toContain('3 lanes')
  })

  it('hides the indicator when there is no take', () => {
    const html = renderToStaticMarkup(<LiveView {...baseProps} motionLaneCount={0} />)
    expect(html).not.toContain('lanes')
  })
})
