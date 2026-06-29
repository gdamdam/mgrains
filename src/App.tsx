import { useEffect, useRef, useState } from 'react'
import { AudioEngine, type AudioEngineState } from './audio/AudioEngine'
import {
  DEFAULT_PATCH,
  sanitizePatch,
  type GrainMode,
  type GrainPatch,
} from './audio/contracts'
import { createDemoSource } from './audio/demoSource'
import { ParameterControl } from './components/ParameterControl'
import { Waveform } from './components/Waveform'
import { XYPad } from './components/XYPad'
import './styles.css'

const MODE_COPY: Record<GrainMode, { title: string; detail: string }> = {
  bloom: {
    title: 'Bloom',
    detail: 'Slow clouds, suspended detail, open air.',
  },
  shatter: {
    title: 'Shatter',
    detail: 'Tight fragments, repetition, controlled damage.',
  },
}

const INITIAL_DEMO_PEAKS = createDemoSource(8_000).peaks

export default function App() {
  const engineRef = useRef<AudioEngine | null>(null)
  const [engineState, setEngineState] = useState<AudioEngineState>('idle')
  const [patch, setPatchState] = useState<GrainPatch>({ ...DEFAULT_PATCH })
  const [peaks, setPeaks] = useState<Float32Array | null>(INITIAL_DEMO_PEAKS)
  const [sourceLabel, setSourceLabel] = useState('Generated tone field')
  const [activeGrains, setActiveGrains] = useState(0)
  const [peak, setPeak] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => () => {
    void engineRef.current?.close()
  }, [])

  const updatePatch = (changes: Partial<GrainPatch>) => {
    setPatchState((current) => {
      const next = sanitizePatch({ ...current, ...changes })
      engineRef.current?.setPatch(next)
      return next
    })
  }

  const startAudio = async () => {
    setError(null)
    try {
      const engine = engineRef.current ?? new AudioEngine()
      engineRef.current = engine
      engine.onStateChange(setEngineState)
      engine.onTelemetry((telemetry) => {
        setActiveGrains(telemetry.activeGrains)
        setPeak(telemetry.peak)
      })
      await engine.start()
      const source = createDemoSource(engine.sampleRate ?? 48_000)
      setPeaks(source.peaks)
      setSourceLabel(source.label)
      engine.setPatch(patch)
      engine.setSource(source)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The audio engine could not start.')
    }
  }

  const loadFile = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    try {
      const engine = engineRef.current
      if (!engine || engineState !== 'running') {
        throw new Error('Start audio before loading a file.')
      }
      const source = await engine.decodeFile(file)
      engine.setSource(source)
      setPeaks(source.peaks)
      setSourceLabel(source.label)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The audio file could not be loaded.')
    }
  }

  const changeMode = (mode: GrainMode) => {
    updatePatch(mode === 'bloom'
      ? { mode, grainSizeMs: Math.max(140, patch.grainSizeMs), densityHz: 14, timingJitter: 0.08 }
      : { mode, grainSizeMs: Math.min(58, patch.grainSizeMs), densityHz: 24, timingJitter: 0.015 })
  }

  return (
    <main className={`app app--${patch.mode}`}>
      <header className="app-header">
        <div>
          <p className="eyebrow">granular instrument · foundation build</p>
          <h1>mgrains</h1>
        </div>
        <div className="engine-status" aria-live="polite">
          <span className={`status-dot status-dot--${engineState}`} />
          <span>{engineState}</span>
          <span className="meter" aria-label={`Output peak ${Math.round(peak * 100)} percent`}>
            <span style={{ width: `${Math.min(100, peak * 100)}%` }} />
          </span>
        </div>
        <div className="source-actions">
          <label className={`file-button ${engineState !== 'running' ? 'is-disabled' : ''}`}>
            Load file
            <input
              type="file"
              accept="audio/*,.wav,.aiff,.aif,.mp3,.m4a,.ogg,.flac"
              disabled={engineState !== 'running'}
              onChange={(event) => void loadFile(event.currentTarget.files?.[0])}
            />
          </label>
          <button
            className="audio-button"
            type="button"
            onClick={() => void startAudio()}
            disabled={engineState === 'starting'}
          >
            {engineState === 'running' ? 'Reload demo' : 'Start audio'}
          </button>
        </div>
      </header>

      <section className="intro-row">
        <div>
          <p className="eyebrow">Capture a moment.</p>
          <h2>{MODE_COPY[patch.mode].title} it.</h2>
          <p>{MODE_COPY[patch.mode].detail}</p>
        </div>
        <div className="mode-switch" aria-label="Granular mode">
          {(['bloom', 'shatter'] as const).map((mode) => (
            <button
              type="button"
              key={mode}
              className={patch.mode === mode ? 'is-active' : ''}
              aria-pressed={patch.mode === mode}
              onClick={() => changeMode(mode)}
            >
              {MODE_COPY[mode].title}
            </button>
          ))}
        </div>
      </section>

      {error && <p className="error-message" role="alert">{error}</p>}

      <Waveform
        peaks={peaks}
        mode={patch.mode}
        position={patch.position}
        regionStart={patch.regionStart}
        regionEnd={patch.regionEnd}
        activeGrains={activeGrains}
        onPositionChange={(position) => updatePatch({ position })}
      />

      <section className="performance-grid">
        <XYPad
          mode={patch.mode}
          x={patch.position}
          y={patch.spray}
          onChange={(position, spray) => updatePatch({ position, spray })}
        />

        <div className="direct-controls">
          <div className="panel-heading">
            <span>Grain controls</span>
            <span>direct · always available</span>
          </div>
          <div className="parameter-grid">
            <ParameterControl
              label="Grain size"
              value={patch.grainSizeMs}
              minimum={5}
              maximum={4000}
              unit="ms"
              scale="log"
              decimals={0}
              onChange={(grainSizeMs) => updatePatch({ grainSizeMs })}
            />
            <ParameterControl
              label="Density"
              value={patch.densityHz}
              minimum={0.25}
              maximum={80}
              unit="grains/s"
              scale="log"
              onChange={(densityHz) => updatePatch({ densityHz })}
            />
            <ParameterControl
              label="Position"
              value={patch.position * 100}
              minimum={0}
              maximum={100}
              unit="%"
              decimals={0}
              onChange={(position) => updatePatch({ position: position / 100 })}
            />
            <ParameterControl
              label="Spray"
              value={patch.spray * 100}
              minimum={0}
              maximum={100}
              unit="%"
              decimals={0}
              onChange={(spray) => updatePatch({ spray: spray / 100 })}
            />
          </div>
        </div>
      </section>

      <footer>
        <span>Source · {sourceLabel}</span>
        <span>AudioWorklet · deterministic 64-grain pool</span>
      </footer>
    </main>
  )
}
