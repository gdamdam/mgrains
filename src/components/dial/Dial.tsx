import { SLIDER_STEPS, fromSlider, toSlider } from './sliderMapping'
import { Ring } from './Ring'

interface DialProps {
  label: string
  value: number
  minimum: number
  maximum: number
  step?: number
  unit: string
  scale?: 'linear' | 'log'
  decimals?: number
  onChange: (value: number) => void
  variant?: 'ring' | 'readout'
  size?: number
  disabled?: boolean
  ariaLabel?: string
}

export function Dial({
  label, value, minimum, maximum, step, unit, scale = 'linear',
  decimals = 1, onChange, variant = 'ring', size = 52, disabled = false, ariaLabel,
}: DialProps) {
  const amount = toSlider(value, { minimum, maximum, scale }) / SLIDER_STEPS
  return (
    <label className={`dial dial--${variant}${disabled ? ' dial--disabled' : ''}`}>
      <span className="dial-visual">
        <Ring amount={amount} size={variant === 'readout' ? size * 1.2 : size} />
        <span className="dial-value" aria-hidden="true">
          {value.toFixed(decimals)}{unit && <span className="dial-unit">{unit}</span>}
        </span>
      </span>
      <span className="dial-label">{label}</span>
      <input
        className="dial-input sr-only"
        type="range"
        min={0}
        max={SLIDER_STEPS}
        value={toSlider(value, { minimum, maximum, scale })}
        aria-label={ariaLabel ?? label}
        aria-valuetext={`${value.toFixed(decimals)} ${unit}`.trim()}
        disabled={disabled}
        onChange={(event) => onChange(fromSlider(Number(event.currentTarget.value), { minimum, maximum, scale, step }))}
      />
    </label>
  )
}
