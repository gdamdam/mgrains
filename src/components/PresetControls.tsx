import type { Preset } from '../storage/presets'

interface SceneEntry {
  id: string
  name: string
  description: string
}

interface PresetControlsProps {
  presets: Preset[]
  scenes: ReadonlyArray<SceneEntry>
  name: string
  onNameChange: (name: string) => void
  onSave: () => void
  onLoad: (name: string) => void
  onLoadScene: (id: string) => void
  onDelete: (name: string) => void
}

// Save the current patch to IndexedDB under a name and recall/delete saved ones.
// Presentational: all storage I/O lives in App so this stays easy to reason about.
export function PresetControls({
  presets,
  scenes,
  name,
  onNameChange,
  onSave,
  onLoad,
  onLoadScene,
  onDelete,
}: PresetControlsProps) {
  return (
    <section className="preset-controls">
      <div className="panel-heading">
        <span>Scenes &amp; presets</span>
        <span>factory scenes + your own</span>
      </div>
      {scenes.length > 0 && (
        <ul className="preset-list preset-factory">
          {scenes.map((scene) => (
            <li key={scene.id}>
              <button
                type="button"
                className="preset-load"
                title={scene.description}
                onClick={() => onLoadScene(scene.id)}
              >
                {scene.name}
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
