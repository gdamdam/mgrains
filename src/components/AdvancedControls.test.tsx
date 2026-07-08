import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AdvancedControls } from './AdvancedControls'
import { DEFAULT_PATCH } from '../audio/contracts'

const noop = () => {}

describe('AdvancedControls per-grain filter', () => {
  it('renders the Grain filter dial as "Off" at the default (dial max)', () => {
    const html = renderToStaticMarkup(
      <AdvancedControls patch={DEFAULT_PATCH} onChange={noop} onReset={noop} />,
    )
    expect(html).toContain('Grain filter')
    expect(html).toContain('Filter spread')
    expect(html).toContain('Off')            // sentinel label, not "8000 Hz"
    expect(html).not.toContain('8000')       // the number never leaks at Off
  })

  it('renders a numeric Hz value when the filter is engaged', () => {
    const html = renderToStaticMarkup(
      <AdvancedControls
        patch={{ ...DEFAULT_PATCH, grainFilterHz: 800, grainFilterSpread: 2 }}
        onChange={noop}
        onReset={noop}
      />,
    )
    expect(html).toContain('800')
    expect(html).toContain('Hz')
    expect(html).toContain('2.0')            // spread, 1 decimal, "oct" unit
    expect(html).toContain('oct')
  })
})
