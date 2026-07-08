import { useMemo } from 'react'
import type { GrainMode } from '../audio/contracts'
import { pointerToRegionPosition } from './waveformPosition'

interface WaveformProps {
  peaks: Float32Array | null
  mode: GrainMode
  position: number
  regionStart: number
  regionEnd: number
  activeGrains: number
  visualGrainCount: number
  grainPositions: Float32Array<ArrayBufferLike>
  grainIntensities: Float32Array<ArrayBufferLike>
  emptyLabel?: string
  onPositionChange: (position: number) => void
}

const WIDTH = 1000
const HEIGHT = 280

export function Waveform({
  peaks,
  mode,
  position,
  regionStart,
  regionEnd,
  activeGrains,
  visualGrainCount,
  grainPositions,
  grainIntensities,
  emptyLabel = 'Choose a source to begin',
  onPositionChange,
}: WaveformProps) {
  const path = useMemo(() => {
    if (!peaks?.length) return ''
    const center = HEIGHT / 2
    const commands: string[] = []
    for (let index = 0; index < peaks.length; index += 1) {
      const x = index / (peaks.length - 1) * WIDTH
      const amplitude = Math.min(1, peaks[index] * 2.8) * center * 0.82
      commands.push(`${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${(center - amplitude).toFixed(2)}`)
    }
    for (let index = peaks.length - 1; index >= 0; index -= 1) {
      const x = index / (peaks.length - 1) * WIDTH
      const amplitude = Math.min(1, peaks[index] * 2.8) * center * 0.82
      commands.push(`L ${x.toFixed(2)} ${(center + amplitude).toFixed(2)}`)
    }
    return `${commands.join(' ')} Z`
  }, [peaks])

  const setPositionFromPointer = (clientX: number, element: SVGSVGElement) => {
    const bounds = element.getBoundingClientRect()
    const normalized = (clientX - bounds.left) / bounds.width
    onPositionChange(pointerToRegionPosition(normalized, regionStart, regionEnd))
  }

  return (
    <section className={`waveform-stage waveform-stage--${mode}`} aria-label="Source waveform">
      <div className="stage-meta">
        <span>Source field</span>
        <span>{activeGrains} grains active</span>
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label="Waveform. Click or drag to choose the grain position."
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          setPositionFromPointer(event.clientX, event.currentTarget)
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            setPositionFromPointer(event.clientX, event.currentTarget)
          }
        }}
      >
        <rect className="waveform-grid" width={WIDTH} height={HEIGHT} />
        {mode === 'shatter' && Array.from({ length: 16 }, (_, index) => (
          <line
            className="beat-line"
            key={index}
            x1={index / 16 * WIDTH}
            x2={index / 16 * WIDTH}
            y1={0}
            y2={HEIGHT}
          />
        ))}
        <rect
          className="region-fill"
          x={regionStart * WIDTH}
          width={(regionEnd - regionStart) * WIDTH}
          height={HEIGHT}
        />
        {path && <path className="waveform-path" d={path} />}
        {!path && (
          <text className="waveform-empty" x={WIDTH / 2} y={HEIGHT / 2} textAnchor="middle">
            {emptyLabel}
          </text>
        )}
        <g className="grain-visuals" aria-hidden="true">
          {Array.from({ length: visualGrainCount }, (_, index) => {
            const x = grainPositions[index] * WIDTH
            const intensity = Math.min(1, Math.max(0, grainIntensities[index]))
            const y = HEIGHT / 2 + Math.sin(index * 2.399) * HEIGHT * 0.27
            const radius = 2.4 + intensity * 4.6
            return (
              <g className="grain-marker" key={index} opacity={0.28 + intensity * 0.72}>
                <line
                  x1={x}
                  x2={x}
                  y1={y - 7 - intensity * 8}
                  y2={y + 7 + intensity * 8}
                />
                <circle cx={x} cy={y} r={radius} />
              </g>
            )
          })}
        </g>
        <line
          className="position-line"
          x1={(regionStart + position * (regionEnd - regionStart)) * WIDTH}
          x2={(regionStart + position * (regionEnd - regionStart)) * WIDTH}
          y1={18}
          y2={HEIGHT - 18}
        />
      </svg>
      <p className="sr-only">
        The Position slider below provides a keyboard-accessible alternative to waveform dragging.
      </p>
    </section>
  )
}
