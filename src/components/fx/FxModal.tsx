import { useEffect, useId, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import './fx.css'

interface FxModalProps {
  title: string
  open: boolean
  onClose: () => void
  children: ReactNode
  viz?: ReactNode
}

/**
 * FxModal — an accessible dialog for a single effect's settings.
 *
 * Renders nothing while `open` is false. When open it is a
 * role="dialog" aria-modal surface that:
 *   - closes on Escape (keydown on the dialog) and on backdrop click,
 *   - focuses the dialog container on open and traps Tab / Shift+Tab within it
 *     so keyboard users cannot reach the (still-visible) background,
 *   - has a header (title + close button), an optional `viz` slot for the SVG
 *     visualization, and a body (`children` = the param sliders).
 *
 * Purely presentational: open/close is owned by the parent.
 */
export function FxModal({ title, open, onClose, children, viz }: FxModalProps) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)

  // Focus the dialog when it opens so keyboard users land inside it and
  // Escape is captured. Restore focus to the previously focused element on
  // close so the trigger button regains focus.
  useEffect(() => {
    if (!open) return
    const opener = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
    return () => {
      if (opener && typeof opener.focus === 'function') {
        try {
          opener.focus()
        } catch {
          // The opener may have unmounted — safe to ignore.
        }
      }
    }
  }, [open])

  if (!open) return null

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key !== 'Tab') return
    // Trap focus: aria-modal alone does not stop Tab from leaving the dialog
    // into the still-rendered background (no `inert` pattern exists here), so
    // we cycle focus between the first and last focusable descendants.
    const dialog = dialogRef.current
    if (!dialog) return
    const focusable = dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    if (focusable.length === 0) {
      event.preventDefault()
      dialog.focus()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const active = document.activeElement
    if (event.shiftKey) {
      // Wrap backward from the first element (or the dialog itself) to the last.
      if (active === first || active === dialog) {
        event.preventDefault()
        last.focus()
      }
    } else if (active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="fx-modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="fx-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="fx-modal-header">
          <h2 className="fx-modal-title" id={titleId}>
            {title}
          </h2>
          <button
            type="button"
            className="fx-modal-close"
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>

        {viz ? <div className="fx-modal-viz">{viz}</div> : null}

        <div className="fx-modal-body">{children}</div>
      </div>
    </div>
  )
}
