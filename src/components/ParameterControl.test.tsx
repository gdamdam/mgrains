import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ParameterControl } from './ParameterControl'

const noop = () => {}

describe('ParameterControl maxLabel', () => {
  it('renders maxLabel instead of the numeric value when value is at maximum', () => {
    const html = renderToStaticMarkup(
      <ParameterControl label="Grain filter" value={8000} minimum={200} maximum={8000} unit="Hz" maxLabel="Off" onChange={noop} />,
    )
    expect(html).toContain('Off')
    expect(html).not.toContain('8000.0')
    expect(html).toContain('aria-valuetext="Off"')
  })

  it('renders the numeric value + unit when value is below maximum, even with maxLabel set', () => {
    const html = renderToStaticMarkup(
      <ParameterControl label="Grain filter" value={800} minimum={200} maximum={8000} unit="Hz" decimals={0} maxLabel="Off" onChange={noop} />,
    )
    expect(html).toContain('800')
    expect(html).toContain('Hz')
    expect(html).not.toContain('Off')
  })

  it('without maxLabel, behaves exactly as before (no regression)', () => {
    const html = renderToStaticMarkup(
      <ParameterControl label="Tempo" value={120} minimum={60} maximum={200} unit="bpm" decimals={0} onChange={noop} />,
    )
    expect(html).toContain('120')
    expect(html).toContain('bpm')
    expect(html).toContain('aria-valuetext="120 bpm"')
  })
})
