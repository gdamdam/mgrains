// Pure listbox keyboard navigation: returns the next active option index.
// The component owns open/close state; this only moves the highlight.
export function nextActiveIndex(active: number, key: string, length: number): number {
  if (key === 'ArrowDown') return Math.min(length - 1, active + 1)
  if (key === 'ArrowUp') return Math.max(0, active - 1)
  if (key === 'Home') return 0
  if (key === 'End') return length - 1
  return active
}
