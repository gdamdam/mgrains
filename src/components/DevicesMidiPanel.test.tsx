import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DevicesMidiPanel } from './DevicesMidiPanel'
import type { DeviceOption } from '../audio/devices'
import type { MidiMapping } from '../midi/midiMapping'

const noop = () => {}

const baseProps = {
  inputDevices: [] as DeviceOption[],
  outputDevices: [] as DeviceOption[],
  selectedInputId: '',
  selectedOutputId: '',
  outputSupported: true,
  deviceLabelsAvailable: true,
  onRequestDevicePermission: noop,
  onRefreshDevices: noop,
  onSelectInput: noop,
  onSelectOutput: noop,
  midiMappings: [] as MidiMapping[],
  midiLearnTarget: null as string | null,
  onStartMidiLearn: noop,
  onCancelMidiLearn: noop,
  onRemoveMidiMapping: noop,
}

describe('DevicesMidiPanel', () => {
  it('renders input + output selects when output routing is supported', () => {
    const html = renderToStaticMarkup(<DevicesMidiPanel {...baseProps} />)
    expect(html).toContain('Audio devices')
    expect(html).toContain('Input (microphone / interface)')
    expect(html).toContain('Output')
    expect(html).not.toContain('isn’t supported')
  })

  it('explains the system-settings fallback when output routing is unsupported', () => {
    const html = renderToStaticMarkup(<DevicesMidiPanel {...baseProps} outputSupported={false} />)
    expect(html).toContain('isn’t supported')
  })

  it('prompts to enable device names when labels are unavailable', () => {
    const html = renderToStaticMarkup(<DevicesMidiPanel {...baseProps} deviceLabelsAvailable={false} />)
    expect(html).toContain('Enable device names')
  })

  it('lists existing MIDI mappings with an accessible remove control', () => {
    const html = renderToStaticMarkup(
      <DevicesMidiPanel
        {...baseProps}
        midiMappings={[{ cc: 74, channel: 0, target: 'grainFilterHz' }]}
      />,
    )
    expect(html).toContain('CC 74')
    expect(html).toContain('channel 1')
    expect(html).toContain('aria-label="Remove MIDI mapping for')
  })

  it('announces the listening state while learning', () => {
    const html = renderToStaticMarkup(
      <DevicesMidiPanel {...baseProps} midiLearnTarget="grainFilterHz" />,
    )
    expect(html).toContain('Listening for a control change')
    expect(html).toContain('Cancel learn')
  })
})
