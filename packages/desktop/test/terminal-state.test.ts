import { expect, test } from "bun:test"
import { PtyProtocol } from "../../core/src/pty/protocol"
import type { SessionTerminal } from "../src/contract"
import { TerminalState } from "../src/terminal-state"

const info = (overrides: Partial<SessionTerminal> = {}): SessionTerminal => ({
  id: "pty_synthetic", title: "Synthetic", command: "sh", args: [], cwd: "/synthetic", sessionID: "ses_synthetic", status: "running", pid: 7, generation: 3,
  size: { rows: 4, cols: 20 }, control: { owner: "agent", fence: 5 }, output: { startOffset: 0, endOffset: 0, truncated: false },
  limits: { maxRuntimeSeconds: 60, maxRetainedBytes: 1024, maxInputBytes: 1024 }, ...overrides,
}) as SessionTerminal
const emulator = () => {
  const writes: number[][] = []
  return { writes, write: (data: Uint8Array) => { writes.push([...data]) }, getSelectedText: () => "picked", hasSelection: () => true }
}
const replay = (startOffset: number, endOffset: number, gap = false, generation = 3) => PtyProtocol.controlFrame({ type: "replay", generation, startOffset, endOffset, gap })
const chunk = (startOffset: number, endOffset: number, generation = 3) => PtyProtocol.controlFrame({ type: "chunk", generation, startOffset, endOffset })
const data = (...bytes: number[]) => PtyProtocol.dataFrame(new Uint8Array(bytes))

test("an ordered replay synchronizes at its end offset and live chunks advance the byte offset", () => {
  const state = new TerminalState(info())
  const screen = emulator()
  state.attach(screen)
  state.connecting(state.reconnectInput())
  expect(state.reconnectInput()).toEqual({ generation: 3, offset: 0, access: "inspect", fence: undefined })
  state.apply(replay(0, 3))
  expect(state.snapshot()).toMatchObject({ connection: "connected", synchronization: "pending", generation: 3, offset: 0 })
  state.apply(chunk(0, 2)); state.apply(data(65, 66))
  expect(state.snapshot().synchronization).toBe("pending")
  state.apply(chunk(2, 3)); state.apply(data(67))
  expect(state.snapshot()).toMatchObject({ synchronization: "synchronized", offset: 3 })
  state.apply(chunk(3, 4)); state.apply(data(68))
  expect(state.snapshot().offset).toBe(4)
  expect(screen.writes).toEqual([[65, 66], [67], [68]])
})

test("an empty replay is immediately synchronized and reconnecting resumes from the retained offset", () => {
  const state = new TerminalState(info())
  state.attach(emulator())
  state.apply(replay(0, 0))
  expect(state.snapshot().synchronization).toBe("synchronized")
  state.apply(chunk(0, 1)); state.apply(data(1))
  state.disconnected("socket closed")
  expect(state.snapshot()).toMatchObject({ connection: "disconnected", reason: "socket closed", offset: 1 })
  expect(state.reconnectInput()).toEqual({ generation: 3, offset: 1, access: "inspect", fence: undefined })
  state.connecting(state.reconnectInput())
  state.apply(replay(1, 1))
  expect(state.snapshot()).toMatchObject({ connection: "connected", synchronization: "synchronized", offset: 1 })
})

test("gaps, generation changes and unordered output leave the view unsynchronized and ignore later frames", () => {
  const gap = new TerminalState(info()); gap.attach(emulator())
  gap.apply(replay(4, 9, true))
  expect(gap.snapshot()).toMatchObject({ synchronization: "unsynchronized", reason: "Terminal output before byte 4 is no longer retained" })
  const moved = new TerminalState(info()); moved.attach(emulator())
  moved.apply(replay(0, 0)); moved.apply(replay(0, 0, false, 4))
  expect(moved.snapshot()).toMatchObject({ synchronization: "unsynchronized", reason: "Terminal generation or replay offset changed" })
  const unordered = new TerminalState(info()); const screen = emulator(); unordered.attach(screen)
  unordered.apply(replay(0, 0)); unordered.apply(chunk(2, 3))
  expect(unordered.snapshot()).toMatchObject({ synchronization: "unsynchronized", reason: "Terminal output sequence is not contiguous" })
  unordered.apply(chunk(0, 1)); unordered.apply(data(9))
  expect(screen.writes).toEqual([])
  const loose = new TerminalState(info()); loose.attach(emulator())
  loose.apply(replay(0, 0)); loose.apply(data(1))
  expect(loose.snapshot().reason).toBe("Terminal output data did not match its ordered boundary")
  const mismatch = new TerminalState(info()); mismatch.attach(emulator())
  mismatch.apply(replay(0, 0)); mismatch.apply(chunk(0, 2)); mismatch.apply(data(1))
  expect(mismatch.snapshot().synchronization).toBe("unsynchronized")
  const overrun = new TerminalState(info()); overrun.attach(emulator())
  overrun.apply(replay(0, 2)); overrun.apply(chunk(0, 3))
  expect(overrun.snapshot().synchronization).toBe("unsynchronized")
  const malformed = new TerminalState(info()); malformed.attach(emulator())
  malformed.apply(new Uint8Array([7]))
  expect(malformed.snapshot()).toMatchObject({ synchronization: "unsynchronized", reason: "Malformed terminal stream frame" })
})

test("an end frame finishes the stream and later connection changes do not reopen it", () => {
  const state = new TerminalState(info())
  state.attach(emulator())
  state.apply(replay(0, 0))
  state.apply(PtyProtocol.controlFrame({ type: "end", generation: 3, reason: "exit", exitCode: 0 }))
  expect(state.snapshot()).toMatchObject({ connection: "ended", synchronization: "stale", reason: "exit" })
  state.disconnected("late"); state.connecting(state.reconnectInput())
  expect(state.snapshot().connection).toBe("ended")
})

test("input requires a synchronized control connection at the current generation and writer fence", () => {
  const state = new TerminalState(info({ control: { owner: "user", fence: 6 } }))
  state.attach(emulator())
  expect(state.reconnectInput("control")).toEqual({ generation: 3, offset: 0, access: "control", fence: 6 })
  state.connecting(state.reconnectInput("control"))
  expect(state.canInput()).toBe(false)
  state.apply(replay(0, 0))
  expect(state.canInput()).toBe(true)
  state.updateInfo(info({ control: { owner: "user", fence: 7 } }))
  expect(state.canInput()).toBe(false)
  const inspect = new TerminalState(info({ control: { owner: "user", fence: 6 } }))
  inspect.attach(emulator()); inspect.connecting(inspect.reconnectInput("inspect")); inspect.apply(replay(0, 0))
  expect(inspect.canInput()).toBe(false)
  const agent = new TerminalState(info({ control: { owner: "agent", fence: 6 } }))
  agent.attach(emulator()); agent.connecting(agent.reconnectInput("control")); agent.apply(replay(0, 0))
  expect(agent.canInput()).toBe(false)
  expect(state.selectedText()).toBe("picked")
})

test("replacing the emulator after output marks the view unsynchronized", () => {
  const state = new TerminalState(info())
  state.attach(emulator()); state.apply(replay(0, 0))
  state.attach(emulator())
  expect(state.snapshot()).toMatchObject({ synchronization: "unsynchronized", reason: "The resident terminal emulator was replaced without a full replay" })
})

test("a first replay from another generation cannot enable terminal input", () => {
  const state = new TerminalState(info({ control: { owner: "user", fence: 6 } }))
  state.attach(emulator())
  state.connecting(state.reconnectInput("control"))
  state.apply(replay(0, 0, false, 4))
  expect(state.canInput()).toBe(false)
  expect(state.snapshot().synchronization).toBe("unsynchronized")
})
