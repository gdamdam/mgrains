interface FxCurveSvgProps {
  points: number[]
  label?: string
}

const VIEW_W = 400
const VIEW_H = 140

// Draws a static line + filled area from an array of y-values in 0..1, evenly
// spaced on x. Used for filter / reverb / response visualizations inside an
// FxModal. Static by design (no animation) so it is inherently
// prefers-reduced-motion safe. Colour comes from `currentColor` via the
// .fx-curve class, so callers tint it by setting `color` (the accent in the
// modal viz slot).
export function FxCurveSvg({ points, label }: FxCurveSvgProps) {
  // Map each y-value (0..1, 0 = bottom) to SVG coordinates. A single point
  // (or none) has no horizontal span, so fall back to a flat baseline rather
  // than dividing by zero.
  const span = Math.max(points.length - 1, 1)
  const clamp01 = (n: number) => Math.min(1, Math.max(0, n))
  const coords = points.map((y, i) => {
    const px = (i / span) * VIEW_W
    const py = VIEW_H - clamp01(y) * VIEW_H
    return [px, py] as const
  })

  const linePath = coords
    .map(([px, py], i) => `${i === 0 ? 'M' : 'L'} ${px.toFixed(2)} ${py.toFixed(2)}`)
    .join(' ')

  // Close the line down to the baseline and back for the soft area fill.
  const areaPath = coords.length
    ? `${linePath} L ${VIEW_W} ${VIEW_H} L 0 ${VIEW_H} Z`
    : ''

  return (
    <svg
      className="fx-curve"
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="none"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {areaPath ? <path className="fx-curve-area" d={areaPath} /> : null}
      {coords.length ? <path className="fx-curve-line" d={linePath} /> : null}
    </svg>
  )
}
