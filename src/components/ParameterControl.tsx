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

const SLIDER_STEPS = 1000

export function ParameterControl({
  label,
  value,
  minimum,
  maximum,
  step,
  unit,
  scale = 'linear',
  decimals = 1,
  onChange,
}: ParameterControlProps) {
  const normalized = scale === 'log'
    ? Math.log(value / minimum) / Math.log(maximum / minimum)
    : (value - minimum) / (maximum - minimum)

  const updateValue = (sliderValue: number) => {
    const ratio = sliderValue / SLIDER_STEPS
    const raw = scale === 'log'
      ? minimum * (maximum / minimum) ** ratio
      : minimum + (maximum - minimum) * ratio
    const snapped = step ? Math.round(raw / step) * step : raw
    onChange(Math.min(maximum, Math.max(minimum, snapped)))
  }

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
        value={Math.round(normalized * SLIDER_STEPS)}
        aria-label={label}
        aria-valuetext={`${value.toFixed(decimals)} ${unit}`}
        onChange={(event) => updateValue(Number(event.currentTarget.value))}
      />
    </label>
  )
}
