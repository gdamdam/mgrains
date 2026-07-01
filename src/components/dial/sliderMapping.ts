export const SLIDER_STEPS = 1000

interface MapOpts {
  minimum: number
  maximum: number
  scale?: 'linear' | 'log'
}

export function toSlider(value: number, { minimum, maximum, scale = 'linear' }: MapOpts): number {
  const normalized = scale === 'log'
    ? Math.log(value / minimum) / Math.log(maximum / minimum)
    : (value - minimum) / (maximum - minimum)
  return Math.round(normalized * SLIDER_STEPS)
}

export function fromSlider(
  sliderValue: number,
  { minimum, maximum, scale = 'linear', step }: MapOpts & { step?: number },
): number {
  const ratio = sliderValue / SLIDER_STEPS
  const raw = scale === 'log'
    ? minimum * (maximum / minimum) ** ratio
    : minimum + (maximum - minimum) * ratio
  const snapped = step ? Math.round(raw / step) * step : raw
  return Math.min(maximum, Math.max(minimum, snapped))
}
