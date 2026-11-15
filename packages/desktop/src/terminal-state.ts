import type { SessionTerminal, TerminalAccess } from "./contract"
import { decodeTerminalFrame, type TerminalChunk, type TerminalReplay } from "./terminal-protocol"

export type TerminalSink = {
  write(data: Uint8Array): void
  getSelectedText(): string
  hasSelection(): boolean
}

export type TerminalSnapshot = {
  readonly info: SessionTerminal
  readonly connection: "connecting" | "connected" | "disconnected" | "ended"
  readonly synchronization: "pending" | "synchronized" | "unsynchronized" | "stale"
  readonly generation?: number
  readonly offset?: number
  readonly reason?: string
}

export type TerminalConnection = { readonly generation: number; readonly offset: number; readonly access: TerminalAccess; readonly fence?: number }

export class TerminalState {
  private sink?: TerminalSink
  private pending?: TerminalChunk
  private replayEndOffset?: number
  private connection?: TerminalConnection
  private listeners = new Set<() => void>()
  private value: TerminalSnapshot

  constructor(info: SessionTerminal) {
    this.value = { info, connection: "connecting", synchronization: "pending" }
  }

  snapshot() { return this.value }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  attach(sink: TerminalSink) {
    if (this.sink && this.sink !== sink && this.value.offset !== undefined) this.unsynchronized("The resident terminal emulator was replaced without a full replay")
    this.sink = sink
  }

  updateInfo(info: SessionTerminal) {
    this.value = { ...this.value, info }
    this.emit()
  }

  connecting(input: TerminalConnection) {
    if (this.value.connection === "ended") return
    this.pending = undefined
    this.replayEndOffset = undefined
    this.connection = input
    this.value = { ...this.value, connection: "connecting" }
    this.emit()
  }

  disconnected(reason?: string) {
    if (this.value.connection === "ended") return
    this.pending = undefined
    this.replayEndOffset = undefined
    this.value = { ...this.value, connection: "disconnected", reason: reason ?? this.value.reason }
    this.emit()
  }

  reconnectInput(access: TerminalAccess = "inspect"): TerminalConnection {
    return { generation: this.value.generation ?? this.value.info.generation, offset: this.value.offset ?? 0, access, fence: access === "control" ? this.value.info.control.fence : undefined }
  }

  apply(frame: string | Uint8Array | ArrayBuffer) {
    const decoded = decodeTerminalFrame(frame)
    if (!decoded) return this.unsynchronized("Malformed terminal stream frame")
    if (this.value.synchronization === "unsynchronized") return
    if (decoded.type === "data") return this.applyData(decoded.value)
    if (decoded.value.type === "replay") return this.applyReplay(decoded.value)
    if (decoded.value.type === "chunk") return this.applyChunk(decoded.value)
    this.pending = undefined
    this.replayEndOffset = undefined
    this.value = { ...this.value, connection: "ended", synchronization: "stale", reason: decoded.value.reason }
    this.emit()
  }

  canInput() {
    const info = this.value.info
    return this.value.connection === "connected" && this.value.synchronization === "synchronized" && info.control.owner === "user" &&
      this.connection?.access === "control" && this.connection.generation === info.generation && this.connection.fence === info.control.fence
  }

  selectedText() {
    return this.sink?.hasSelection() ? this.sink.getSelectedText() : ""
  }

  private applyReplay(replay: TerminalReplay) {
    const contiguous = !replay.gap && replay.generation === (this.connection?.generation ?? this.value.info.generation) && ((this.value.generation === undefined && replay.startOffset === 0) || (this.value.generation === replay.generation && this.value.offset === replay.startOffset))
    this.pending = undefined
    if (!contiguous) return this.unsynchronized(replay.gap ? `Terminal output before byte ${replay.startOffset} is no longer retained` : "Terminal generation or replay offset changed")
    const synchronized = replay.startOffset === replay.endOffset
    this.replayEndOffset = synchronized ? undefined : replay.endOffset
    this.value = { ...this.value, connection: "connected", synchronization: synchronized ? "synchronized" : "pending", generation: replay.generation, offset: replay.startOffset, reason: undefined }
    this.emit()
  }

  private applyChunk(chunk: TerminalChunk) {
    const replayPending = this.value.synchronization === "pending"
    if (this.value.connection !== "connected" || (!replayPending && this.value.synchronization !== "synchronized") || chunk.generation !== this.value.generation ||
      chunk.startOffset !== this.value.offset || (replayPending && (this.replayEndOffset === undefined || chunk.endOffset > this.replayEndOffset)) || this.pending)
      return this.unsynchronized("Terminal output sequence is not contiguous")
    this.pending = chunk
  }

  private applyData(data: Uint8Array) {
    const pending = this.pending
    this.pending = undefined
    if (!pending || pending.endOffset - pending.startOffset !== data.byteLength || !this.sink) return this.unsynchronized("Terminal output data did not match its ordered boundary")
    this.sink.write(data)
    const synchronized = this.value.synchronization === "pending" && pending.endOffset === this.replayEndOffset
    if (synchronized) this.replayEndOffset = undefined
    this.value = { ...this.value, synchronization: synchronized ? "synchronized" : this.value.synchronization, offset: pending.endOffset }
    this.emit()
  }

  private unsynchronized(reason: string) {
    this.pending = undefined
    this.replayEndOffset = undefined
    this.value = { ...this.value, synchronization: "unsynchronized", reason }
    this.emit()
  }

  private emit() {
    for (const listener of this.listeners) listener()
  }
}
