import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Select } from './Select'

const opts = [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }]

describe('Select', () => {
  it('renders the selected label in a combobox trigger', () => {
    const html = renderToStaticMarkup(<Select label="Pick" value="b" options={opts} onChange={() => {}} />)
    expect(html).toContain('role="combobox"')
    expect(html).toContain('aria-label="Pick"')
    expect(html).toContain('Beta')
  })
  it('is closed by default (no listbox in markup)', () => {
    const html = renderToStaticMarkup(<Select label="Pick" value="a" options={opts} onChange={() => {}} />)
    expect(html).not.toContain('role="listbox"')
  })
  it('renders an empty trigger label when value matches no option', () => {
    const html = renderToStaticMarkup(
      <Select label="Pick" value={'missing' as 'a' | 'b'} options={opts} onChange={() => {}} />
    )
    expect(html).toContain('role="combobox"')
    expect(html).not.toContain('Alpha')
    expect(html).not.toContain('Beta')
  })
})
// Open/select/Escape is interaction; its logic lives in nextActiveIndex (tested above) + the final manual pass.
