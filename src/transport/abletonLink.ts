// Framework-agnostic client for the mpump Ableton Link bridge.
//
// The bridge is a small companion desktop app (Tauri/Rust) that joins the local
// Ableton Link session over UDP multicast and exposes it as a WebSocket so browsers
// — which cannot speak Link directly — can read tempo/beat/phase and drive transport.
// See ~/dev/music/mpump/link-bridge. Wire protocol (JSON over WebSocket):
//
//   Server -> Browser (~20Hz):
//     {"type":"link","tempo":120.0,"beat":2.5,"phase":0.625,"playing":true,"peers":1,"clients":1}
//   Browser -> Server:
//     {"type":"set_tempo","tempo":130.0}
//     {"type":"set_playing","playing":true}
//
// The bridge listens on ws://localhost:19876. We expose `tempo` as `bpm` to match
// mgrains' own naming (see src/audio/contracts.ts), but the wire field stays `tempo`.

/** Default bridge endpoint — must match the port the mpump link-bridge binds. */
export const DEFAULT_LINK_URL = 'ws://localhost:19876'

/** Latest known Link session state, in mgrains-facing terms. */
export interface LinkState {
  /** True while a WebSocket to the bridge is open. */
  connected: boolean
  /** Session tempo in BPM (the bridge's `tempo` field). */
  bpm: number
  /** Continuous beat position (e.g. 2.5 = halfway through beat 3). */
  beat: number
  /** Phase within the bar (0..quantum). */
  phase: number
  /** Number of other Link peers on the network (e.g. Ableton Live). */
  peers: number
  /** Whether the Link session transport is running. */
  playing: boolean
}

/** Fresh, disconnected default state. */
export function initialLinkState(): LinkState {
  return {
    connected: false,
    bpm: 0,
    beat: 0,
    phase: 0,
    peers: 0,
    playing: false,
  }
}

/** State fields the bridge can report. `connected` is owned by the socket, not the wire. */
export type LinkStatePatch = Partial<Omit<LinkState, 'connected'>>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Parse a raw server frame into a partial {@link LinkState}.
 *
 * Pure and defensive: returns null for malformed JSON, non-objects, or frames
 * whose `type` is not "link". Only well-typed, present fields appear in the patch,
 * so callers can merge it straight onto their snapshot.
 */
export function parseLinkMessage(data: string): LinkStatePatch | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }

  if (!isRecord(parsed) || parsed.type !== 'link') return null

  const patch: LinkStatePatch = {}
  // The wire field is `tempo`; we surface it as `bpm`.
  if (finiteNumber(parsed.tempo)) patch.bpm = parsed.tempo
  if (finiteNumber(parsed.beat)) patch.beat = parsed.beat
  if (finiteNumber(parsed.phase)) patch.phase = parsed.phase
  if (finiteNumber(parsed.peers)) patch.peers = parsed.peers
  if (typeof parsed.playing === 'boolean') patch.playing = parsed.playing

  return patch
}

/** Serialize a tempo change command for the bridge. */
export function encodeSetTempo(bpm: number): string {
  return JSON.stringify({ type: 'set_tempo', tempo: bpm })
}

/** Serialize a transport start/stop command for the bridge. */
export function encodeSetPlaying(playing: boolean): string {
  return JSON.stringify({ type: 'set_playing', playing })
}

/**
 * Wrap a phase value into [0, quantum). Returns 0 for a non-positive quantum.
 * Handy for projecting the bridge's beat/phase onto a local bar of a given length.
 */
export function wrapPhase(phase: number, quantum: number): number {
  if (quantum <= 0) return 0
  const wrapped = phase % quantum
  return wrapped < 0 ? wrapped + quantum : wrapped
}

/** Callback invoked with the latest immutable snapshot whenever state changes. */
export type LinkStateListener = (state: Readonly<LinkState>) => void

export interface AbletonLinkOptions {
  /** Bridge endpoint. Defaults to {@link DEFAULT_LINK_URL}. */
  url?: string
  /** Initial reconnect delay in ms (doubles up to maxReconnectDelayMs). Default 1000. */
  reconnectDelayMs?: number
  /** Reconnect backoff ceiling in ms. Default 8000. */
  maxReconnectDelayMs?: number
  /** WebSocket factory, for injecting a fake in tests. Defaults to global WebSocket. */
  webSocketFactory?: (url: string) => WebSocket
}

/**
 * WebSocket client for the mpump Link bridge.
 *
 * Mirrors mpump's web client (open socket, JSON.parse on message, JSON.stringify
 * on send, reconnect on close) but is framework-agnostic and adds exponential
 * backoff. All wire parsing/encoding lives in the exported pure helpers above.
 */
export class AbletonLinkClient {
  private readonly url: string
  private readonly baseReconnectDelayMs: number
  private readonly maxReconnectDelayMs: number
  private readonly createSocket: (url: string) => WebSocket

  private socket: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelayMs: number
  private closedByUser = false
  private state: LinkState = initialLinkState()
  private readonly listeners = new Set<LinkStateListener>()

  constructor(options: AbletonLinkOptions = {}) {
    this.url = options.url ?? DEFAULT_LINK_URL
    this.baseReconnectDelayMs = options.reconnectDelayMs ?? 1000
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 8000
    this.reconnectDelayMs = this.baseReconnectDelayMs
    this.createSocket =
      options.webSocketFactory ?? ((url) => new WebSocket(url))
  }

  /** Latest immutable state snapshot. */
  getState(): Readonly<LinkState> {
    return this.state
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  onChange(listener: LinkStateListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Open a connection to the bridge. A no-op if already open or connecting. */
  connect(url?: string): void {
    this.closedByUser = false
    if (this.socket) return
    this.open(url ?? this.url)
  }

  /** Close the connection and stop reconnecting. */
  disconnect(): void {
    this.closedByUser = true
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const socket = this.socket
    this.socket = null
    if (socket) {
      socket.onopen = null
      socket.onmessage = null
      socket.onclose = null
      socket.onerror = null
      socket.close()
    }
    this.patch({ connected: false })
  }

  /** Request a tempo change; propagates to all Link peers via the bridge. */
  setTempo(bpm: number): void {
    this.send(encodeSetTempo(bpm))
  }

  /** Request a transport state change; propagates to all Link peers. */
  setPlaying(playing: boolean): void {
    this.send(encodeSetPlaying(playing))
  }

  /** Convenience: start transport. */
  start(): void {
    this.setPlaying(true)
  }

  /** Convenience: stop transport. */
  stop(): void {
    this.setPlaying(false)
  }

  private open(url: string): void {
    const socket = this.createSocket(url)
    this.socket = socket

    socket.onopen = () => {
      this.reconnectDelayMs = this.baseReconnectDelayMs
      this.patch({ connected: true })
    }

    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return
      const patch = parseLinkMessage(event.data)
      if (patch) this.patch(patch)
    }

    socket.onerror = () => {
      socket.close()
    }

    socket.onclose = () => {
      this.socket = null
      this.patch({ connected: false })
      if (!this.closedByUser) this.scheduleReconnect(url)
    }
  }

  private scheduleReconnect(url: string): void {
    if (this.reconnectTimer !== null) return
    const delay = this.reconnectDelayMs
    this.reconnectDelayMs = Math.min(delay * 2, this.maxReconnectDelayMs)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.closedByUser) this.open(url)
    }, delay)
  }

  private send(message: string): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(message)
    }
  }

  private patch(patch: Partial<LinkState>): void {
    const next: LinkState = { ...this.state, ...patch }
    let changed = false
    for (const key of Object.keys(next) as Array<keyof LinkState>) {
      if (next[key] !== this.state[key]) {
        changed = true
        break
      }
    }
    if (!changed) return
    this.state = next
    for (const listener of this.listeners) listener(this.state)
  }
}
