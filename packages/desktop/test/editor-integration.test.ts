import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"
import { DesktopEditor, discoverEditor, openDesktopEditor, type EditorSocket } from "../src/editor-integration"
import { readZedSelection } from "../src/editor-zed"

const roots: string[] = []
async function root() {
  const directory = await fs.mkdtemp("/Users/viadz/.local/share/ycoding/tasks/desktop-editor-synthetic-")
  roots.push(directory)
  return directory
}
afterEach(async () => { await Promise.all(roots.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))) })

test("IDE discovery picks the closest workspace and ignores invalid or non-WebSocket locks", async () => {
  const home = await root()
  const directory = path.join(home, "project", "nested")
  const locks = path.join(home, ".claude", "ide")
  await fs.mkdir(locks, { recursive: true })
  for (const [name, value] of Object.entries({
    "1234.lock": { workspaceFolders: [path.join(home, "project")] },
    "2345.lock": { workspaceFolders: [directory], transport: "ws", authToken: "synthetic-token" },
    "3456.lock": { workspaceFolders: [directory], transport: "sse" },
    "99999.lock": { workspaceFolders: [directory] },
    "1234junk.lock": { workspaceFolders: [directory] },
  })) await fs.writeFile(path.join(locks, name), JSON.stringify(value))
  expect(await discoverEditor(directory, home)).toMatchObject({ url: "ws://127.0.0.1:2345", authToken: "synthetic-token" })
  expect(await discoverEditor(path.join(home, "project-sibling"), home)).toBeUndefined()
})

function socketFixture() {
  const sent: string[] = []
  const listeners = new Map<string, (event: { data?: unknown }) => void>()
  const socket: EditorSocket = {
    readyState: 1,
    send: (data) => { sent.push(data) },
    close: () => { listeners.get("close")?.({}) },
    addEventListener: (name, listener) => { listeners.set(name, listener) },
  }
  return { socket, sent, fire: (name: string, data?: unknown) => listeners.get(name)?.({ data }) }
}

test("IDE transport initializes MCP, accepts connection and selection notifications, and clears stale workspace state", async () => {
  const home = await root()
  const workspace = path.join(home, "project")
  const locks = path.join(home, ".claude", "ide")
  await fs.mkdir(locks, { recursive: true })
  await fs.writeFile(path.join(locks, "1234.lock"), JSON.stringify({ workspaceFolders: [workspace], authToken: "synthetic-token" }))
  const channel = socketFixture()
  const editor = new DesktopEditor({ home, env: {}, socket: (url, headers) => { expect(url).toBe("ws://127.0.0.1:1234"); expect(headers).toEqual({ "x-claude-code-ide-authorization": "synthetic-token" }); return channel.socket } })
  try {
    expect((await editor.read(workspace)).status).toBe("connecting")
    channel.fire("open")
    expect(JSON.parse(channel.sent[0]!)).toMatchObject({ method: "initialize", params: { protocolVersion: "2025-11-25" } })
    channel.fire("message", JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "Synthetic IDE" } } }))
    expect(JSON.parse(channel.sent[1]!)).toEqual({ jsonrpc: "2.0", method: "notifications/initialized" })
    channel.fire("message", JSON.stringify({ jsonrpc: "2.0", method: "ide_connected", params: {} }))
    channel.fire("message", JSON.stringify({ jsonrpc: "2.0", method: "selection_changed", params: { filePath: path.join(workspace, "file.ts"), text: "selected", selection: { start: { line: 1, character: 2 }, end: { line: 1, character: 10 } } } }))
    expect(await editor.read(workspace)).toMatchObject({ status: "connected", selection: { source: "websocket", ranges: [{ text: "selected" }] } })
    expect(await editor.read(path.join(home, "other"))).toMatchObject({ status: "disabled" })
    channel.fire("message", JSON.stringify({ method: "selection_changed", params: { filePath: "/stale", text: "stale", selection: { start: { line: 1, character: 1 }, end: { line: 1, character: 6 } } } }))
    expect((await editor.read(path.join(home, "other"))).selection).toBeUndefined()
  } finally { editor.close() }
})

test("malformed IDE selections do not replace a valid selection", async () => {
  const home = await root()
  const locks = path.join(home, ".claude", "ide")
  await fs.mkdir(locks, { recursive: true })
  await fs.writeFile(path.join(locks, "1234.lock"), JSON.stringify({ workspaceFolders: [home] }))
  const channel = socketFixture()
  const editor = new DesktopEditor({ home, env: {}, socket: () => channel.socket })
  try {
    await editor.read(home)
    channel.fire("open")
    channel.fire("message", JSON.stringify({ method: "selection_changed", params: { filePath: "/synthetic.ts", ranges: [{ text: "ok", selection: { start: { line: 1, character: 1 }, end: { line: 1, character: 3 } } }] } }))
    for (const value of ["invalid json", JSON.stringify({ method: "selection_changed", params: { filePath: 3, ranges: [] } }), JSON.stringify({ method: "selection_changed", params: { filePath: "/bad", text: "bad", selection: { start: { line: -1, character: 0 }, end: { line: 1, character: 2 } } } })]) channel.fire("message", value)
    expect((await editor.read(home)).selection?.ranges[0]?.text).toBe("ok")
  } finally { editor.close() }
})

test("Zed selection uses UTF-8 byte ranges, one-based positions and unsaved contents", async () => {
  const home = await root()
  const database = path.join(home, "zed.sqlite")
  const db = new Database(database)
  db.exec("create table workspaces(workspace_id integer, paths text, timestamp text); create table panes(pane_id integer, workspace_id integer, active integer); create table items(item_id integer, pane_id integer, workspace_id integer, active integer, kind text); create table editors(item_id integer, workspace_id integer, buffer_path text, contents text); create table editor_selections(editor_id integer, workspace_id integer, start integer, end integer)")
  db.query("insert into workspaces values(1, ?, '2026-11-15')").run(JSON.stringify([home]))
  db.exec("insert into panes values(1,1,1); insert into items values(1,1,1,1,'Editor'); insert into editor_selections values(1,1,4,8)")
  db.query("insert into editors values(1,1,?,?)").run(path.join(home, "file.ts"), "aé\n🌟z")
  db.close()
  expect(await readZedSelection(database, home)).toMatchObject({ type: "selection", selection: { source: "zed", ranges: [{ text: "🌟", selection: { start: { line: 2, character: 1 }, end: { line: 2, character: 3 } } }] } })
  expect(await readZedSelection(database, `${home}-other`)).toEqual({ type: "empty" })
})

test("missing Zed databases stay unavailable without creating a file", async () => {
  const home = await root()
  const database = path.join(home, "missing.sqlite")
  expect(await readZedSelection(database, home)).toEqual({ type: "unavailable" })
  expect(await fs.stat(database).then(() => true, () => false)).toBe(false)
})

test("external editor prefers VISUAL, preserves quoted arguments, accepts empty edits and removes its tempfile", async () => {
  const home = await root()
  let temporary = ""
  const result = await openDesktopEditor({ text: "draft", directory: home }, {
    env: { VISUAL: '"/synthetic/editor app" --wait', EDITOR: "/ignored" }, temp: home,
    run: async (command, args, cwd) => {
      expect(command).toBe("/synthetic/editor app")
      expect(args[0]).toBe("--wait")
      expect(cwd).toBe(home)
      temporary = args.at(-1)!
      expect((await fs.stat(temporary)).mode & 0o777).toBe(0o600)
      expect(await fs.readFile(temporary, "utf8")).toBe("draft")
      await fs.writeFile(temporary, "")
      return 0
    },
  })
  expect(result).toEqual({ kind: "edited", text: "" })
  expect(await fs.stat(temporary).then(() => true, () => false)).toBe(false)
})

test("missing or failed external editors use the modal fallback without altering the original draft", async () => {
  const home = await root()
  expect(await openDesktopEditor({ text: "preserved", directory: home }, { env: {}, temp: home })).toEqual({ kind: "fallback" })
  expect(await openDesktopEditor({ text: "preserved", directory: home }, { env: { EDITOR: "/synthetic/failure" }, temp: home, run: async () => 2 })).toMatchObject({ kind: "fallback", notice: expect.any(String) })
  expect(await fs.readdir(home)).toEqual([])
})

test("external editor arguments preserve empty quoted values and reject incomplete quoting without a launch", async () => {
  const home = await root()
  let launched = 0
  const run = async (_command: string, args: string[]) => { launched++; expect(args[0]).toBe(""); return 0 }
  expect(await openDesktopEditor({ text: "draft", directory: home }, { env: { EDITOR: '/synthetic/editor ""' }, temp: home, run })).toEqual({ kind: "edited", text: "draft" })
  expect(await openDesktopEditor({ text: "draft", directory: home }, { env: { EDITOR: '/synthetic/editor "unfinished' }, temp: home, run })).toMatchObject({ kind: "fallback" })
  expect(launched).toBe(1)
  expect(await fs.readdir(home)).toEqual([])
})
