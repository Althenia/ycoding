import { expect, test } from "bun:test"
import { fromBase64 } from "../src/terminal-protocol"
import { TerminalRelay, type TerminalSocketHandlers } from "../src/terminal-relay"
import { terminalKey, terminalPaste } from "../src/terminal-emulator"
import { message } from "./synthetic-backend"
import { syntheticDesktop } from "./synthetic-desktop"

const repo = "/synthetic/repo"
const sessionID = "ses_parent"
const envelope = (data: unknown) => ({ location: { directory: repo, project: { id: "prj_test", directory: repo } }, data })
const pty = (extra: Record<string, unknown> = {}) => ({ id: "pty_a", title: "Terminal", command: "zsh", args: [], cwd: repo, sessionID, status: "running", pid: 1, generation: 2, size: { rows: 24, cols: 80 }, control: { owner: "user", fence: 3 }, output: { startOffset: 0, endOffset: 0, truncated: false }, limits: { maxRuntimeSeconds: 60, maxRetainedBytes: 1024, maxInputBytes: 1024 }, ...extra })

function sockets() {
  const opened: { url: string; handlers: TerminalSocketHandlers; sent: string[]; state: number }[] = []
  const factory = (url: string, handlers: TerminalSocketHandlers) => {
    const entry = { url, handlers, sent: [] as string[], state: 0 }
    opened.push(entry)
    return { get readyState() { return entry.state }, send: (data: string) => { entry.sent.push(data) }, close: () => { entry.state = 3 } }
  }
  const open = (index = 0) => { opened[index]!.state = 1; opened[index]!.handlers.open() }
  return { opened, factory, open }
}

const decode = (frames: readonly string[]) => frames.map((frame) => [...fromBase64(frame)])

test("the relay buffers socket frames as base64 in order, waits briefly for new frames and ends after the final read", async () => {
  const fake = sockets()
  const relay = new TerminalRelay(fake.factory, { wait: 20, idle: 1_000, buffer: 1_024, streams: 8 })
  const id = relay.open("ws://synthetic/connect", 1, "inspect")
  fake.open()
  fake.opened[0]!.handlers.message(new Uint8Array([0, 1, 2]).buffer)
  fake.opened[0]!.handlers.message("\u0001A")
  expect(decode((await relay.read(id)).frames)).toEqual([[0, 1, 2], [1, 65]])
  expect(await relay.read(id)).toEqual({ frames: [], status: "open" })
  const pending = relay.read(id)
  fake.opened[0]!.handlers.message(new Uint8Array([1, 66]).buffer)
  expect(decode((await pending).frames)).toEqual([[1, 66]])
  fake.opened[0]!.handlers.message(new Uint8Array([1, 67]).buffer)
  fake.opened[0]!.handlers.close()
  const last = await relay.read(id)
  expect({ frames: decode(last.frames), status: last.status }).toEqual({ frames: [[1, 67]], status: "closed" })
  expect(await relay.read(id)).toEqual({ frames: [], status: "error" })
})

test("the relay writes only to open control streams and closes streams on overflow, revision change, explicit close and idleness", async () => {
  const fake = sockets()
  const relay = new TerminalRelay(fake.factory, { wait: 10, idle: 30, buffer: 8, streams: 8 })
  const inspect = relay.open("ws://synthetic/a", 1, "inspect")
  const control = relay.open("ws://synthetic/b", 1, "control")
  expect(relay.write(control, "x")).toBe(false)
  fake.open(0); fake.open(1)
  expect(relay.write(inspect, "x")).toBe(false)
  expect(relay.write(control, "ls\r")).toBe(true)
  expect(fake.opened[1]!.sent).toEqual(["ls\r"])
  fake.opened[0]!.handlers.message(new Uint8Array(16).buffer)
  expect(await relay.read(inspect)).toEqual({ frames: [], status: "error" })
  expect(fake.opened[0]!.state).toBe(3)
  relay.retain(2)
  expect(await relay.read(control)).toEqual({ frames: [], status: "error" })
  expect(relay.write(control, "x")).toBe(false)
  const closed = relay.open("ws://synthetic/c", 2, "inspect")
  relay.close(closed)
  expect(fake.opened[2]!.state).toBe(3)
  expect((await relay.read(closed)).status).toBe("error")
  const idle = relay.open("ws://synthetic/d", 2, "inspect")
  fake.open(3)
  await Bun.sleep(60)
  expect(fake.opened[3]!.state).toBe(3)
  expect((await relay.read(idle)).status).toBe("error")
})

test("the controller mints a Session-scoped ticket, opens the PTY socket on the backend side and relays control and resize", async () => {
  const fake = sockets()
  let token: Record<string, unknown> = { ticket: "synthetic-ticket", expires_in: 30, access: "control", generation: 2, fence: 3 }
  const owned = await syntheticDesktop((call) => {
    if (call.method === "GET" && call.route === `/api/session/${sessionID}`) return { data: { id: sessionID, title: "Parent", location: { directory: repo }, time: { created: 1, updated: 2 } } }
    if (call.route === "/api/pty/pty_a/connect-token") return envelope(token)
    if (call.route === "/api/pty/pty_a/control") return envelope(pty({ control: { owner: "paused", fence: 4 } }))
    if (call.route === "/api/pty/pty_a") return envelope(pty({ size: { rows: 30, cols: 100 }, control: { owner: "user", fence: 3 } }))
    return undefined
  }, { terminalSocket: fake.factory })
  try {
    const stream = await owned.controller.terminalConnect({ sessionID, ptyID: "pty_a", generation: 2, offset: 7, access: "control", fence: 3 })
    expect(stream.revision).toBe(owned.revision)
    expect(owned.calls.find((call) => call.route === "/api/pty/pty_a/connect-token")?.body).toEqual({ sessionID, access: "control", generation: 2, expectedFence: 3 })
    const url = new URL(fake.opened[0]!.url)
    expect(url.protocol).toBe("ws:")
    expect(url.pathname).toBe("/api/pty/pty_a/connect")
    expect(Object.fromEntries(url.searchParams)).toEqual({ "location[directory]": repo, sessionID, generation: "2", offset: "7", access: "control", fence: "3", ticket: "synthetic-ticket" })
    expect(JSON.stringify(stream)).not.toContain("synthetic-ticket")
    fake.open()
    await owned.controller.terminalWrite({ streamID: stream.streamID, data: "pwd\r" })
    expect(fake.opened[0]!.sent).toEqual(["pwd\r"])
    await expect(owned.controller.terminalWrite({ streamID: stream.streamID, data: "x".repeat(64 * 1024 + 1) })).rejects.toThrow()
    const paused = await owned.controller.terminalControl({ sessionID, ptyID: "pty_a", generation: 2, expectedFence: 3, action: "pause" })
    expect(paused.item.control).toEqual({ owner: "paused", fence: 4 })
    expect(owned.calls.find((call) => call.route === "/api/pty/pty_a/control")?.body).toEqual({ sessionID, generation: 2, expectedFence: 3, action: "pause" })
    const resized = await owned.controller.terminalResize({ sessionID, ptyID: "pty_a", generation: 2, expectedFence: 3, size: { rows: 30, cols: 100 } })
    expect(resized.item.size).toEqual({ rows: 30, cols: 100 })
    expect(owned.calls.find((call) => call.method === "PUT" && call.route === "/api/pty/pty_a")?.body).toEqual({ sessionID, generation: 2, expectedFence: 3, actor: "user", size: { rows: 30, cols: 100 } })
    await expect(owned.controller.terminalResize({ sessionID, ptyID: "pty_a", generation: 2, expectedFence: 3, size: { rows: 201, cols: 100 } })).rejects.toThrow()
    await expect(owned.controller.terminalControl({ sessionID, ptyID: "pty_a", generation: 2, expectedFence: 3, action: "kill" })).rejects.toThrow()
    await expect(owned.controller.terminalConnect({ sessionID, ptyID: "pty_a", generation: 2, offset: 0, access: "control" })).rejects.toThrow("writer fence")
    token = { ...token, generation: 9 }
    expect(await message(owned.controller.terminalConnect({ sessionID, ptyID: "pty_a", generation: 2, offset: 0, access: "control", fence: 3 }))).toContain("invalid terminal ticket")
    expect(fake.opened).toHaveLength(1)
    await owned.controller.disconnect()
    expect(await owned.controller.terminalRead({ streamID: stream.streamID })).toEqual({ frames: [], status: "error" })
    expect(fake.opened[0]!.state).toBe(3)
  } finally { await owned.close() }
})

test("keys encode for the PTY with cursor mode and modifiers and paste is bracketed only when requested", () => {
  const key = (value: string, modifiers: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }> = {}, applicationCursor = false) =>
    terminalKey({ key: value, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...modifiers }, { applicationCursor })
  expect([key("a"), key("A", { shiftKey: true }), key("Enter"), key("Backspace"), key("Tab"), key("Tab", { shiftKey: true }), key("Escape")]).toEqual(["a", "A", "\r", "\x7f", "\t", "\x1b[Z", "\x1b"])
  expect([key("ArrowUp"), key("ArrowUp", {}, true), key("ArrowLeft", { ctrlKey: true }), key("Home"), key("Delete"), key("PageDown", { shiftKey: true }), key("F1"), key("F5")]).toEqual(["\x1b[A", "\x1bOA", "\x1b[1;5D", "\x1b[H", "\x1b[3~", "\x1b[6;2~", "\x1bOP", "\x1b[15~"])
  expect([key("c", { ctrlKey: true }), key("[", { ctrlKey: true }), key(" ", { ctrlKey: true }), key("b", { altKey: true }), key("v", { metaKey: true }), key("Shift"), key("1", { ctrlKey: true })]).toEqual(["\x03", "\x1b", "\x00", "\x1bb", undefined, undefined, undefined])
  expect(terminalPaste("a\nb\r\nc", false)).toBe("a\rb\rc")
  expect(terminalPaste("x\x1b[201~y", true)).toBe("\x1b[200~xy\x1b[201~")
})
test("terminal input to a missing or retired stream reports failure rather than successful delivery", async () => {
  const app = await syntheticDesktop()
  try {
    await expect(app.controller.terminalWrite({ streamID: "term_missing", data: "x" })).rejects.toThrow(/not delivered/)
  } finally { await app.close() }
})
