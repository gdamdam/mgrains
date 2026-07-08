import { SLIDER_STEPS, fromSlider, toSlider } from './dial/sliderMapping'

interface ParameterControlProps {
  label: string
  value: number
  minimum: number
  maximum: number
  step?: number
  unit: string
  scale?: 'linear' | 'log'
  decimals?: number
  /** Locks the control (e.g. tempo while Ableton Link drives it). */
  disabled?: boolean
  onChange: (value: number) => void
}

export function ParameterControl({
  label, value, minimum, maximum, step, unit, scale = 'linear', decimals = 1, disabled = false, onChange,
}: ParameterControlProps) {
  return (
    <label className={`parameter-control${disabled ? ' parameter-control--locked' : ''}`}>
      <span className="parameter-label">{label}</span>
      <span className="parameter-value">
        {value.toFixed(decimals)} <span>{unit}</span>
      </span>
      <input
        type="range"
        min={0}
        max={SLIDER_STEPS}
        value={toSlider(value, { minimum, maximum, scale })}
        aria-label={label}
        aria-valuetext={`${value.toFixed(decimals)} ${unit}`}
        disabled={disabled}
        onChange={(event) => onChange(fromSlider(Number(event.currentTarget.value), { minimum, maximum, scale, step }))}
      />
    </label>
  )
}
