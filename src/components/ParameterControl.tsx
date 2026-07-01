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
  onChange: (value: number) => void
}

export function ParameterControl({
  label, value, minimum, maximum, step, unit, scale = 'linear', decimals = 1, onChange,
}: ParameterControlProps) {
  return (
    <label className="parameter-control">
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
        onChange={(event) => onChange(fromSlider(Number(event.currentTarget.value), { minimum, maximum, scale, step }))}
      />
    </label>
  )
}
