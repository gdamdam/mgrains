import { useState } from 'react'
import type { GrainPatch } from '../../audio/contracts'
import { FxBar, type FxBarItem } from './FxBar'
import { FxCurveSvg } from './FxCurveSvg'
import { FxModal } from './FxModal'
import { FxParamSlider } from './FxParamSlider'
import { fxCurvePoints } from './fxCurves'
import './fx.css'

interface FxParamDef {
  key: keyof GrainPatch
  label: string
  min: number
  max: number
  step?: number
  unit: string
  // 'pct' params are stored 0..1 but shown/edited as 0..100%; 'raw' pass through.
  kind: 'pct' | 'raw'
}

interface FxDef {
  id: string
  label: string
  amountKey: keyof GrainPatch
  params: FxParamDef[]
}

// Default amount applied when a player toggles an FX on from the bar.
const DEFAULT_ON = 0.4

// The eight effects, in signal-chain order. amountKey is the 0..1 wet amount;
// `params` are the effect's character controls shown in its modal.
const FX: FxDef[] = [
  { id: 'drive', label: 'Drive', amountKey: 'drive', params: [] },
  { id: 'crush', label: 'Crush', amountKey: 'crush', params: [] },
  { id: 'damp', label: 'Damp', amountKey: 'damp', params: [] },
  {
    id: 'tape',
    label: 'Tape',
    amountKey: 'tapeAmount',
    params: [{ key: 'tapeTone', label: 'Tone', min: 0, max: 1, unit: '%', kind: 'pct' }],
  },
  {
    id: 'ringmod',
    label: 'Ring',
    amountKey: 'ringModAmount',
    params: [{ key: 'ringModHz', label: 'Freq', min: 1, max: 4000, step: 1, unit: 'Hz', kind: 'raw' }],
  },
  {
    id: 'formant',
    label: 'Formant',
    amountKey: 'formantAmount',
    params: [{ key: 'formantVowel', label: 'Vowel', min: 0, max: 1, unit: '%', kind: 'pct' }],
  },
  {
    id: 'comb',
    label: 'Comb',
    amountKey: 'combAmount',
    params: [{ key: 'combFreq', label: 'Freq', min: 20, max: 4000, step: 1, unit: 'Hz', kind: 'raw' }],
  },
  {
    id: 'wow',
    label: 'Wow',
    amountKey: 'wowAmount',
    params: [{ key: 'wowRate', label: 'Rate', min: 0.1, max: 8, step: 0.1, unit: 'Hz', kind: 'raw' }],
  },
  {
    id: 'sub',
    label: 'Sub',
    amountKey: 'subAmount',
    params: [{ key: 'subTune', label: 'Tune', min: 30, max: 120, step: 1, unit: 'Hz', kind: 'raw' }],
  },
  { id: 'space', label: 'Space', amountKey: 'space', params: [] },
  { id: 'repeat', label: 'Repeat', amountKey: 'repeat', params: [] },
]

interface FxRackProps {
  patch: GrainPatch
  onChange: (changes: Partial<GrainPatch>) => void
}

// The performance FX rack: an FX bar of amount-ring tiles; tapping a tile opens
// its modal (params + an SVG of its character), the power dot toggles it on/off.
export function FxRack({ patch, onChange }: FxRackProps) {
  const [openId, setOpenId] = useState<string | null>(null)

  const amountOf = (key: keyof GrainPatch): number => patch[key] as number

  const items: FxBarItem[] = FX.map((fx) => ({
    id: fx.id,
    label: fx.label,
    amount: amountOf(fx.amountKey),
    enabled: amountOf(fx.amountKey) > 0,
  }))

  const toggle = (id: string) => {
    const fx = FX.find((entry) => entry.id === id)
    if (!fx) return
    onChange({ [fx.amountKey]: amountOf(fx.amountKey) > 0 ? 0 : DEFAULT_ON } as Partial<GrainPatch>)
  }

  const openFx = FX.find((fx) => fx.id === openId) ?? null

  return (
    <section className="fx-rack">
      <div className="panel-heading">
        <span>Effects</span>
        <span>tap to edit · power to toggle</span>
      </div>
      <FxBar items={items} onToggle={toggle} onOpen={setOpenId} />
      <FxModal
        title={openFx?.label ?? ''}
        open={openFx !== null}
        onClose={() => setOpenId(null)}
        viz={openFx
          ? <FxCurveSvg points={fxCurvePoints(openFx.id, patch)} label={`${openFx.label} response`} />
          : undefined}
      >
        {openFx && (
          <>
            <FxParamSlider
              label="Amount"
              value={Math.round(amountOf(openFx.amountKey) * 100)}
              min={0}
              max={100}
              step={1}
              unit="%"
              onChange={(value) => onChange({ [openFx.amountKey]: value / 100 } as Partial<GrainPatch>)}
            />
            {openFx.params.map((param) => (
              <FxParamSlider
                key={param.key as string}
                label={param.label}
                value={param.kind === 'pct' ? Math.round(amountOf(param.key) * 100) : amountOf(param.key)}
                min={param.kind === 'pct' ? 0 : param.min}
                max={param.kind === 'pct' ? 100 : param.max}
                step={param.kind === 'pct' ? 1 : (param.step ?? 1)}
                unit={param.unit}
                onChange={(value) =>
                  onChange({ [param.key]: param.kind === 'pct' ? value / 100 : value } as Partial<GrainPatch>)}
              />
            ))}
          </>
        )}
      </FxModal>
    </section>
  )
}
