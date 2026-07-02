import {
  LFO_RANGES,
  SHATTER_DIVISIONS,
  type GrainPatch,
  type LfoConfig,
  type LfoShape,
  type LfoSync,
  type LfoTarget,
  type ShatterDivision,
} from '../audio/contracts'
import { ParameterControl } from './ParameterControl'
import { Select } from './select/Select'

const SHAPE_OPTIONS: ReadonlyArray<{ value: LfoShape; label: string }> = [
  { value: 'sine', label: 'Sine' },
  { value: 'tri', label: 'Triangle' },
  { value: 'saw', label: 'Saw' },
  { value: 'sh', label: 'Sample & hold' },
  { value: 'drift', label: 'Drift' },
]

const TARGET_OPTIONS: ReadonlyArray<{ value: LfoTarget; label: string }> = [
  { value: 'none', label: 'Off' },
  { value: 'position', label: 'Position' },
  { value: 'grainSizeMs', label: 'Grain size' },
  { value: 'densityHz', label: 'Density' },
  { value: 'spray', label: 'Spray' },
  { value: 'pitchSpreadSemitones', label: 'Pitch spread' },
]

const SYNC_OPTIONS: ReadonlyArray<{ value: LfoSync; label: string }> = [
  { value: 'free', label: 'Free (Hz)' },
  { value: 'link', label: 'Tempo' },
]

interface LfoControlsProps {
  patch: GrainPatch
  onChange: (changes: Partial<GrainPatch>) => void
}

// Two assignable LFOs. Each drives one continuous parameter so a patch can
// evolve on its own; a target of "Off" (or zero depth) leaves the engine
// untouched, so existing presets are unaffected.
export function LfoControls({ patch, onChange }: LfoControlsProps) {
  const update = (index: number, changes: Partial<LfoConfig>) => {
    onChange({ lfos: patch.lfos.map((lfo, i) => (i === index ? { ...lfo, ...changes } : lfo)) })
  }

  return (
    <div className="lfo-panel">
      <div className="panel-heading">
        <span>Modulation</span>
        <span>2 assignable LFOs</span>
      </div>
      {patch.lfos.map((lfo, index) => (
        <div className="parameter-grid" key={`lfo-${index}`}>
          <Select
            label={`LFO ${index + 1} target`}
            value={lfo.target}
            options={TARGET_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            onChange={(target) => update(index, { target })}
          />
          <Select
            label="Shape"
            value={lfo.shape}
            options={SHAPE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            onChange={(shape) => update(index, { shape })}
          />
          <Select
            label="Sync"
            value={lfo.sync}
            options={SYNC_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            onChange={(sync) => update(index, { sync })}
          />
          {lfo.sync === 'link' ? (
            <Select
              label="Rate"
              value={lfo.division}
              options={SHATTER_DIVISIONS.map((d) => ({ value: d, label: d }))}
              onChange={(division: ShatterDivision) => update(index, { division })}
            />
          ) : (
            <ParameterControl
              label="Rate"
              value={lfo.rateHz}
              minimum={LFO_RANGES.rateHz[0]}
              maximum={LFO_RANGES.rateHz[1]}
              step={0.01}
              unit="Hz"
              decimals={2}
              onChange={(rateHz) => update(index, { rateHz })}
            />
          )}
          <ParameterControl
            label="Depth"
            value={lfo.depth * 100}
            minimum={0}
            maximum={100}
            step={1}
            unit="%"
            decimals={0}
            onChange={(value) => update(index, { depth: value / 100 })}
          />
          <Select
            label="Mode"
            value={lfo.bipolar ? 'bi' : 'uni'}
            options={[{ value: 'bi', label: 'Bipolar' }, { value: 'uni', label: 'Unipolar' }]}
            onChange={(value) => update(index, { bipolar: value === 'bi' })}
          />
        </div>
      ))}
    </div>
  )
}
