import { describe, expect, it } from 'vitest'
import {
  filterAudioInputs,
  filterAudioOutputs,
  isValidDeviceIdHint,
  resolvePreferredDevice,
  supportsOutputRouting,
  type DeviceOption,
} from './devices'

// Minimal MediaDeviceInfo stand-in: the pure filters only read kind/deviceId/label.
function device(
  kind: MediaDeviceKind,
  deviceId: string,
  label = '',
): MediaDeviceInfo {
  return { kind, deviceId, label, groupId: '', toJSON: () => ({}) } as MediaDeviceInfo
}

describe('supportsOutputRouting', () => {
  it('is true when setSinkId exists on the prototype', () => {
    expect(supportsOutputRouting({ setSinkId: () => {} })).toBe(true)
  })

  it('is false when setSinkId is absent', () => {
    expect(supportsOutputRouting({})).toBe(false)
  })

  it('is false for a null prototype (SSR / no AudioContext)', () => {
    expect(supportsOutputRouting(null)).toBe(false)
  })
})

describe('filterAudioInputs / filterAudioOutputs', () => {
  it('keeps only the matching kind', () => {
    const devices = [
      device('audioinput', 'mic-1', 'Built-in Mic'),
      device('audiooutput', 'spk-1', 'Built-in Speaker'),
      device('videoinput', 'cam-1', 'Webcam'),
    ]
    expect(filterAudioInputs(devices).map((o) => o.deviceId)).toEqual(['mic-1'])
    expect(filterAudioOutputs(devices).map((o) => o.deviceId)).toEqual(['spk-1'])
  })

  it('dedupes by deviceId', () => {
    const devices = [
      device('audioinput', 'mic-1', 'Mic'),
      device('audioinput', 'mic-1', 'Mic dup'),
    ]
    expect(filterAudioInputs(devices)).toHaveLength(1)
  })

  it('synthesizes a label when empty', () => {
    const [option] = filterAudioInputs([device('audioinput', 'abcdef123456')])
    expect(option.label).toBe('Microphone abcdef')
    expect(option.isDefault).toBe(false)
  })

  it('marks default deviceIds and labels them', () => {
    const options = filterAudioOutputs([
      device('audiooutput', ''),
      device('audiooutput', 'default'),
    ])
    expect(options.map((o) => o.isDefault)).toEqual([true, true])
    expect(options[0].label).toBe('Speaker (default)')
  })

  it('prefers a real label over the synthesized fallback', () => {
    const [option] = filterAudioOutputs([device('audiooutput', 'spk-1', 'Studio Monitors')])
    expect(option.label).toBe('Studio Monitors')
  })
})

describe('resolvePreferredDevice', () => {
  const available: DeviceOption[] = [
    { deviceId: 'mic-1', label: 'Mic 1', isDefault: false },
    { deviceId: 'mic-2', label: 'Mic 2', isDefault: false },
  ]

  it('returns the preferred id when still present', () => {
    expect(resolvePreferredDevice('mic-2', available)).toBe('mic-2')
  })

  it('returns null when the preferred id has vanished', () => {
    expect(resolvePreferredDevice('gone', available)).toBeNull()
  })

  it('returns null when there is no preference', () => {
    expect(resolvePreferredDevice(null, available)).toBeNull()
  })
})

describe('isValidDeviceIdHint', () => {
  it('accepts a non-empty string', () => {
    expect(isValidDeviceIdHint('mic-1')).toBe(true)
  })

  it('rejects empty string, null, and non-strings', () => {
    expect(isValidDeviceIdHint('')).toBe(false)
    expect(isValidDeviceIdHint(null)).toBe(false)
    expect(isValidDeviceIdHint(42)).toBe(false)
    expect(isValidDeviceIdHint(undefined)).toBe(false)
  })
})
