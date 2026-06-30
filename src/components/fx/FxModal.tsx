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
 *   - focuses the dialog container on open (focus is not trapped — the lead
 *     can layer trapping later if needed),
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
