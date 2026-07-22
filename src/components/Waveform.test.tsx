import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Waveform } from './Waveform'

const noop = () => {}

const baseProps = {
  mode: 'bloom' as const,
  position: 0.5,
  regionStart: 0.25,
  regionEnd: 0.75,
  activeGrains: 3,
  visualGrainCount: 2,
  grainPositions: new Float32Array([0.3, 0.6]),
  grainIntensities: new Float32Array([0.5, 0.8]),
  onPositionChange: noop,
}

describe('Waveform', () => {
  it('renders region handles and zoom/pan controls with ARIA labels', () => {
    const html = renderToStaticMarkup(
      <Waveform {...baseProps} peaks={new Float32Array([0.1, 0.4, 0.2, 0.6])} onRegionChange={noop} />,
    )
    expect(html).toContain('region-handle--start')
    expect(html).toContain('region-handle--end')
    expect(html).toContain('aria-label="Zoom in"')
    expect(html).toContain('aria-label="Zoom out"')
    expect(html).toContain('aria-label="Pan left"')
    expect(html).toContain('aria-label="Pan right"')
    expect(html).toContain('aria-label="Region start"')
    expect(html).toContain('aria-label="Region end"')
  })

  it('exposes slider-like ARIA on the region range inputs', () => {
    const html = renderToStaticMarkup(
      <Waveform {...baseProps} peaks={new Float32Array([0.1, 0.4])} onRegionChange={noop} />,
    )
    expect(html).toContain('aria-valuetext="25%"')
    expect(html).toContain('aria-valuetext="75%"')
  })

  it('renders an sr-only instructions line', () => {
    const html = renderToStaticMarkup(
      <Waveform {...baseProps} peaks={new Float32Array([0.1, 0.4])} onRegionChange={noop} />,
    )
    expect(html).toContain('sr-only')
    expect(html).toContain('keyboard-accessible')
  })

  it('does not crash and shows the empty label with null peaks', () => {
    const html = renderToStaticMarkup(
      <Waveform {...baseProps} peaks={null} emptyLabel="Choose a source" onRegionChange={noop} />,
    )
    expect(html).toContain('Choose a source')
    expect(html).toContain('waveform-empty')
  })

  it('omits region editing controls when onRegionChange is not provided', () => {
    const html = renderToStaticMarkup(
      <Waveform {...baseProps} peaks={new Float32Array([0.1, 0.4])} />,
    )
    // Zoom stays available; region trimming is gated on the callback.
    expect(html).toContain('aria-label="Zoom in"')
    expect(html).not.toContain('aria-label="Region start"')
  })
})
