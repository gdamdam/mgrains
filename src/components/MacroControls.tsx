import { MACROS } from '../audio/macros'
import type { GrainMode } from '../audio/contracts'

interface MacroControlsProps {
  mode: GrainMode
  values: Record<string, number>
  linked: Record<string, boolean>
  onChange: (id: string, value: number) => void
  onToggleLink: (id: string) => void
}

const SLIDER_STEPS = 1000

// The four performance macros for the active mode. Each macro moves a curated
// group of grain parameters together. Link/Unlink controls takeover: a linked
// macro writes its params; unlinking it leaves direct edits authoritative and
// disables the macro so a stray move can't clobber a hand-tuned patch.
export function MacroControls({ mode, values, linked, onChange, onToggleLink }: MacroControlsProps) {
  const macros = MACROS.filter((macro) => macro.mode === mode)

  return (
    <section className="macro-controls">
      <div className="panel-heading">
        <span>Macros</span>
        <span>{mode} · performance</span>
      </div>
      <div className="macro-grid">
        {macros.map((macro) => {
          const isLinked = linked[macro.id] !== false
          const value = values[macro.id] ?? 0
          return (
            <div className={`macro ${isLinked ? '' : 'is-unlinked'}`} key={macro.id}>
              <div className="macro-head">
                <span className="parameter-label">{macro.label}</span>
                <button
                  type="button"
                  className={`macro-link ${isLinked ? 'is-active' : ''}`}
                  aria-pressed={isLinked}
                  onClick={() => onToggleLink(macro.id)}
                >
                  {isLinked ? 'Linked' : 'Unlinked'}
                </button>
              </div>
              <span className="parameter-value">
                {Math.round(value * 100)} <span>%</span>
              </span>
              <input
                type="range"
                min={0}
                max={SLIDER_STEPS}
                value={Math.round(value * SLIDER_STEPS)}
                aria-label={`${macro.label} macro`}
                disabled={!isLinked}
                onChange={(event) => onChange(macro.id, Number(event.currentTarget.value) / SLIDER_STEPS)}
              />
            </div>
          )
        })}
      </div>
    </section>
  )
}
