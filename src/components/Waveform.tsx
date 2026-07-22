import { useEffect, useMemo, useRef, useState } from 'react'
import type { GrainMode } from '../audio/contracts'
import { pointerToRegionPositionViewport } from './waveformPosition'
import {
  bufferToViewportX,
  hitTestHandle,
  moveRegionEnd,
  moveRegionStart,
  nudgeRegionEnd,
  nudgeRegionStart,
  panLeft,
  panRight,
  regionPositionToBuffer,
  viewportXToBuffer,
  zoomIn,
  zoomOut,
  type Viewport,
} from './waveformView'

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
  // Persisted by App into patch.regionStart/regionEnd. Optional so existing
  // callers that only drive position keep working unchanged.
  onRegionChange?: (start: number, end: number) => void
}

const WIDTH = 1000
const HEIGHT = 280
const FULL_VIEWPORT: Viewport = { start: 0, end: 1 }
// Handle grab tolerance in viewBox units (SVG is 1000 wide, scaled to fit).
const HANDLE_HIT_TOLERANCE = 20

type DragMode = 'position' | 'start' | 'end' | null

const pct = (n: number): string => `${Math.round(n * 100)}%`

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
  onRegionChange,
}: WaveformProps) {
  const [viewport, setViewport] = useState<Viewport>(FULL_VIEWPORT)
  const dragMode = useRef<DragMode>(null)

  // Reset zoom/pan to the whole buffer whenever the source changes. We detect a
  // new source by peaks *identity* (App hands us a fresh Float32Array per load),
  // not by content, so telemetry-only re-renders never reset the view.
  const prevPeaks = useRef<Float32Array | null>(peaks)
  useEffect(() => {
    if (prevPeaks.current !== peaks) {
      prevPeaks.current = peaks
      setViewport(FULL_VIEWPORT)
    }
  }, [peaks])

  const region = { start: regionStart, end: regionEnd }

  // Only the visible slice is drawn. Keyed on [peaks, viewport] so it is never
  // rebuilt for telemetry props (position/activeGrains change ~30Hz).
  const path = useMemo(() => {
    if (!peaks?.length) return ''
    const len = peaks.length
    const center = HEIGHT / 2
    const i0 = Math.max(0, Math.floor(viewport.start * (len - 1)))
    const i1 = Math.min(len - 1, Math.ceil(viewport.end * (len - 1)))
    const commands: string[] = []
    for (let index = i0; index <= i1; index += 1) {
      const x = bufferToViewportX(index / (len - 1), viewport, WIDTH)
      const amplitude = Math.min(1, peaks[index] * 2.8) * center * 0.82
      commands.push(`${index === i0 ? 'M' : 'L'} ${x.toFixed(2)} ${(center - amplitude).toFixed(2)}`)
    }
    for (let index = i1; index >= i0; index -= 1) {
      const x = bufferToViewportX(index / (len - 1), viewport, WIDTH)
      const amplitude = Math.min(1, peaks[index] * 2.8) * center * 0.82
      commands.push(`L ${x.toFixed(2)} ${(center + amplitude).toFixed(2)}`)
    }
    return `${commands.join(' ')} Z`
  }, [peaks, viewport])

  const pointerX = (clientX: number, element: SVGSVGElement): number => {
    const bounds = element.getBoundingClientRect()
    if (bounds.width <= 0) return 0
    // Map the element-relative pointer into viewBox pixels.
    return ((clientX - bounds.left) / bounds.width) * WIDTH
  }

  const applyDrag = (px: number) => {
    if (dragMode.current === 'position') {
      onPositionChange(pointerToRegionPositionViewport(px, WIDTH, viewport, region))
    } else if (dragMode.current === 'start' && onRegionChange) {
      const next = moveRegionStart(region, viewportXToBuffer(px, viewport, WIDTH))
      onRegionChange(next.start, next.end)
    } else if (dragMode.current === 'end' && onRegionChange) {
      const next = moveRegionEnd(region, viewportXToBuffer(px, viewport, WIDTH))
      onRegionChange(next.start, next.end)
    }
  }

  const startX = bufferToViewportX(regionStart, viewport, WIDTH)
  const endX = bufferToViewportX(regionEnd, viewport, WIDTH)
  const positionX = bufferToViewportX(regionPositionToBuffer(position, region), viewport, WIDTH)
  const anchor = (regionStart + regionEnd) / 2

  const commitRegion = (next: { start: number; end: number }) => {
    if (onRegionChange) onRegionChange(next.start, next.end)
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
        aria-label="Waveform. Click or drag to choose the grain position; drag the region edges to trim."
        onPointerDown={(event) => {
          const px = pointerX(event.clientX, event.currentTarget)
          // Grabbing a handle takes priority over repositioning the playhead.
          const hit = onRegionChange ? hitTestHandle(px, region, viewport, WIDTH, HANDLE_HIT_TOLERANCE) : null
          dragMode.current = hit ?? 'position'
          event.currentTarget.setPointerCapture(event.pointerId)
          applyDrag(px)
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId) && dragMode.current) {
            applyDrag(pointerX(event.clientX, event.currentTarget))
          }
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId)
          }
          dragMode.current = null
        }}
      >
        <rect className="waveform-grid" width={WIDTH} height={HEIGHT} />
        {mode === 'shatter' && Array.from({ length: 16 }, (_, index) => (
          <line
            className="beat-line"
            key={index}
            x1={bufferToViewportX(index / 16, viewport, WIDTH)}
            x2={bufferToViewportX(index / 16, viewport, WIDTH)}
            y1={0}
            y2={HEIGHT}
          />
        ))}
        <rect
          className="region-fill"
          x={startX}
          width={Math.max(0, endX - startX)}
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
            const x = bufferToViewportX(grainPositions[index], viewport, WIDTH)
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
          className="region-handle region-handle--start"
          x1={startX}
          x2={startX}
          y1={0}
          y2={HEIGHT}
          aria-hidden="true"
        />
        <line
          className="region-handle region-handle--end"
          x1={endX}
          x2={endX}
          y1={0}
          y2={HEIGHT}
          aria-hidden="true"
        />
        <line
          className="position-line"
          x1={positionX}
          x2={positionX}
          y1={18}
          y2={HEIGHT - 18}
        />
      </svg>

      <div className="waveform-controls" role="group" aria-label="Waveform zoom and region controls">
        <button type="button" aria-label="Zoom in" onClick={() => setViewport((v) => zoomIn(v, anchor))}>+</button>
        <button type="button" aria-label="Zoom out" onClick={() => setViewport((v) => zoomOut(v, anchor))}>&minus;</button>
        <button type="button" aria-label="Pan left" onClick={() => setViewport((v) => panLeft(v))}>&#9664;</button>
        <button type="button" aria-label="Pan right" onClick={() => setViewport((v) => panRight(v))}>&#9654;</button>
        <button
          type="button"
          aria-label="Reset zoom"
          onClick={() => setViewport(FULL_VIEWPORT)}
        >Fit</button>
        {onRegionChange && (
          <>
            <input
              type="range"
              className="region-range region-range--start"
              aria-label="Region start"
              aria-valuetext={pct(regionStart)}
              min={0}
              max={1}
              step={0.001}
              value={regionStart}
              onChange={(event) => commitRegion(moveRegionStart(region, Number(event.target.value)))}
            />
            <input
              type="range"
              className="region-range region-range--end"
              aria-label="Region end"
              aria-valuetext={pct(regionEnd)}
              min={0}
              max={1}
              step={0.001}
              value={regionEnd}
              onChange={(event) => commitRegion(moveRegionEnd(region, Number(event.target.value)))}
            />
            <button type="button" aria-label="Nudge region start left" onClick={() => commitRegion(nudgeRegionStart(region, -1))}>[&minus;</button>
            <button type="button" aria-label="Nudge region start right" onClick={() => commitRegion(nudgeRegionStart(region, 1))}>[+</button>
            <button type="button" aria-label="Nudge region end left" onClick={() => commitRegion(nudgeRegionEnd(region, -1))}>&minus;]</button>
            <button type="button" aria-label="Nudge region end right" onClick={() => commitRegion(nudgeRegionEnd(region, 1))}>+]</button>
          </>
        )}
      </div>

      <p className="sr-only">
        Use the zoom and pan buttons to inspect the waveform, and the region sliders to trim the
        selection. The Position slider below provides a keyboard-accessible alternative to waveform dragging.
      </p>
    </section>
  )
}
