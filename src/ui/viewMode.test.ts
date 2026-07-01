import { beforeEach, describe, expect, it } from 'vitest'
import { readViewMode, writeViewMode } from './viewMode'

// Node test env has no Web Storage; provide an in-memory localStorage mock.
let store: Map<string, string>
beforeEach(() => {
  store = new Map()
  globalThis.localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
    key: () => null,
    get length() { return store.size },
  } as Storage
})

describe('viewMode persistence', () => {
  it('defaults to live when nothing stored', () => {
    expect(readViewMode()).toBe('live')
  })

  it('round-trips a written value', () => {
    writeViewMode('studio')
    expect(readViewMode()).toBe('studio')
  })

  it('ignores an invalid stored value', () => {
    globalThis.localStorage.setItem('mgrains.viewMode', 'bogus')
    expect(readViewMode()).toBe('live')
  })

  it('does not throw when a write fails', () => {
    globalThis.localStorage.setItem = () => { throw new Error('nope') }
    expect(() => writeViewMode('studio')).not.toThrow()
  })
})
