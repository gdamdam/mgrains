export type ViewMode = 'live' | 'studio'

const KEY = 'mgrains.viewMode'

export function readViewMode(): ViewMode {
  try {
    return localStorage.getItem(KEY) === 'studio' ? 'studio' : 'live'
  } catch {
    return 'live'
  }
}

export function writeViewMode(mode: ViewMode): void {
  try {
    localStorage.setItem(KEY, mode)
  } catch {
    /* storage unavailable — preference simply does not persist */
  }
}
