import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Dial } from './Dial'

describe('Dial', () => {
  it('renders the value, unit, and an accessible range input', () => {
    const html = renderToStaticMarkup(
      <Dial label="Grain size" value={140} minimum={5} maximum={4000} unit="ms" scale="log" decimals={0} onChange={() => {}} />,
    )
    expect(html).toContain('type="range"')
    expect(html).toContain('aria-label="Grain size"')
    expect(html).toContain('aria-valuetext="140 ms"')
    expect(html).toContain('140')
  })

  it('readout variant renders the large-value class', () => {
    const html = renderToStaticMarkup(
      <Dial label="Density" value={14} minimum={0} maximum={80} unit="" variant="readout" onChange={() => {}} />,
    )
    expect(html).toContain('dial--readout')
    expect(html).toContain('aria-label="Density"')
  })
})
// Value-mapping behavior (linear/log/clamp/step) is covered by sliderMapping.test.ts (Task 2).
