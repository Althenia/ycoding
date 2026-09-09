import { PtyProtocol } from "@ycoding-ai/core/pty/protocol"
import type { Pty } from "@ycoding-ai/schema/pty"

export type TerminalEmulator = {
  write(data: Uint8Array): void
  getSelectedText(): string
  hasSelection(): boolean
}

export type TerminalInspectorSnapshot = {
  readonly info: Pty.Info
  readonly connection: "connecting" | "connected" | "disconnected" | "ended"
  readonly synchronization: "pending" | "synchronized" | "unsynchronized" | "stale"
  readonly generation?: number
  readonly offset?: number
  readonly reason?: string
}

export class TerminalInspectorState {
  private emulator?: TerminalEmulator
  private pending?: PtyProtocol.ChunkControl
  private replayEndOffset?: number
  private connection?: {
    readonly generation: number
    readonly access: Pty.Access
    readonly fence?: number
  }
  private listeners = new Set<() => void>()
  private value: TerminalInspectorSnapshot

  constructor(info: Pty.Info) {
    this.value = { info, connection: "connecting", synchronization: "pending" }
  }

  snapshot() {
    return this.value
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  attach(emulator: TerminalEmulator) {
    if (this.emulator && this.emulator !== emulator && this.value.offset !== undefined)
      this.unsynchronized("The resident terminal emulator was replaced without a full replay")
    this.emulator = emulator
  }

  updateInfo(info: Pty.Info) {
    this.value = { ...this.value, info }
    this.emit()
  }

  connecting(input: { generation: number; access: Pty.Access; fence?: number }) {
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

  reconnectInput(access: Pty.Access = "inspect") {
    return {
      generation: this.value.generation ?? this.value.info.generation,
      offset: this.value.offset ?? 0,
      access,
      fence: access === "control" ? this.value.info.control.fence : undefined,
    }
  }

  apply(frame: string | Uint8Array | ArrayBuffer) {
    const decoded = PtyProtocol.decodeServerFrame(frame)
    if (!decoded) {
      this.unsynchronized("Malformed terminal stream frame")
      return
    }
    if (this.value.synchronization === "unsynchronized") return
    if (decoded.type === "data") {
      this.applyData(decoded.value)
      return
    }
    if (decoded.value.type === "replay") {
      this.applyReplay(decoded.value)
      return
    }
    if (decoded.value.type === "chunk") {
      this.applyChunk(decoded.value)
      return
    }
    this.pending = undefined
    this.replayEndOffset = undefined
    this.value = {
      ...this.value,
      connection: "ended",
      synchronization: "stale",
      reason: decoded.value.reason,
    }
    this.emit()
  }

  canInput() {
    return (
      this.value.connection === "connected" &&
      this.value.synchronization === "synchronized" &&
      this.value.info.control.owner === "user" &&
      this.connection?.access === "control" &&
      this.connection.generation === this.value.info.generation &&
      this.connection.fence === this.value.info.control.fence
    )
  }

  selectedText() {
    return this.emulator?.hasSelection() ? this.emulator.getSelectedText() : ""
  }

  private applyReplay(replay: PtyProtocol.ReplayControl) {
    const contiguous =
      !replay.gap &&
      ((this.value.generation === undefined && replay.startOffset === 0) ||
        (this.value.generation === replay.generation && this.value.offset === replay.startOffset))
    this.pending = undefined
    if (!contiguous) {
      this.unsynchronized(
        replay.gap
          ? `Terminal output before byte ${replay.startOffset} is no longer retained`
          : "Terminal generation or replay offset changed",
      )
      return
    }
    const synchronized = replay.startOffset === replay.endOffset
    this.replayEndOffset = synchronized ? undefined : replay.endOffset
    this.value = {
      ...this.value,
      connection: "connected",
      synchronization: synchronized ? "synchronized" : "pending",
      generation: replay.generation,
      offset: replay.startOffset,
      reason: undefined,
    }
    this.emit()
  }

  private applyChunk(chunk: PtyProtocol.ChunkControl) {
    const replayPending = this.value.synchronization === "pending"
    if (
      this.value.connection !== "connected" ||
      (!replayPending && this.value.synchronization !== "synchronized") ||
      chunk.generation !== this.value.generation ||
      chunk.startOffset !== this.value.offset ||
      (replayPending && (this.replayEndOffset === undefined || chunk.endOffset > this.replayEndOffset)) ||
      this.pending
    ) {
      this.unsynchronized("Terminal output sequence is not contiguous")
      return
    }
    this.pending = chunk
  }

  private applyData(data: Uint8Array) {
    const pending = this.pending
    this.pending = undefined
    if (!pending || pending.endOffset - pending.startOffset !== data.byteLength || !this.emulator) {
      this.unsynchronized("Terminal output data did not match its ordered boundary")
      return
    }
    this.emulator.write(data)
    const synchronized = this.value.synchronization === "pending" && pending.endOffset === this.replayEndOffset
    if (synchronized) this.replayEndOffset = undefined
    this.value = {
      ...this.value,
      synchronization: synchronized ? "synchronized" : this.value.synchronization,
      offset: pending.endOffset,
    }
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
