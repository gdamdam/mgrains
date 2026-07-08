import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ShatterSequencer } from './ShatterSequencer'
import { DEFAULT_PATCH } from '../audio/contracts'

const noop = () => {}

describe('ShatterSequencer step editor', () => {
  it('renders Position and Size sliders for the selected step', () => {
    const steps = DEFAULT_PATCH.shatterSteps.map((s) => ({ ...s, positionOffset: 0.2, sizeScale: 2 }))
    const html = renderToStaticMarkup(
      <ShatterSequencer steps={steps} currentStep={0} onChange={noop} />,
    )
    expect(html).toContain('Position')
    expect(html).toContain('Size')
    expect(html).toContain('+20%')   // positionOffset 0.2 rendered as +20%
    expect(html).toContain('×2.00')  // sizeScale 2 rendered as ×2.00
  })
})
