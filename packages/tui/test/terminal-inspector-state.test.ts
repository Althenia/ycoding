import { describe, expect, test } from "bun:test"
import { PtyProtocol } from "@ycoding-ai/core/pty/protocol"
import { Pty } from "@ycoding-ai/schema/pty"
import { Schema } from "effect"
import { TerminalInspectorState, type TerminalEmulator } from "../src/component/terminal-inspector-state"

const info = (owner: Pty.ControlOwner = "agent", fence = owner === "agent" ? 1 : 2) =>
  Schema.decodeUnknownSync(Pty.Info)({
    id: "pty_state",
    sessionID: "ses_state",
    title: "State fixture",
    command: "/bin/sh",
    args: [],
    cwd: "/tmp",
    status: "running",
    pid: 42,
    generation: 1,
    size: { rows: 24, cols: 80 },
    control: { owner, fence },
    output: { startOffset: 0, endOffset: 0, truncated: false },
    limits: { maxRuntimeSeconds: 300, maxRetainedBytes: Pty.MAX_RETAINED_BYTES, maxInputBytes: Pty.MAX_INPUT_BYTES },
  } as unknown)

function emulator() {
  const writes: Uint8Array[] = []
  const value: TerminalEmulator = {
    write: (data) => writes.push(data.slice()),
    getSelectedText: () => "selected",
    hasSelection: () => true,
  }
  return { value, writes }
}

describe("TerminalInspectorState", () => {
  test("applies ordered generation/offset output and resumes a resident emulator contiguously", () => {
    const state = new TerminalInspectorState(info())
    const target = emulator()
    state.attach(target.value)
    state.connecting(state.reconnectInput())
    state.apply(PtyProtocol.controlFrame({ type: "replay", generation: 1, startOffset: 0, endOffset: 3, gap: false }))
    state.apply(PtyProtocol.controlFrame({ type: "chunk", generation: 1, startOffset: 0, endOffset: 3 }))
    state.apply(PtyProtocol.dataFrame(new TextEncoder().encode("one")))
    state.disconnected()

    expect(state.reconnectInput()).toEqual({ generation: 1, offset: 3, access: "inspect", fence: undefined })
    state.connecting(state.reconnectInput())
    state.apply(PtyProtocol.controlFrame({ type: "replay", generation: 1, startOffset: 3, endOffset: 6, gap: false }))
    state.apply(PtyProtocol.controlFrame({ type: "chunk", generation: 1, startOffset: 3, endOffset: 6 }))
    state.apply(PtyProtocol.dataFrame(new TextEncoder().encode("two")))

    expect(new TextDecoder().decode(Uint8Array.from(target.writes.flatMap((part) => [...part])))).toBe("onetwo")
    expect(state.snapshot()).toMatchObject({ synchronization: "synchronized", generation: 1, offset: 6 })
  })

  test("marks prefix eviction, generation changes, and out-of-order bytes unsynchronized without applying data", () => {
    const state = new TerminalInspectorState(info())
    const target = emulator()
    state.attach(target.value)
    state.connecting(state.reconnectInput())
    state.apply(PtyProtocol.controlFrame({ type: "replay", generation: 1, startOffset: 20, endOffset: 30, gap: true }))
    state.apply(PtyProtocol.controlFrame({ type: "chunk", generation: 1, startOffset: 20, endOffset: 30 }))
    state.apply(PtyProtocol.dataFrame(new Uint8Array(10)))

    expect(state.snapshot().synchronization).toBe("unsynchronized")
    expect(state.snapshot().reason).toContain("no longer retained")
    expect(target.writes).toHaveLength(0)
    expect(state.canInput()).toBe(false)
  })

  test("allows state-dependent input only for a connected synchronized current user fence", () => {
    const state = new TerminalInspectorState(info("user"))
    state.attach(emulator().value)
    state.connecting(state.reconnectInput("inspect"))
    state.apply(PtyProtocol.controlFrame({ type: "replay", generation: 1, startOffset: 0, endOffset: 0, gap: false }))
    expect(state.canInput()).toBe(false)

    state.connecting(state.reconnectInput("control"))
    expect(state.canInput()).toBe(false)
    state.apply(PtyProtocol.controlFrame({ type: "replay", generation: 1, startOffset: 0, endOffset: 3, gap: false }))
    expect(state.canInput()).toBe(false)
    state.apply(PtyProtocol.controlFrame({ type: "chunk", generation: 1, startOffset: 0, endOffset: 3 }))
    expect(state.canInput()).toBe(false)
    state.apply(PtyProtocol.dataFrame(new TextEncoder().encode("one")))
    expect(state.canInput()).toBe(true)
    state.disconnected()
    expect(state.canInput()).toBe(false)

    state.connecting(state.reconnectInput("control"))
    state.apply(PtyProtocol.controlFrame({ type: "replay", generation: 1, startOffset: 3, endOffset: 3, gap: false }))
    expect(state.canInput()).toBe(true)
    state.updateInfo(info("user", 3))
    expect(state.canInput()).toBe(false)
    state.updateInfo(info("paused", 3))
    expect(state.canInput()).toBe(false)
  })
})
