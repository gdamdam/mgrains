export interface FxBarItem {
  id: string
  label: string
  amount: number
  enabled: boolean
}

interface FxBarProps {
  items: FxBarItem[]
  onToggle: (id: string) => void
  onOpen: (id: string) => void
}

// Amount ring geometry. A 28×28 SVG with a ~270° gauge arc (mdrone halo
// style): a faint full-length track plus a fill arc whose length is
// proportional to amount (0..1). Rotated so the gap sits at the bottom.
const RING_R = 12
const RING_C = 2 * Math.PI * RING_R
const RING_ARC = RING_C * 0.75

function AmountRing({ amount }: { amount: number }) {
  const fill = RING_ARC * Math.min(1, Math.max(0, amount))
  return (
    <svg className="fx-ring" width={28} height={28} viewBox="0 0 28 28" aria-hidden="true">
      <g transform="rotate(135 14 14)">
        <circle
          cx={14}
          cy={14}
          r={RING_R}
          className="fx-ring-track"
          strokeDasharray={`${RING_ARC} ${RING_C}`}
        />
        <circle
          cx={14}
          cy={14}
          r={RING_R}
          className="fx-ring-fill"
          strokeDasharray={`${fill} ${RING_C}`}
        />
      </g>
    </svg>
  )
}

/**
 * FxBar — a horizontal row of presentational FX buttons.
 *
 * Interaction model (chosen for keyboard + screen-reader clarity):
 *   - The main button body OPENS the per-FX modal (onOpen). Opening is the
 *     primary, most-discoverable action and maps naturally to a labelled
 *     button.
 *   - A small dedicated power dot in the top-right corner TOGGLES the effect
 *     on/off (onToggle). It is a real <button> nested via DOM order but
 *     rendered as a sibling overlay, so it is independently focusable and has
 *     its own aria-pressed state. Its click is stopped from bubbling so
 *     toggling never also opens the modal.
 *
 * Each button shows its label and an SVG amount ring whose fill tracks
 * `amount` (0..1). Enabled effects get the lit `is-enabled` accent state.
 * Purely presentational: props in, callbacks out.
 */
export function FxBar({ items, onToggle, onOpen }: FxBarProps) {
  return (
    <div className="fx-bar" role="group" aria-label="Effects">
      {items.map((item) => (
        <div
          key={item.id}
          className={`fx-tile${item.enabled ? ' is-enabled' : ''}`}
        >
          <button
            type="button"
            className="fx-tile-open"
            onClick={() => onOpen(item.id)}
            title={`${item.label} — open settings`}
          >
            <span className="fx-tile-ring">
              <AmountRing amount={item.amount} />
              <span className="fx-tile-amount" aria-hidden="true">
                {Math.round(Math.min(1, Math.max(0, item.amount)) * 100)}
              </span>
            </span>
            <span className="fx-tile-label">{item.label}</span>
          </button>
          <button
            type="button"
            className="fx-tile-power"
            onClick={(event) => {
              event.stopPropagation()
              onToggle(item.id)
            }}
            aria-pressed={item.enabled}
            aria-label={`${item.label} ${item.enabled ? 'on' : 'off'}`}
            title={`${item.label} — turn ${item.enabled ? 'off' : 'on'}`}
          >
            <span className="fx-tile-power-dot" aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  )
}
