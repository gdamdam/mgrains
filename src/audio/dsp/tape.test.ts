import { describe, expect, it } from 'vitest'
import { Tape, type TapeParams } from './tape'

const SR = 48000

// Sum of squared successive-sample differences — a cheap proxy for
// high-frequency energy. A brighter signal changes faster sample to
// sample, so this rises with HF content.
function diffEnergy(samples: number[]): number {
  let energy = 0
  for (let i = 1; i < samples.length; i += 1) {
    const d = samples[i] - samples[i - 1]
    energy += d * d
  }
  return energy
}

// Render a mono signal through one channel of the Tape and return the
// left-channel output series.
function renderLeft(tape: Tape, input: number[]): number[] {
  const out: number[] = []
  for (const x of input) {
    out.push(tape.process(x, x)[0])
  }
  return out
}

// A noisy/bright test signal: alternating-ish content with HF energy.
function brightSignal(n: number): number[] {
  const s: number[] = []
  for (let i = 0; i < n; i += 1) {
    // Mix a low tone with an aggressive high tone near Nyquist.
    s.push(0.4 * Math.sin((i * 2 * Math.PI * 200) / SR) + 0.4 * Math.sin((i * Math.PI) / 1.5))
  }
  return s
}

describe('Tape', () => {
  it('produces bounded, finite output for all param combinations', () => {
    const inputs = [-10, -1, -0.5, 0, 0.3, 1, 5, 10]
    for (const drive of [0, 0.25, 0.5, 0.75, 1]) {
      for (const tone of [0, 0.25, 0.5, 0.75, 1]) {
        const tape = new Tape(SR)
        tape.setParams({ drive, tone })
        for (const x of inputs) {
          const [l, r] = tape.process(x, x)
          expect(Number.isFinite(l)).toBe(true)
          expect(Number.isFinite(r)).toBe(true)
          expect(Math.abs(l)).toBeLessThanOrEqual(1.0001)
          expect(Math.abs(r)).toBeLessThanOrEqual(1.0001)
        }
      }
    }
  })

  it('is near unity for a small input at drive 0', () => {
    const tape = new Tape(SR)
    // tone 1 = brightest/most open so the tilt filter barely attenuates;
    // lets us assert near-transparency on a steady small DC-ish input.
    tape.setParams({ drive: 0, tone: 1 })
    let l = 0
    // Let the tilt filter settle on a small steady input.
    for (let i = 0; i < 4000; i += 1) {
      l = tape.process(0.01, 0.01)[0]
    }
    expect(l).toBeCloseTo(0.01, 3)
  })

  it('compresses a large input more as drive increases', () => {
    const input = 0.9
    const settle = (drive: number): number => {
      const tape = new Tape(SR)
      tape.setParams({ drive, tone: 1 })
      let l = 0
      for (let i = 0; i < 4000; i += 1) {
        l = tape.process(input, input)[0]
      }
      return l
    }
    // More drive => output sits closer to the ceiling => less headroom.
    const lowHeadroom = 1 - settle(0.1)
    const highHeadroom = 1 - settle(1)
    expect(highHeadroom).toBeLessThan(lowHeadroom)
  })

  it('tone changes high-frequency content (darker at 0 than at 1)', () => {
    const input = brightSignal(2048)

    const darkTape = new Tape(SR)
    darkTape.setParams({ drive: 0, tone: 0 })
    const dark = renderLeft(darkTape, input)

    const brightTape = new Tape(SR)
    brightTape.setParams({ drive: 0, tone: 1 })
    const bright = renderLeft(brightTape, input)

    // tone 0 is darker (more low-pass), so it should retain less
    // successive-sample (high-frequency) energy than tone 1.
    expect(diffEnergy(dark)).toBeLessThan(diffEnergy(bright))
  })

  it('keeps stereo channels independent (left input does not leak to right)', () => {
    const tape = new Tape(SR)
    tape.setParams({ drive: 0.5, tone: 0 })
    const [, r] = tape.process(0.8, 0)
    // A right input of 0 (after the filter settles from rest) should stay
    // small — independent per-channel filter state means no cross-bleed.
    expect(Math.abs(r)).toBeLessThan(0.2)
  })

  it('reset() clears filter state for reproducible output', () => {
    const params: TapeParams = { drive: 0.6, tone: 0.2 }
    const tape = new Tape(SR)
    tape.setParams(params)

    const input = brightSignal(256)
    const first = renderLeft(tape, input)

    tape.reset()
    const second = renderLeft(tape, input)

    expect(second).toEqual(first)
  })

  it('is deterministic across instances for identical input', () => {
    const params: TapeParams = { drive: 0.7, tone: 0.4 }
    const a = new Tape(SR)
    a.setParams(params)
    const b = new Tape(SR)
    b.setParams(params)

    const input = brightSignal(256)
    expect(renderLeft(b, input)).toEqual(renderLeft(a, input))
  })

  it('clamps out-of-range params without throwing', () => {
    const tape = new Tape(SR)
    expect(() => tape.setParams({ drive: -5, tone: 99 })).not.toThrow()
    const [l, r] = tape.process(0.5, 0.5)
    expect(Number.isFinite(l)).toBe(true)
    expect(Number.isFinite(r)).toBe(true)
  })

  it('processInto writes into the provided buffer', () => {
    const tape = new Tape(SR)
    tape.setParams({ drive: 0.5, tone: 0.5 })
    const out = new Float64Array(2)
    tape.processInto(0.3, -0.3, out)
    expect(Number.isFinite(out[0])).toBe(true)
    expect(Number.isFinite(out[1])).toBe(true)
  })
})
