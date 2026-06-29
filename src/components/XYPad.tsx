import type { PointerEvent as ReactPointerEvent } from 'react'
import type { GrainMode } from '../audio/contracts'

interface XYPadProps {
  mode: GrainMode
  x: number
  y: number
  onChange: (x: number, y: number) => void
}

export function XYPad({ mode, x, y, onChange }: XYPadProps) {
  const update = (event: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    onChange(
      Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
      Math.min(1, Math.max(0, 1 - (event.clientY - bounds.top) / bounds.height)),
    )
  }

  return (
    <div className={`xy-panel xy-panel--${mode}`}>
      <div className="panel-heading">
        <span>Performance field</span>
        <span>{mode === 'bloom' ? 'position × cloud' : 'position × scatter'}</span>
      </div>
      <div
        className="xy-pad"
        role="img"
        aria-label="Two-dimensional performance control. Position and Spray sliders provide keyboard alternatives."
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          update(event)
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) update(event)
        }}
      >
        <span className="xy-axis xy-axis--x">Position</span>
        <span className="xy-axis xy-axis--y">{mode === 'bloom' ? 'Cloud' : 'Scatter'}</span>
        <span
          className="xy-cursor"
          style={{ left: `${x * 100}%`, bottom: `${y * 100}%` }}
          aria-hidden="true"
        />
      </div>
    </div>
  )
}
