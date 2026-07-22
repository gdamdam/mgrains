// Pure, dependency-injected helpers for audio device enumeration and selection.
// Nothing here touches navigator or AudioContext directly: capabilities are
// passed in so the logic is unit-testable in a node/vitest env with no DOM.
// The AudioEngine and App wire these to the real Web APIs.

export type DeviceOption = {
  deviceId: string
  label: string
  isDefault: boolean
}

// localStorage keys for the persisted selections. These are best-effort HINTS
// only: browsers rotate deviceIds across sessions/permission states, so a stored
// id may no longer resolve — resolvePreferredDevice() handles a vanished pick.
// App owns the actual localStorage read/write.
export const MIC_DEVICE_HINT_KEY = 'mgrains.inputDeviceId'
export const OUTPUT_DEVICE_HINT_KEY = 'mgrains.outputDeviceId'

// Output routing (choosing a speaker) rides on setSinkId. It exists on
// HTMLMediaElement broadly but on AudioContext it is Chromium-only; Safari and
// Firefox lack it entirely. Caller passes AudioContext.prototype (or null when
// AudioContext is undefined, e.g. SSR) so this stays free of global access.
export function supportsOutputRouting(audioContextProto: object | null): boolean {
  if (!audioContextProto) return false
  return 'setSinkId' in audioContextProto
}

// A blank or 'default' deviceId denotes the system default device.
function isDefaultId(deviceId: string): boolean {
  return deviceId === '' || deviceId === 'default'
}

// The tail of a deviceId is long and opaque; a short slice is enough to
// disambiguate synthesized labels for unlabeled devices (labels are empty until
// mic permission is granted).
function shortId(deviceId: string): string {
  return deviceId.slice(0, 6)
}

function filterByKind(
  devices: MediaDeviceInfo[],
  kind: MediaDeviceKind,
  defaultLabel: string,
): DeviceOption[] {
  const seen = new Set<string>()
  const options: DeviceOption[] = []
  for (const device of devices) {
    if (device.kind !== kind) continue
    if (seen.has(device.deviceId)) continue
    seen.add(device.deviceId)
    const isDefault = isDefaultId(device.deviceId)
    const label = device.label
      ? device.label
      : isDefault
        ? `${defaultLabel} (default)`
        : `${defaultLabel} ${shortId(device.deviceId)}`
    options.push({ deviceId: device.deviceId, label, isDefault })
  }
  return options
}

export function filterAudioInputs(devices: MediaDeviceInfo[]): DeviceOption[] {
  return filterByKind(devices, 'audioinput', 'Microphone')
}

export function filterAudioOutputs(devices: MediaDeviceInfo[]): DeviceOption[] {
  return filterByKind(devices, 'audiooutput', 'Speaker')
}

// Returns preferredId only if it is still among the currently available devices;
// otherwise null so the caller falls back to the system default. This is how a
// selection that has vanished (device unplugged, id rotated) degrades cleanly.
export function resolvePreferredDevice(
  preferredId: string | null,
  available: DeviceOption[],
): string | null {
  if (!preferredId) return null
  return available.some((option) => option.deviceId === preferredId) ? preferredId : null
}

// Guards a persisted hint read back from localStorage (unknown JSON shape).
export function isValidDeviceIdHint(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0
}
