import { useState } from 'react'
import type { ShatterStep } from '../audio/contracts'
import { Select } from './select/Select'

interface ShatterSequencerProps {
  steps: ShatterStep[]
  currentStep: number
  onChange: (steps: ShatterStep[]) => void
}

export function ShatterSequencer({ steps, currentStep, onChange }: ShatterSequencerProps) {
  const [selectedStep, setSelectedStep] = useState(0)
  const selected = steps[selectedStep]

  const updateStep = (index: number, changes: Partial<ShatterStep>) => {
    onChange(steps.map((step, stepIndex) => (
      stepIndex === index ? { ...step, ...changes } : step
    )))
  }

  return (
    <section className="shatter-sequencer" aria-label="Shatter sequence">
      <div className="panel-heading">
        <span>Fragment lane</span>
        <span>16 deterministic steps</span>
      </div>
      <div className="step-lane" role="group" aria-label="Shatter step gates">
        {steps.map((step, index) => {
          const detail = [
            step.pitchOffsetSemitones !== 0 ? `${step.pitchOffsetSemitones > 0 ? '+' : ''}${step.pitchOffsetSemitones}` : '',
            step.reverse ? 'R' : '',
            step.ratchet > 1 ? `×${step.ratchet}` : '',
          ].filter(Boolean).join(' ')
          return (
            <button
              type="button"
              key={index}
              className={[
                'step-button',
                step.enabled ? 'is-enabled' : '',
                currentStep === index ? 'is-current' : '',
                selectedStep === index ? 'is-selected' : '',
              ].filter(Boolean).join(' ')}
              aria-pressed={step.enabled}
              aria-label={`Step ${index + 1}, ${step.enabled ? 'on' : 'off'}, ${Math.round(step.probability * 100)} percent probability, pitch ${step.pitchOffsetSemitones} semitones, ${step.reverse ? 'reverse' : 'forward'}, ratchet ${step.ratchet}`}
              onClick={() => {
                setSelectedStep(index)
                updateStep(index, { enabled: !step.enabled })
              }}
            >
              <span>{String(index + 1).padStart(2, '0')}</span>
              <small>{detail || '·'}</small>
            </button>
          )
        })}
      </div>

      <div className="step-editor">
        <div className="step-editor-title">
          <span>Step {String(selectedStep + 1).padStart(2, '0')}</span>
          <button
            type="button"
            className={selected.enabled ? 'is-active' : ''}
            aria-pressed={selected.enabled}
            onClick={() => updateStep(selectedStep, { enabled: !selected.enabled })}
          >
            {selected.enabled ? 'Gate on' : 'Gate off'}
          </button>
        </div>

        <label>
          <span>Probability</span>
          <strong>{Math.round(selected.probability * 100)}%</strong>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(selected.probability * 100)}
            onChange={(event) => updateStep(selectedStep, {
              probability: Number(event.currentTarget.value) / 100,
            })}
          />
        </label>

        <label>
          <span>Pitch</span>
          <strong>{selected.pitchOffsetSemitones > 0 ? '+' : ''}{selected.pitchOffsetSemitones} st</strong>
          <input
            type="range"
            min={-24}
            max={24}
            step={1}
            value={selected.pitchOffsetSemitones}
            onChange={(event) => updateStep(selectedStep, {
              pitchOffsetSemitones: Number(event.currentTarget.value),
            })}
          />
        </label>

        <Select
          label="Ratchet"
          value={String(selected.ratchet)}
          options={[1, 2, 3, 4].map((n) => ({ value: String(n), label: `×${n}` }))}
          onChange={(v) => updateStep(selectedStep, {
            ratchet: Number(v) as ShatterStep['ratchet'],
          })}
        />

        <label className="reverse-control">
          <input
            type="checkbox"
            checked={selected.reverse}
            onChange={(event) => updateStep(selectedStep, { reverse: event.currentTarget.checked })}
          />
          <span>Reverse</span>
        </label>
      </div>
    </section>
  )
}
