import type { DeviceOption } from '../audio/devices'
import type { MidiMapping } from '../midi/midiMapping'
import { MIDI_TARGETS, MIDI_TARGET_BY_KEY } from '../midi/paramTargets'

interface DevicesMidiPanelProps {
  // Audio devices
  inputDevices: DeviceOption[]
  outputDevices: DeviceOption[]
  selectedInputId: string
  selectedOutputId: string
  outputSupported: boolean
  deviceLabelsAvailable: boolean
  onRequestDevicePermission: () => void
  onRefreshDevices: () => void
  onSelectInput: (deviceId: string) => void
  onSelectOutput: (deviceId: string) => void
  // MIDI mapping / learn
  midiMappings: MidiMapping[]
  midiLearnTarget: string | null
  onStartMidiLearn: (target: string) => void
  onCancelMidiLearn: () => void
  onRemoveMidiMapping: (target: string) => void
}

const targetLabel = (key: string): string => MIDI_TARGET_BY_KEY.get(key)?.label ?? key

function describeMapping(mapping: MidiMapping): string {
  const channel = mapping.channel === null ? 'any channel' : `channel ${mapping.channel + 1}`
  return `CC ${mapping.cc} · ${channel}`
}

// Studio panel: pick audio input/output devices and manage MIDI CC mappings. All
// device enumeration, permission, and engine wiring lives in App; this is purely
// presentational + accessible. Native <select>/<button> keep it keyboard-friendly.
export function DevicesMidiPanel(props: DevicesMidiPanelProps) {
  const learning = props.midiLearnTarget !== null
  return (
    <>
      <section className="panel devices-panel" aria-labelledby="devices-heading">
        <div className="panel-heading">
          <span id="devices-heading">Audio devices</span>
          <button type="button" className="ghost-btn" onClick={props.onRefreshDevices}>
            Refresh
          </button>
        </div>

        <label className="device-field">
          <span className="device-field__label">Input (microphone / interface)</span>
          <select
            value={props.selectedInputId}
            onChange={(event) => props.onSelectInput(event.currentTarget.value)}
          >
            <option value="">System default</option>
            {props.inputDevices
              .filter((device) => !device.isDefault)
              .map((device) => (
                <option key={device.deviceId} value={device.deviceId}>{device.label}</option>
              ))}
          </select>
        </label>
        {!props.deviceLabelsAvailable && (
          <p className="device-note">
            Grant microphone access to see device names.{' '}
            <button type="button" className="ghost-btn" onClick={props.onRequestDevicePermission}>
              Enable device names
            </button>
          </p>
        )}

        {props.outputSupported ? (
          <label className="device-field">
            <span className="device-field__label">Output</span>
            <select
              value={props.selectedOutputId}
              onChange={(event) => props.onSelectOutput(event.currentTarget.value)}
            >
              <option value="">System default</option>
              {props.outputDevices
                .filter((device) => !device.isDefault)
                .map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>{device.label}</option>
                ))}
            </select>
          </label>
        ) : (
          <p className="device-note" role="note">
            Output device selection isn’t supported in this browser. Choose the output
            in your operating system or browser sound settings.
          </p>
        )}
      </section>

      <section className="panel midi-panel" aria-labelledby="midi-heading">
        <div className="panel-heading">
          <span id="midi-heading">MIDI mapping</span>
        </div>

        {props.midiMappings.length === 0 ? (
          <p className="device-note">No CC mappings yet. Choose a target and move a control to learn it.</p>
        ) : (
          <ul className="midi-mapping-list">
            {props.midiMappings.map((mapping) => (
              <li key={`${mapping.target}`} className="midi-mapping-row">
                <span className="midi-mapping-target">{targetLabel(mapping.target)}</span>
                <span className="midi-mapping-source">{describeMapping(mapping)}</span>
                <button
                  type="button"
                  className="ghost-btn"
                  aria-label={`Remove MIDI mapping for ${targetLabel(mapping.target)}`}
                  onClick={() => props.onRemoveMidiMapping(mapping.target)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="midi-learn" role="group" aria-label="MIDI learn">
          <label className="device-field">
            <span className="device-field__label">Learn target</span>
            <select
              value={props.midiLearnTarget ?? ''}
              disabled={learning}
              onChange={(event) => {
                const value = event.currentTarget.value
                if (value) props.onStartMidiLearn(value)
              }}
            >
              <option value="">Choose a parameter…</option>
              {MIDI_TARGETS.map((target) => (
                <option key={target.key} value={target.key}>{target.label}</option>
              ))}
            </select>
          </label>
          <p className="device-note" aria-live="polite">
            {learning
              ? `Listening for a control change to map to ${targetLabel(props.midiLearnTarget as string)}…`
              : 'Pick a parameter, then move a knob or fader on your controller.'}
          </p>
          {learning && (
            <button type="button" className="ghost-btn" onClick={props.onCancelMidiLearn}>
              Cancel learn
            </button>
          )}
        </div>
      </section>
    </>
  )
}
