import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PATCH,
  PATCH_RANGES,
  sanitizePatch,
  type GrainPatch,
} from './contracts'
import { DEMO_SOURCES } from './demoSource'
import { FACTORY_SCENES, findScene, type FactoryScene } from './factoryScenes'

// Numeric fields that have an authoritative [min, max] tuple in PATCH_RANGES.
const RANGED_KEYS = Object.keys(PATCH_RANGES) as ReadonlyArray<
  keyof typeof PATCH_RANGES
>

const SOURCE_IDS = new Set(DEMO_SOURCES.map((source) => source.id))

// Loading a scene = overlay its partial patch on DEFAULT_PATCH, then sanitize —
// exactly what App.loadScene does, so this is the faithful "restored patch".
function applyScene(scene: FactoryScene): GrainPatch {
  return sanitizePatch({ ...DEFAULT_PATCH, ...scene.patch })
}

describe('FACTORY_SCENES', () => {
  it('ships between 12 and 16 scenes', () => {
    expect(FACTORY_SCENES.length).toBeGreaterThanOrEqual(12)
    expect(FACTORY_SCENES.length).toBeLessThanOrEqual(16)
  })

  it('gives every scene a unique id and a unique, non-empty name', () => {
    const ids = FACTORY_SCENES.map((scene) => scene.id)
    const names = FACTORY_SCENES.map((scene) => scene.name)
    for (const id of ids) expect(id.trim().length).toBeGreaterThan(0)
    for (const name of names) expect(name.trim().length).toBeGreaterThan(0)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(names).size).toBe(names.length)
  })

  it('gives every scene a non-empty description', () => {
    for (const scene of FACTORY_SCENES) {
      expect(scene.description.trim().length).toBeGreaterThan(0)
    }
  })

  it('binds every scene to a real generated source id', () => {
    for (const scene of FACTORY_SCENES) {
      expect(SOURCE_IDS.has(scene.sourceId)).toBe(true)
    }
  })

  it('reuses at least 3 sources across 2+ scenes (proves it is the engine, not the sample)', () => {
    const counts = new Map<string, number>()
    for (const scene of FACTORY_SCENES) {
      counts.set(scene.sourceId, (counts.get(scene.sourceId) ?? 0) + 1)
    }
    const reused = [...counts.values()].filter((count) => count >= 2)
    expect(reused.length).toBeGreaterThanOrEqual(3)
  })

  it('includes at least 3 bloom and at least 3 shatter scenes', () => {
    const blooms = FACTORY_SCENES.filter((scene) => scene.mode === 'bloom')
    const shatters = FACTORY_SCENES.filter((scene) => scene.mode === 'shatter')
    expect(blooms.length).toBeGreaterThanOrEqual(3)
    expect(shatters.length).toBeGreaterThanOrEqual(3)
  })

  it('declares scene.mode consistently with the patch override', () => {
    for (const scene of FACTORY_SCENES) {
      if (scene.patch.mode !== undefined) {
        expect(scene.patch.mode).toBe(scene.mode)
      }
    }
  })

  it('only references keys that exist on GrainPatch', () => {
    const validKeys = new Set(Object.keys(DEFAULT_PATCH))
    for (const scene of FACTORY_SCENES) {
      for (const key of Object.keys(scene.patch)) {
        expect(validKeys.has(key)).toBe(true)
      }
    }
  })

  it('produces a valid, fully-ranged patch with 16 shatter steps when applied', () => {
    for (const scene of FACTORY_SCENES) {
      const patch = applyScene(scene)
      expect(patch.shatterSteps).toHaveLength(16)
      for (const key of RANGED_KEYS) {
        const value = patch[key]
        const [min, max] = PATCH_RANGES[key]
        expect(Number.isFinite(value)).toBe(true)
        expect(value).toBeGreaterThanOrEqual(min)
        expect(value).toBeLessThanOrEqual(max)
      }
    }
  })

  it('round-trips its declared overrides through sanitize unchanged', () => {
    for (const scene of FACTORY_SCENES) {
      const patch = applyScene(scene)
      for (const key of Object.keys(scene.patch) as Array<keyof GrainPatch>) {
        expect(patch[key]).toEqual(scene.patch[key])
      }
    }
  })

  it('keeps every scene at a safe, unsurprising output level', () => {
    for (const scene of FACTORY_SCENES) {
      const patch = applyScene(scene)
      // Never louder than a touch above the default (0.72); heavy-FX scenes lower.
      expect(patch.outputGain).toBeLessThanOrEqual(0.74)
      expect(patch.outputGain).toBeGreaterThan(0)
      // No scene silently boosts the input gain.
      expect(patch.inputGain).toBeLessThanOrEqual(1.2)
    }
  })

  it('restores a scene identically every load (deterministic, DEFAULT-based)', () => {
    // App.loadScene always overlays on DEFAULT_PATCH, never the current patch, so
    // a scene load can never inherit stray fields from whatever was loaded before.
    for (const scene of FACTORY_SCENES) {
      expect(applyScene(scene)).toEqual(applyScene(scene))
    }
  })

  it('leaves untouched fields at their DEFAULT_PATCH value (no leakage across loads)', () => {
    for (const scene of FACTORY_SCENES) {
      const patch = applyScene(scene)
      const declared = new Set(Object.keys(scene.patch))
      for (const key of Object.keys(DEFAULT_PATCH) as Array<keyof GrainPatch>) {
        if (declared.has(key) || key === 'schemaVersion') continue
        expect(patch[key]).toEqual(DEFAULT_PATCH[key])
      }
    }
  })

  it('findScene resolves by id and rejects unknown ids', () => {
    expect(findScene(FACTORY_SCENES[0].id)).toBe(FACTORY_SCENES[0])
    expect(findScene('nope')).toBeUndefined()
    expect(findScene('')).toBeUndefined()
  })

  it('freezes the registry and every entry', () => {
    expect(Object.isFrozen(FACTORY_SCENES)).toBe(true)
    for (const scene of FACTORY_SCENES) {
      expect(Object.isFrozen(scene)).toBe(true)
    }
  })
})
