interface FxParamSliderProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit: string
  onChange: (value: number) => void
}

// A labeled range input for use inside an FxModal. Standalone sibling of
// ParameterControl — same visual language (label / value+unit / full-width
// slider) but a plain linear range so it composes cleanly with the modal's
// SVG-driven param layout. Decimals follow the step so small steps read with
// enough precision and integer-ish steps read as whole numbers.
export function FxParamSlider({
  label,
  value,
  min,
  max,
  step = 0.01,
  unit,
  onChange,
}: FxParamSliderProps) {
  const decimals = step < 0.01 ? 3 : step < 1 ? 2 : 0
  const display = value.toFixed(decimals)
  return (
    <label className="fx-param-control">
      <span className="fx-param-label">{label}</span>
      <span className="fx-param-value">
        {display}
        {unit ? <span>{unit}</span> : null}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        aria-valuetext={`${display}${unit}`}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
    </label>
  )
}
