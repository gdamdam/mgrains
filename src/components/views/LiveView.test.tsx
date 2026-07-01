import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LiveView } from './LiveView'
import { DEFAULT_PATCH } from '../../audio/contracts'

const noop = () => {}
export const baseProps = {
  patch: DEFAULT_PATCH, engineState: 'running' as const, peak: 0, peaks: null,
  sourceLabel: 'Tone field', sourceMode: 'sample' as const, sourceId: 'harmonic-pad', frozen: false, liveBufferSeconds: 0,
  activeGrains: 0, grainVisuals: { count: 0, positions: new Float32Array(0), intensities: new Float32Array(0) },
  macroValues: {}, linkedMacros: {}, keysActive: false, linkEnabled: false,
  motionState: 'idle' as const, hasMotion: false, canUndo: false,
  onToggleView: noop, onChangeMode: noop, onUpdatePatch: noop, onXYChange: noop, onSetMacro: noop,
  onToggleMacroLink: noop, onToggleKeys: noop, onToggleLink: noop, onSelectSource: noop, onWaveformPosition: noop,
  onRecordMotion: noop, onFinishRecording: noop, onPlayMotion: noop, onStopMotion: noop, onClearMotion: noop,
  onMutate: noop, onUndo: noop,
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
})
