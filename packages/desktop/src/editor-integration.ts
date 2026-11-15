import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { readZedSelection, workspaceScore } from "./editor-zed"

export type EditorSelection = {
  filePath: string
  source: "websocket" | "zed"
  ranges: { text: string; selection: { start: { line: number; character: number }; end: { line: number; character: number } } }[]
}
export type EditorSnapshot = { status: "disabled" | "connecting" | "connected" | "error"; selection?: EditorSelection; notice?: string }
export type EditorSocket = {
  readonly readyState: number
  send: (data: string) => void
  close: () => void
  addEventListener: (name: string, listener: (event: { data?: unknown }) => void) => void
}
type EditorConnection = { url: string; authToken?: string; mtime: number; score: number }
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

function openSocket(url: string, headers: Record<string, string>): EditorSocket {
  const NativeSocket = WebSocket as typeof WebSocket & { new (url: string, options: { headers: Record<string, string> }): WebSocket }
  const socket = new NativeSocket(url, { headers })
  return {
    get readyState() { return socket.readyState },
    send: (data) => socket.send(data),
    close: () => socket.close(),
    addEventListener: (name, listener) => socket.addEventListener(name, (event) => listener({ data: "data" in event ? event.data : undefined })),
  }
}

export async function discoverEditor(directory: string, home = os.homedir()): Promise<EditorConnection | undefined> {
  const root = path.join(home, ".claude", "ide")
  const entries = await fs.readdir(root).catch(() => [])
  const connections = await Promise.all(entries.filter((entry) => /^\d+\.lock$/.test(entry)).map(async (entry) => {
    const port = Number(entry.slice(0, -5))
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return
    try {
      const file = path.join(root, entry)
      if ((await fs.stat(file)).size > 64 * 1024) return
      const data: unknown = JSON.parse(await fs.readFile(file, "utf8"))
      if (!record(data) || (data.transport !== undefined && data.transport !== "ws") || !Array.isArray(data.workspaceFolders)) return
      const score = Math.max(0, ...data.workspaceFolders.filter((item): item is string => typeof item === "string").map((folder) => workspaceScore(folder, directory)))
      if (!score || (data.authToken !== undefined && (typeof data.authToken !== "string" || data.authToken.length > 8192))) return
      return { url: `ws://127.0.0.1:${port}`, authToken: data.authToken as string | undefined, score, mtime: (await fs.stat(file)).mtimeMs }
    } catch { return }
  }))
  return connections.filter((item) => item !== undefined).sort((a, b) => b.score - a.score || b.mtime - a.mtime)[0]
}

function selectionOf(value: unknown): EditorSelection | undefined {
  if (!record(value) || typeof value.filePath !== "string" || !path.isAbsolute(value.filePath)) return
  const ranges = Array.isArray(value.ranges) ? value.ranges : [{ text: value.text, selection: value.selection }]
  const position = (point: unknown) => record(point) && Number.isSafeInteger(point.line) && Number(point.line) >= 0 && Number.isSafeInteger(point.character) && Number(point.character) >= 0
  if (!ranges.length || ranges.length > 1024 || !ranges.every((range) => record(range) && typeof range.text === "string" && record(range.selection) && position(range.selection.start) && position(range.selection.end))) return
  if (ranges.reduce((size, range) => size + new TextEncoder().encode(range.text).length, 0) > 1024 * 1024) return
  return { filePath: value.filePath, source: "websocket", ranges }
}

export class DesktopEditor {
  private connection?: EditorConnection & { socket: EditorSocket; ended: boolean }
  private directory?: string
  private revision = 0
  private snapshot: EditorSnapshot = { status: "disabled" }

  constructor(private readonly options: { home?: string; env?: NodeJS.ProcessEnv; socket?: (url: string, headers: Record<string, string>) => EditorSocket } = {}) {}

  async read(directory: string): Promise<EditorSnapshot> {
    if (!path.isAbsolute(directory)) throw new Error("Editor context requires an absolute directory.")
    const revision = ++this.revision
    const connection = await discoverEditor(directory, this.options.home)
    if (revision !== this.revision) return { status: "disabled" }
    if (directory !== this.directory) {
      this.closeSocket()
      this.directory = directory
      this.snapshot = { status: "disabled" }
    }
    if (connection) {
      if (!this.connection || this.connection.ended || this.connection.url !== connection.url || this.connection.authToken !== connection.authToken) {
        this.closeSocket()
        this.snapshot = { status: "connecting" }
        const headers: Record<string, string> = connection.authToken ? { "x-claude-code-ide-authorization": connection.authToken } : {}
        try {
          const socket = (this.options.socket ?? openSocket)(connection.url, headers)
          const current = { ...connection, socket, ended: false }
          this.connection = current
          const active = () => this.connection === current
          socket.addEventListener("open", () => {
            if (!active()) return
            this.snapshot = { ...this.snapshot, status: "connected" }
            socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "ycoding", version: "0.0.0" } } }))
          })
          socket.addEventListener("message", (event) => {
            if (!active() || typeof event.data !== "string" || event.data.length > 2 * 1024 * 1024) return
            let message: unknown
            try { message = JSON.parse(event.data) } catch { return }
            if (!record(message)) return
            if (message.id === 1 && record(message.result)) socket.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))
            if (message.method === "ide_connected") this.snapshot = { ...this.snapshot, status: "connected" }
            if (message.method !== "selection_changed") return
            const selection = selectionOf(message.params)
            if (selection) this.snapshot = { status: "connected", selection }
          })
          socket.addEventListener("close", () => { if (active()) { current.ended = true; this.snapshot = { status: "connecting" } } })
          socket.addEventListener("error", () => { if (active()) { current.ended = true; this.snapshot = { status: "error", notice: "The IDE connection failed. Reopen the IDE connection to retry." } } })
        } catch { this.snapshot = { status: "error", notice: "The IDE connection could not be opened." } }
      }
      return this.snapshot
    }
    this.closeSocket()
    const home = this.options.home ?? os.homedir()
    const env = this.options.env ?? process.env
    const candidates = [env.YCODING_ZED_DB, path.join(home, "Library", "Application Support", "Zed", "db", "0-stable", "db.sqlite"), path.join(home, ".local", "share", "zed", "db", "0-stable", "db.sqlite")].filter((file): file is string => !!file)
    for (const candidate of candidates) {
      const result = await readZedSelection(candidate, directory)
      if (revision !== this.revision) return { status: "disabled" }
      if (result.type === "selection") return this.snapshot = { status: "connected", selection: result.selection }
      if (result.type === "empty") return this.snapshot = { status: "disabled" }
    }
    return this.snapshot.selection?.source === "zed" ? this.snapshot : { status: "disabled" }
  }

  private closeSocket() {
    const current = this.connection
    this.connection = undefined
    current?.socket.close()
  }

  close() {
    this.revision++
    this.closeSocket()
    this.directory = undefined
    this.snapshot = { status: "disabled" }
  }
}

export type DraftEditorResult = { kind: "edited"; text: string } | { kind: "fallback"; notice?: string }

function editorArguments(command: string) {
  const parts: string[] = []
  let value = ""
  let quote = ""
  let escaped = false
  let started = false
  for (const character of command) {
    if (escaped) { value += character; escaped = false; continue }
    if (character === "\\" && quote !== "'") { escaped = true; started = true; continue }
    if (quote) { if (character === quote) quote = ""; else value += character; continue }
    if (character === "'" || character === '"') { quote = character; started = true; continue }
    if (/\s/.test(character)) { if (started) { parts.push(value); value = ""; started = false }; continue }
    started = true
    value += character
  }
  if (quote || escaped) throw new Error("Invalid editor command.")
  if (started) parts.push(value)
  if (!parts[0]) throw new Error("Missing editor command.")
  return parts
}

export async function openDesktopEditor(input: { text: string; directory: string }, options: { env?: NodeJS.ProcessEnv; temp?: string; run?: (command: string, args: string[], cwd: string) => Promise<number> } = {}): Promise<DraftEditorResult> {
  const env = options.env ?? process.env
  const command = env.VISUAL || env.EDITOR
  if (!command) return { kind: "fallback" }
  let directory: string | undefined
  try {
    if (!path.isAbsolute(input.directory) || new TextEncoder().encode(input.text).length > 1024 * 1024) throw new Error("Invalid draft.")
    const [executable, ...args] = editorArguments(command)
    directory = await fs.mkdtemp(path.join(options.temp ?? os.tmpdir(), "ycoding-draft-"))
    const file = path.join(directory, "draft.md")
    await fs.writeFile(file, input.text, { mode: 0o600 })
    const status = await (options.run ?? ((executable, args, cwd) => new Promise<number>((resolve, reject) => {
      const child = spawn(executable, args, { cwd, env, stdio: "ignore" })
      child.once("error", reject)
      child.once("exit", (code) => resolve(code ?? -1))
    })))(executable!, [...args, file], input.directory)
    if (status !== 0 || (await fs.stat(file)).size > 1024 * 1024) throw new Error("Editor did not finish successfully.")
    return { kind: "edited", text: await fs.readFile(file, "utf8") }
  } catch { return { kind: "fallback", notice: "The external editor could not complete. Continue editing in the draft dialog." } }
  finally { if (directory) await fs.rm(directory, { recursive: true, force: true }) }
}
