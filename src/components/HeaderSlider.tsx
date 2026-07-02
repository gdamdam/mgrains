import { useEffect, useRef, useState } from 'react'

interface HeaderSliderProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  format?: (value: number) => string
  onChange: (value: number) => void
}

// A compact header control: a trigger button showing label + current value that
// opens a popover slider. Modeled on Select's outside-click dismissal so it
// behaves consistently with the other header dropdowns.
export function HeaderSlider({ label, value, min, max, step = 0.01, format, onChange }: HeaderSliderProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDocDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocDown)
    return () => document.removeEventListener('mousedown', onDocDown)
  }, [open])

  const display = format ? format(value) : String(value)

  return (
    <div className="header-slider" ref={rootRef}>
      <button
        type="button"
        className="file-button header-slider-trigger"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{label}</span>
        <span className="header-slider-value">{display}</span>
        <span className="select-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="header-slider-pop" role="group" aria-label={label}>
          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            aria-label={label}
            onChange={(event) => onChange(Number(event.currentTarget.value))}
          />
          <span className="header-slider-readout">{display}</span>
        </div>
      )}
    </div>
  )
}
