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
  /** Rendered instead of the numeric value when the dial sits at its maximum —
   *  for sentinel tops like the grain filter's "Off". */
  maxLabel?: string
  onChange: (value: number) => void
}

export function ParameterControl({
  label, value, minimum, maximum, step, unit, scale = 'linear', decimals = 1, disabled = false, maxLabel, onChange,
}: ParameterControlProps) {
  // Sentinel top (e.g. the grain filter's "Off"): the displayed value and the
  // aria value both switch to maxLabel, so share the one condition.
  const atMax = maxLabel !== undefined && value >= maximum
  return (
    <label className={`parameter-control${disabled ? ' parameter-control--locked' : ''}`}>
      <span className="parameter-label">{label}</span>
      <span className="parameter-value">
        {atMax
          ? maxLabel
          : <>{value.toFixed(decimals)} <span>{unit}</span></>}
      </span>
      <input
        type="range"
        min={0}
        max={SLIDER_STEPS}
        value={toSlider(value, { minimum, maximum, scale })}
        aria-label={label}
        aria-valuetext={atMax
          ? maxLabel
          : `${value.toFixed(decimals)} ${unit}`}
        disabled={disabled}
        onChange={(event) => onChange(fromSlider(Number(event.currentTarget.value), { minimum, maximum, scale, step }))}
      />
    </label>
  )
}
