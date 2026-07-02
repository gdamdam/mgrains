interface SessionBannerProps {
  sourceLabel?: string
  onContinue: () => void
  onDismiss: () => void
}

// Startup affordance: offers to restore the auto-saved last session. Restored
// params are silent until the source is re-linked (audio is never stored), so
// the saved source label is surfaced here as a relink hint.
export function SessionBanner({ sourceLabel, onContinue, onDismiss }: SessionBannerProps) {
  return (
    <div className="session-banner" role="region" aria-label="Continue last session">
      <span className="session-banner-text">
        Continue last session{sourceLabel ? ` · source: ${sourceLabel}` : ''}?
      </span>
      <div className="session-banner-actions">
        <button type="button" className="file-button" onClick={onContinue}>
          Continue
        </button>
        <button type="button" className="file-button" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  )
}
