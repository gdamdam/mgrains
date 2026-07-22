// Pure MIDI CC-to-parameter mapping: parse, scale, match, learn, persist.
// No Web MIDI and no DOM — App does device I/O and localStorage; this module is
// all pure functions/reducers so the mapping logic is trivially testable.

import { PATCH_RANGES } from '../audio/contracts'
import { isRecord } from '../storage/presets'
import { MIDI_TARGET_BY_KEY, isMacroTarget } from './paramTargets'

// channel === null means "any channel" — the CC drives the target regardless of
// which channel it arrives on. A concrete 0..15 channel only matches that channel.
export type MidiMapping = { cc: number; channel: number | null; target: string }

// Ranges shape accepted by scaleCcToTarget. PATCH_RANGES satisfies this; the
// param exists so tests can inject their own ranges.
type RangeTable = Readonly<Record<string, readonly [number, number]>>

// Macros and any target without an explicit range travel over 0..1.
const UNIT_RANGE: readonly [number, number] = [0, 1]

/**
 * Parse a raw Control Change message. Returns null unless the status byte is a
 * CC (0xB0..0xBF); note/pitch-bend/other messages are rejected so callers can
 * feed any status safely. Data bytes are masked to 7 bits (0..127).
 */
export function parseControlChange(
  status: number,
  data1: number,
  data2: number,
): { channel: number; cc: number; value: number } | null {
  if ((status & 0xf0) !== 0xb0) return null
  return {
    channel: status & 0x0f,
    cc: data1 & 0x7f,
    value: data2 & 0x7f,
  }
}

// Resolve the [min,max] a target maps into: unit for macros / unknown keys,
// otherwise the PATCH_RANGES entry for that key.
function rangeFor(target: string, ranges: RangeTable): readonly [number, number] {
  if (isMacroTarget(target)) return UNIT_RANGE
  return ranges[target] ?? UNIT_RANGE
}

/**
 * Map a 0..127 CC value into the target parameter's range. Linear by default,
 * logarithmic when the target is flagged `log` (and its range is strictly
 * positive — log interpolation is undefined otherwise, so we fall back to
 * linear). The 0..127 input and the result are both clamped. Pure.
 */
export function scaleCcToTarget(
  value0to127: number,
  target: string,
  ranges: RangeTable = PATCH_RANGES,
): number {
  const [min, max] = rangeFor(target, ranges)
  const clamped = Number.isFinite(value0to127) ? value0to127 : 0
  const t = Math.min(1, Math.max(0, clamped / 127))

  const log = MIDI_TARGET_BY_KEY.get(target)?.log === true
  const value =
    log && min > 0 && max > 0
      ? min * Math.pow(max / min, t) // geometric interpolation
      : min + t * (max - min)

  return Math.min(max, Math.max(min, value))
}

// Two mappings' channels overlap when they can fire on the same channel: either
// is "any" (null), or they name the same concrete channel.
function channelsOverlap(a: number | null, b: number | null): boolean {
  return a === null || b === null || a === b
}

/**
 * Find the mapping for an incoming (channel, cc). An exact channel match wins
 * over an "any channel" (null) mapping so a per-channel override beats a global
 * one. Returns undefined when nothing matches — the caller then ignores the CC,
 * which is exactly how unmapped controls stay harmless.
 */
export function matchMapping(
  mappings: readonly MidiMapping[],
  channel: number,
  cc: number,
): MidiMapping | undefined {
  let anyMatch: MidiMapping | undefined
  for (const mapping of mappings) {
    if (mapping.cc !== cc) continue
    if (mapping.channel === channel) return mapping // exact channel wins immediately
    if (mapping.channel === null && anyMatch === undefined) anyMatch = mapping
  }
  return anyMatch
}

/**
 * Learn reducer: bind `pendingTarget` to the physical control that just moved.
 * Rule (documented so the UI is predictable): a target has at most one control
 * and a control drives at most one target, so we drop BOTH any existing mapping
 * for this target AND any existing mapping on an overlapping channel+cc, then
 * append the fresh mapping. Returns a new array; never mutates the input.
 */
export function applyLearn(
  mappings: readonly MidiMapping[],
  pendingTarget: string,
  control: { channel: number | null; cc: number },
): MidiMapping[] {
  const next = mappings.filter(
    (m) =>
      m.target !== pendingTarget &&
      !(m.cc === control.cc && channelsOverlap(m.channel, control.channel)),
  )
  next.push({ cc: control.cc, channel: control.channel, target: pendingTarget })
  return next
}

/**
 * Remove mapping(s). A number removes the entry at that index; a string removes
 * every mapping for that target. Returns a new array; unknown index/target is a
 * harmless no-op copy.
 */
export function removeMapping(
  mappings: readonly MidiMapping[],
  targetOrIndex: string | number,
): MidiMapping[] {
  if (typeof targetOrIndex === 'number') {
    return mappings.filter((_, index) => index !== targetOrIndex)
  }
  return mappings.filter((m) => m.target !== targetOrIndex)
}

// --- Persistence -----------------------------------------------------------
// App owns localStorage I/O; these turn mappings into/out of a JSON string.

export const MIDI_MAPPINGS_SCHEMA_VERSION = 1
export const MIDI_MAPPINGS_KEY = 'mgrains.midiMappings'

interface MidiMappingsEnvelope {
  schemaVersion: number
  mappings: MidiMapping[]
}

export function serializeMidiMappings(mappings: readonly MidiMapping[]): string {
  const envelope: MidiMappingsEnvelope = {
    schemaVersion: MIDI_MAPPINGS_SCHEMA_VERSION,
    mappings: mappings.map((m) => ({ cc: m.cc, channel: m.channel, target: m.target })),
  }
  return JSON.stringify(envelope)
}

// Accept one raw mapping entry only if every field is well-formed; otherwise
// return null so the caller can drop it. cc is 0..127, channel is null or 0..15,
// target is a non-empty string (we do NOT reject unknown target keys here so a
// mapping saved against a future/other build survives a round-trip).
function parseMapping(raw: unknown): MidiMapping | null {
  if (!isRecord(raw)) return null
  const { cc, channel, target } = raw
  if (typeof cc !== 'number' || !Number.isInteger(cc) || cc < 0 || cc > 127) return null
  const channelOk =
    channel === null ||
    (typeof channel === 'number' && Number.isInteger(channel) && channel >= 0 && channel <= 15)
  if (!channelOk) return null
  if (typeof target !== 'string' || target.length === 0) return null
  return { cc, channel: channel as number | null, target }
}

/**
 * Rebuild mappings from an unknown value (parsed JSON string or object). Never
 * throws: malformed entries are dropped individually and anything unrecognizable
 * yields []. Backward compatible with a bare legacy array (no envelope): future
 * schema bumps add migration branches keyed off `schemaVersion` here.
 */
export function deserializeMidiMappings(raw: unknown): MidiMapping[] {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return []
    }
  }

  // Legacy shape: a bare array of mappings with no envelope (pre-versioning).
  const list = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.mappings)
      ? value.mappings
      : []

  const parsed: MidiMapping[] = []
  for (const entry of list) {
    const mapping = parseMapping(entry)
    if (mapping) parsed.push(mapping)
  }
  return parsed
}
