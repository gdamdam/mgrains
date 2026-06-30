import type { Preset } from '../storage/presets'

interface FactoryEntry {
  name: string
  sourceHint: string
}

interface PresetControlsProps {
  presets: Preset[]
  factory: ReadonlyArray<FactoryEntry>
  name: string
  onNameChange: (name: string) => void
  onSave: () => void
  onLoad: (name: string) => void
  onLoadFactory: (name: string) => void
  onDelete: (name: string) => void
}

// Save the current patch to IndexedDB under a name and recall/delete saved ones.
// Presentational: all storage I/O lives in App so this stays easy to reason about.
export function PresetControls({
  presets,
  factory,
  name,
  onNameChange,
  onSave,
  onLoad,
  onLoadFactory,
  onDelete,
}: PresetControlsProps) {
  return (
    <section className="preset-controls">
      <div className="panel-heading">
        <span>Presets</span>
        <span>factory + your own</span>
      </div>
      {factory.length > 0 && (
        <ul className="preset-list preset-factory">
          {factory.map((preset) => (
            <li key={preset.name}>
              <button
                type="button"
                className="preset-load"
                title={`Good for: ${preset.sourceHint}`}
                onClick={() => onLoadFactory(preset.name)}
              >
                {preset.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="preset-save">
        <input
          type="text"
          className="preset-name"
          placeholder="Preset name"
          value={name}
          aria-label="Preset name"
          onChange={(event) => onNameChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onSave()
          }}
        />
        <button type="button" className="file-button" onClick={onSave}>Save</button>
      </div>
      {presets.length > 0 && (
        <ul className="preset-list">
          {presets.map((preset) => (
            <li key={preset.name}>
              <button type="button" className="preset-load" onClick={() => onLoad(preset.name)}>
                {preset.name}
              </button>
              <button
                type="button"
                className="preset-delete"
                aria-label={`Delete preset ${preset.name}`}
                onClick={() => onDelete(preset.name)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
