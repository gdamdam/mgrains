const FALLBACK_SEED = 0x9e3779b9

export class XorShift32 {
  private state: number

  constructor(seed: number) {
    this.state = XorShift32.normalizeSeed(seed)
  }

  reset(seed: number): void {
    this.state = XorShift32.normalizeSeed(seed)
  }

  nextUint(): number {
    let value = this.state
    value ^= value << 13
    value ^= value >>> 17
    value ^= value << 5
    this.state = value >>> 0
    return this.state
  }

  nextFloat(): number {
    return this.nextUint() / 0x1_0000_0000
  }

  nextBipolar(): number {
    return this.nextFloat() * 2 - 1
  }

  private static normalizeSeed(seed: number): number {
    const normalized = Number.isFinite(seed) ? seed >>> 0 : FALLBACK_SEED
    return normalized === 0 ? FALLBACK_SEED : normalized
  }
}
