import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { nextActiveIndex } from './selectNav'

interface SelectOption<T extends string> { value: T; label: string }
interface SelectProps<T extends string> {
  label: string
  value: T
  options: SelectOption<T>[]
  onChange: (value: T) => void
  id?: string
}

export function Select<T extends string>({ label, value, options, onChange, id }: SelectProps<T>) {
  const reactId = useId()
  const listId = `${id ?? reactId}-list`
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const selectedIndex = options.findIndex((o) => o.value === value)
  const current = selectedIndex >= 0 ? options[selectedIndex] : undefined

  useEffect(() => {
    if (!open) return
    const onDocDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocDown)
    return () => document.removeEventListener('mousedown', onDocDown)
  }, [open])

  const openList = () => {
    setActive(selectedIndex >= 0 ? selectedIndex : 0)
    setOpen(true)
  }

  const choose = (i: number) => {
    const opt = options[i]
    if (opt) onChange(opt.value)
    setOpen(false)
    triggerRef.current?.focus()
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openList() }
      return
    }
    if (e.key === 'Escape') { setOpen(false); triggerRef.current?.focus(); return }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(active); return }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault()
      setActive((a) => nextActiveIndex(a, e.key, options.length))
    }
  }

  return (
    <div className="select" ref={rootRef}>
      <span className="select-label">{label}</span>
      <button
        ref={triggerRef}
        type="button" className="select-trigger" role="combobox" aria-haspopup="listbox"
        aria-expanded={open} aria-label={label} aria-controls={listId}
        onClick={() => (open ? setOpen(false) : openList())} onKeyDown={onKeyDown}
      >
        <span>{current?.label ?? ''}</span>
        <span className="select-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <ul className="select-list" role="listbox" id={listId} aria-activedescendant={`${listId}-${active}`}>
          {options.map((opt, i) => (
            <li
              key={opt.value} id={`${listId}-${i}`} role="option"
              aria-selected={opt.value === value}
              className={`select-option${i === active ? ' is-active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => { e.preventDefault(); choose(i) }}
            >
              {opt.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
