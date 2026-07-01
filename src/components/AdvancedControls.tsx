import { PATCH_RANGES, type GrainPatch, type GrainWindow } from '../audio/contracts'
import { ParameterControl } from './ParameterControl'
import { Select } from './select/Select'

const WINDOW_OPTIONS: ReadonlyArray<{ value: GrainWindow; label: string }> = [
  { value: 'hann', label: 'Smooth (Hann)' },
  { value: 'percussive', label: 'Percussive' },
  { value: 'hard', label: 'Hard / rectangular' },
  { value: 'reverse', label: 'Reverse / rising' },
]

interface AdvancedControlsProps {
  patch: GrainPatch
  onChange: (changes: Partial<GrainPatch>) => void
  onReset: () => void
}

// The precise, less-frequent grain parameters. Collapsed by default so the main
// surface stays simple, but every value here remains directly editable with a
// stable label, unit, and a single "reset to defaults" escape hatch.
export function AdvancedControls({ patch, onChange, onReset }: AdvancedControlsProps) {
  return (
    <details className="advanced-panel">
      <summary>
        <span className="advanced-summary-title">Advanced controls</span>
        <span>precise · less frequent</span>
      </summary>
      <div className="advanced-body">
        <div className="parameter-grid">
          <ParameterControl
            label="Region start"
            value={patch.regionStart * 100}
            minimum={0}
            maximum={100}
            unit="%"
            decimals={0}
            onChange={(value) => onChange({ regionStart: value / 100 })}
          />
          <ParameterControl
            label="Region end"
            value={patch.regionEnd * 100}
            minimum={0}
            maximum={100}
            unit="%"
            decimals={0}
            onChange={(value) => onChange({ regionEnd: value / 100 })}
          />
          <ParameterControl
            label="Timing jitter"
            value={patch.timingJitter * 100}
            minimum={0}
            maximum={100}
            unit="%"
            decimals={0}
            onChange={(value) => onChange({ timingJitter: value / 100 })}
          />
          <ParameterControl
            label="Scan speed"
            value={patch.scanSpeed}
            minimum={PATCH_RANGES.scanSpeed[0]}
            maximum={PATCH_RANGES.scanSpeed[1]}
            step={0.01}
            unit="x"
            decimals={2}
            onChange={(scanSpeed) => onChange({ scanSpeed })}
          />
          <ParameterControl
            label="Pitch"
            value={patch.pitchSemitones}
            minimum={PATCH_RANGES.pitchSemitones[0]}
            maximum={PATCH_RANGES.pitchSemitones[1]}
            step={1}
            unit="st"
            decimals={0}
            onChange={(pitchSemitones) => onChange({ pitchSemitones })}
          />
          <ParameterControl
            label="Pitch spread"
            value={patch.pitchSpreadSemitones}
            minimum={PATCH_RANGES.pitchSpreadSemitones[0]}
            maximum={PATCH_RANGES.pitchSpreadSemitones[1]}
            step={0.1}
            unit="st"
            decimals={1}
            onChange={(pitchSpreadSemitones) => onChange({ pitchSpreadSemitones })}
          />
          <ParameterControl
            label="Reverse prob"
            value={patch.reverseProbability * 100}
            minimum={0}
            maximum={100}
            unit="%"
            decimals={0}
            onChange={(value) => onChange({ reverseProbability: value / 100 })}
          />
          <ParameterControl
            label="Stereo spread"
            value={patch.stereoSpread * 100}
            minimum={0}
            maximum={100}
            unit="%"
            decimals={0}
            onChange={(value) => onChange({ stereoSpread: value / 100 })}
          />
          <ParameterControl
            label="Output"
            value={patch.outputGain * 100}
            minimum={0}
            maximum={100}
            unit="%"
            decimals={0}
            onChange={(value) => onChange({ outputGain: value / 100 })}
          />
          <Select
            label="Grain window"
            value={patch.window}
            options={WINDOW_OPTIONS.map((w) => ({ value: w.value, label: w.label }))}
            onChange={(window) => onChange({ window })}
          />
        </div>
        <button type="button" className="advanced-reset" onClick={onReset}>
          Reset advanced
        </button>
      </div>
    </details>
  )
}
