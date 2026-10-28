export * as MacOSComputer from "./macos"

import path from "node:path"
import os from "node:os"
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises"
import { createConnection, type Socket } from "node:net"
import { watch } from "node:fs"
import { Effect, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "../process"
import { NativeError, WindowPlacement, type Capability, type ComputerFrame, type NativeSuccess } from "./types"

export interface ItermTarget {
  readonly platform: "macos"
  readonly application: "iterm"
  readonly windowID: number
  readonly tabIndex: number
  readonly sessionID: string
}

export interface FinderTarget {
  readonly platform: "macos"
  readonly application: "finder"
  readonly path: string
}
export interface DesktopTarget {
  readonly platform: "macos"
  readonly application: "desktop"
  readonly bundleID: string
  readonly pid: number
  readonly windowID: number
}

export interface BrowserTarget {
  readonly platform: "macos"
  readonly application: "webbrowser"
  readonly bundleID: "com.apple.Safari" | "com.google.Chrome"
  readonly windowID: string
  readonly tabIndex: number
}

export type BrowserAction =
  | { readonly type: "webbrowser.navigate"; readonly url: string }
  | { readonly type: "webbrowser.back" | "webbrowser.forward" | "webbrowser.reload" | "webbrowser.close_tab" }
  | { readonly type: "webbrowser.new_tab"; readonly url?: string }
  | { readonly type: "webbrowser.eval"; readonly script: string }

export interface BrowserTab {
  readonly index: number
  readonly title: string
  readonly url: string
  readonly active: boolean
}

export interface BrowserWindow {
  readonly window_id: string
  readonly index: number
  readonly revision: string
  readonly tabs: ReadonlyArray<BrowserTab>
}

export type Target = ItermTarget | FinderTarget | DesktopTarget | BrowserTarget

export type Action =
  | { readonly type: "iterm.send_text"; readonly text: string; readonly newline: boolean }
  | { readonly type: "finder.move"; readonly destination: string }
  | { readonly type: "desktop.click"; readonly element: ReadonlyArray<number> }
  | { readonly type: "desktop.click"; readonly x: number; readonly y: number; readonly button?: "left" | "right"; readonly count?: 1 | 2 }
  | { readonly type: "desktop.drag"; readonly fromX: number; readonly fromY: number; readonly toX: number; readonly toY: number }
  | { readonly type: "desktop.type"; readonly element?: ReadonlyArray<number>; readonly text: string }
  | { readonly type: "desktop.scroll"; readonly element: ReadonlyArray<number>; readonly direction: "up" | "down" }
  | { readonly type: "desktop.scroll"; readonly x: number; readonly y: number; readonly deltaX: number; readonly deltaY: number }
  | { readonly type: "desktop.key"; readonly element?: ReadonlyArray<number>; readonly key: string; readonly modifiers?: ReadonlyArray<"command" | "shift" | "option" | "control" | "fn"> }
  | { readonly type: "desktop.select_text"; readonly element: ReadonlyArray<number>; readonly text: string; readonly prefix?: string; readonly suffix?: string; readonly selection?: "text" | "cursor_before" | "cursor_after" }
  | { readonly type: "desktop.perform_action"; readonly element: ReadonlyArray<number>; readonly name: "press" | "confirm" | "increment" | "decrement" | "show_menu" }

interface Owner {
  readonly sessionID: string
  readonly callID: string
}

export type Request =
  | { readonly action: "display.hold"; readonly owner: Owner; readonly controlDirectory: string; readonly ownerPID: number }
  | { readonly action: "webbrowser.tabs"; readonly owner: Owner; readonly bundleID: BrowserTarget["bundleID"] }
  | { readonly action: "webbrowser.navigate"; readonly owner: Owner; readonly target: BrowserTarget; readonly expectedRevision: string; readonly url: string }
  | { readonly action: "webbrowser.back" | "webbrowser.forward" | "webbrowser.reload" | "webbrowser.close_tab"; readonly owner: Owner; readonly target: BrowserTarget; readonly expectedRevision: string }
  | { readonly action: "webbrowser.new_tab"; readonly owner: Owner; readonly target: BrowserTarget; readonly expectedRevision: string; readonly url?: string }
  | { readonly action: "webbrowser.eval"; readonly owner: Owner; readonly target: BrowserTarget; readonly expectedRevision: string; readonly script: string }
  | { readonly action: "desktop.list"; readonly owner: Owner }
  | { readonly action: "desktop.launch"; readonly owner: Owner; readonly bundleID: string; readonly remoteDebugging?: boolean }
  | { readonly action: "desktop.quit"; readonly owner: Owner; readonly bundleID: string; readonly pid: number }
  | { readonly action: "iterm.inspect"; readonly owner: Owner; readonly target: ItermTarget }
  | {
      readonly action: "iterm.send_text"
      readonly owner: Owner
      readonly target: ItermTarget
      readonly expectedRevision: string
      readonly text: string
      readonly newline: boolean
    }
  | { readonly action: "finder.inspect"; readonly owner: Owner; readonly target: FinderTarget }
  | { readonly action: "desktop.inspect" | "desktop.capture"; readonly owner: Owner; readonly target: DesktopTarget }
  | { readonly action: "desktop.stage"; readonly owner: Owner; readonly target: DesktopTarget; readonly expectedRevision: string; readonly displayID: number }
  | { readonly action: "desktop.unstage"; readonly owner: Owner; readonly target: DesktopTarget; readonly originalFrame: ComputerFrame }
  | {
      readonly action: "desktop.click" | "desktop.drag" | "desktop.type" | "desktop.scroll" | "desktop.key" | "desktop.select_text" | "desktop.perform_action" | "desktop.query"
      readonly owner: Owner
      readonly target: DesktopTarget
      readonly expectedRevision: string
      readonly element?: ReadonlyArray<number>
      readonly text?: string
      readonly direction?: "up" | "down"
      readonly key?: string
      readonly modifiers?: ReadonlyArray<"command" | "shift" | "option" | "control" | "fn">
      readonly x?: number
      readonly y?: number
      readonly button?: "left" | "right"
      readonly count?: 1 | 2
      readonly fromX?: number
      readonly fromY?: number
      readonly toX?: number
      readonly toY?: number
      readonly deltaX?: number
      readonly deltaY?: number
      readonly role?: string
      readonly limit?: number
      readonly maxNodes?: number
      readonly prefix?: string
      readonly suffix?: string
      readonly selection?: "text" | "cursor_before" | "cursor_after"
      readonly name?: "press" | "confirm" | "increment" | "decrement" | "show_menu"
    }
  | {
      readonly action: "finder.move"
      readonly owner: Owner
      readonly target: FinderTarget
      readonly destination: string
      readonly expectedRevision: string
    }

export type Success = NativeSuccess<Request["action"]>
export type Invoke = (request: Request, signal: AbortSignal) => Effect.Effect<Success, NativeError>

export const capabilities = [
  {
    platform: "macos",
    application: "iterm",
    identity: { kind: "macos.bundle_id", value: "com.googlecode.iterm2" },
    operations: ["inspect", "send_text"],
  },
  {
    platform: "macos",
    application: "finder",
    identity: { kind: "macos.bundle_id", value: "com.apple.finder" },
    operations: ["inspect", "move"],
  },
  {
    platform: "macos",
    application: "desktop",
    identity: { kind: "macos.bundle_id", value: "explicit-running-app" },
    operations: ["list", "launch", "inspect", "capture", "query", "click", "drag", "type", "scroll", "key", "select_text", "perform_action", "stage", "unstage"],
  },
  {
    platform: "macos",
    application: "webbrowser",
    identity: { kind: "macos.bundle_id", value: "com.apple.Safari,com.google.Chrome" },
    operations: ["tabs", "navigate", "back", "forward", "reload", "new_tab", "close_tab", "eval"],
  },
] as const satisfies ReadonlyArray<Capability>

export const targetKey = (target: Target) =>
  target.application === "iterm"
    ? `${target.platform}\0${target.application}\0${target.windowID}\0${target.tabIndex}\0${target.sessionID}`
    : target.application === "finder"
      ? `${target.platform}\0${target.application}\0${target.path}`
      : target.application === "webbrowser"
        ? `${target.platform}\0${target.application}\0${target.bundleID}\0${target.windowID}`
        : `${target.platform}\0${target.application}\0${target.bundleID}\0${target.pid}\0${target.windowID}`

export const identity = (target: Target) => {
  if (target.application === "iterm") return capabilities[0].identity
  if (target.application === "finder") return capabilities[1].identity
  return { kind: "macos.bundle_id", value: target.bundleID }
}

export const matches = (target: Target, action: Action) =>
  (target.application === "iterm" && action.type === "iterm.send_text") ||
  (target.application === "finder" && action.type === "finder.move") ||
  (target.application === "desktop" && action.type.startsWith("desktop."))

export const browserTabsRequest = (owner: Owner, bundleID: BrowserTarget["bundleID"]): Request => ({
  action: "webbrowser.tabs",
  owner,
  bundleID,
})

export const browserActionRequest = (
  owner: Owner,
  target: BrowserTarget,
  expectedRevision: string,
  action: BrowserAction,
): Request => {
  if (action.type === "webbrowser.navigate") return { action: action.type, url: action.url, owner, target, expectedRevision }
  if (action.type === "webbrowser.new_tab") return { action: action.type, url: action.url, owner, target, expectedRevision }
  if (action.type === "webbrowser.eval") return { action: action.type, script: action.script, owner, target, expectedRevision }
  return { action: action.type, owner, target, expectedRevision }
}

export const inspectRequest = (owner: Owner, target: Target): Request =>
  target.application === "iterm"
    ? { action: "iterm.inspect", owner, target }
    : target.application === "finder"
      ? { action: "finder.inspect", owner, target }
      : target.application === "desktop"
        ? { action: "desktop.inspect", owner, target }
        : browserTabsRequest(owner, target.bundleID)

export const captureRequest = (owner: Owner, target: DesktopTarget): Request => ({
  action: "desktop.capture",
  owner,
  target,
})

export const queryRequest = (
  owner: Owner,
  target: DesktopTarget,
  expectedRevision: string,
  query: { readonly text?: string; readonly role?: string; readonly limit?: number; readonly maxNodes?: number },
): Request => ({ action: "desktop.query", owner, target, expectedRevision, text: query.text, role: query.role, limit: query.limit, maxNodes: query.maxNodes })

export const listRequest = (owner: Owner): Request => ({ action: "desktop.list", owner })
export const launchRequest = (owner: Owner, bundleID: string, remoteDebugging?: boolean): Request => ({ action: "desktop.launch", owner, bundleID, remoteDebugging })
export const quitRequest = (owner: Owner, bundleID: string, pid: number): Request => ({ action: "desktop.quit", owner, bundleID, pid })
export const displayHoldRequest = (owner: Owner, controlDirectory: string, ownerPID: number): Request => ({ action: "display.hold", owner, controlDirectory, ownerPID })
export const stageRequest = (owner: Owner, target: DesktopTarget, expectedRevision: string, displayID: number): Request => ({ action: "desktop.stage", owner, target, expectedRevision, displayID })
export const unstageRequest = (owner: Owner, target: DesktopTarget, originalFrame: ComputerFrame): Request => ({ action: "desktop.unstage", owner, target, originalFrame })

export function actionRequest(
  owner: Owner,
  target: Target,
  expectedRevision: string,
  action: Action,
): Request | undefined {
  if (target.application === "iterm" && action.type === "iterm.send_text")
    return {
      action: action.type,
      owner,
      target,
      expectedRevision,
      text: action.text,
      newline: action.newline,
    }
  if (target.application === "finder" && action.type === "finder.move")
    return {
      action: action.type,
      owner,
      target,
      expectedRevision,
      destination: action.destination,
    }
  if (
    target.application === "desktop" &&
    (action.type === "desktop.click" ||
      action.type === "desktop.type" ||
      action.type === "desktop.scroll" ||
      action.type === "desktop.drag" ||
      action.type === "desktop.key" ||
      action.type === "desktop.select_text" ||
      action.type === "desktop.perform_action")
  )
    return { action: action.type, owner, target, expectedRevision, ...action }
  return undefined
}

function bridgeAction(request: Request): Action | undefined {
  if (request.action === "desktop.click")
    return request.element ? { type: "desktop.click", element: request.element }
      : request.x !== undefined && request.y !== undefined
        ? { type: "desktop.click", x: request.x, y: request.y, button: request.button, count: request.count } : undefined
  if (request.action === "desktop.drag")
    return request.fromX !== undefined && request.fromY !== undefined && request.toX !== undefined && request.toY !== undefined
      ? { type: "desktop.drag", fromX: request.fromX, fromY: request.fromY, toX: request.toX, toY: request.toY } : undefined
  if (request.action === "desktop.scroll")
    return request.element && request.direction ? { type: "desktop.scroll", element: request.element, direction: request.direction }
      : request.x !== undefined && request.y !== undefined && request.deltaX !== undefined && request.deltaY !== undefined
        ? { type: "desktop.scroll", x: request.x, y: request.y, deltaX: request.deltaX, deltaY: request.deltaY } : undefined
  if (request.action === "desktop.type") return request.text === undefined ? undefined : { type: "desktop.type", text: request.text, element: request.element }
  if (request.action === "desktop.key") return request.key === undefined ? undefined : { type: "desktop.key", key: request.key, modifiers: request.modifiers, element: request.element }
  return undefined
}

export const helperBinary = "ycoding-computer-use"
// macOS privacy settings display an app bundle by its filename.
export const helperApplication = "YCoding Computer Use.app"
export const applicationPath = (executable = process.execPath) =>
  path.parse(executable).name === "bun"
    ? path.resolve(import.meta.dir, "../../.cache/computer-use", helperApplication)
    : path.join(path.dirname(executable), helperApplication)

const Response = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ok"),
    action: Schema.Literals([
      "iterm.inspect",
      "iterm.send_text",
      "finder.inspect",
      "finder.move",
      "desktop.inspect",
      "desktop.list",
      "desktop.launch",
      "desktop.quit",
      "desktop.capture",
      "desktop.click",
      "desktop.drag",
      "desktop.type",
      "desktop.scroll",
      "desktop.key",
      "desktop.stage", "desktop.unstage", "desktop.query", "desktop.select_text", "desktop.perform_action", "display.hold",
      "webbrowser.tabs", "webbrowser.navigate", "webbrowser.back", "webbrowser.forward", "webbrowser.reload", "webbrowser.new_tab", "webbrowser.close_tab", "webbrowser.eval",
    ]),
    revision: Schema.String,
    accessible: Schema.Boolean.pipe(Schema.optional),
    effect: Schema.Literals(["changed", "unchanged", "unverified"]).pipe(Schema.optional),
    elements: Schema.Array(Schema.Struct({ path: Schema.Array(Schema.Int), role: Schema.String, label: Schema.String,
      frame: Schema.Tuple([Schema.Number, Schema.Number, Schema.Number, Schema.Number]),
      actions: Schema.Array(Schema.Literals(["press", "confirm", "increment", "decrement", "show_menu"])),
      enabled: Schema.Boolean, focused: Schema.Boolean, value: Schema.String.pipe(Schema.optional),
    })).pipe(Schema.optional),
    image: Schema.String.pipe(Schema.optional),
    width: Schema.Number.pipe(Schema.optional), height: Schema.Number.pipe(Schema.optional), scale: Schema.Number.pipe(Schema.optional),
    apps: Schema.Array(Schema.Struct({ bundle_id: Schema.String, pid: Schema.Int, name: Schema.String,
      is_active: Schema.Boolean, is_hidden: Schema.Boolean,
      is_running: Schema.Boolean.pipe(Schema.optional), last_used: Schema.String.pipe(Schema.optional), uses: Schema.Number.pipe(Schema.optional),
      windows: Schema.Array(Schema.Struct({ window_id: Schema.Int, title: Schema.String,
        bounds: Schema.Struct({ x: Schema.Number, y: Schema.Number, width: Schema.Number, height: Schema.Number }), on_screen: Schema.Boolean, placement: WindowPlacement })),
    })).pipe(Schema.optional),
    pid: Schema.Int.pipe(Schema.optional),
    windows: Schema.Array(Schema.Struct({ window_id: Schema.Int, title: Schema.String,
      bounds: Schema.Struct({ x: Schema.Number, y: Schema.Number, width: Schema.Number, height: Schema.Number }), on_screen: Schema.Boolean, placement: WindowPlacement })).pipe(Schema.optional),
    exited: Schema.Boolean.pipe(Schema.optional),
    browserWindows: Schema.Array(Schema.Struct({ window_id: Schema.String, index: Schema.Int, revision: Schema.String,
      tabs: Schema.Array(Schema.Struct({ index: Schema.Int, title: Schema.String, url: Schema.String, active: Schema.Boolean })) })).pipe(Schema.optional),
    tabIndex: Schema.Int.pipe(Schema.optional),
    value: Schema.String.pipe(Schema.optional),
    truncated: Schema.Boolean.pipe(Schema.optional),
    display: Schema.Struct({ id: Schema.Int, x: Schema.Number, y: Schema.Number, width: Schema.Number, height: Schema.Number }).pipe(Schema.optional),
    originalFrame: Schema.Struct({ x: Schema.Number, y: Schema.Number, width: Schema.Number, height: Schema.Number }).pipe(Schema.optional),
  }),
  Schema.Struct({
    status: Schema.Literal("error"),
    code: NativeError.fields.code,
    message: Schema.String,
    outcome: NativeError.fields.outcome,
  }),
])

const apiVersion = 1
const maxFrame = 8 * 1024 * 1024

function frame(value: unknown) {
  const body = Buffer.from(JSON.stringify(value))
  if (body.length > maxFrame) throw new Error("Native helper request exceeds the frame limit")
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length)
  return Buffer.concat([header, body])
}

function connection(socket: Socket, onTimeout: () => void) {
  let buffer = Buffer.alloc(0)
  let nextID = 0
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const close = (error: Error) => {
    for (const call of pending.values()) call.reject(error)
    pending.clear()
    socket.destroy()
  }
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0)
      if (!length || length > maxFrame) return close(new Error("Invalid native helper frame length"))
      if (buffer.length < length + 4) return
      const body = buffer.subarray(4, length + 4)
      buffer = buffer.subarray(length + 4)
      try {
        const message: unknown = JSON.parse(body.toString("utf8"))
        if (!message || typeof message !== "object" || !("id" in message) || typeof message.id !== "number" || !("jsonrpc" in message) || message.jsonrpc !== "2.0")
          throw new Error("Invalid native helper response")
        const call = pending.get(message.id)
        if (!call) throw new Error("Unexpected native helper response")
        pending.delete(message.id)
        if ("error" in message) {
          const error = message.error
          if (!error || typeof error !== "object" || !("message" in error) || typeof error.message !== "string") throw new Error("Invalid native helper error")
          call.reject(new Error(error.message))
          continue
        }
        if (!("result" in message)) throw new Error("Invalid native helper response")
        call.resolve(message.result)
      } catch (error) { return close(error instanceof Error ? error : new Error("Invalid native helper response")) }
    }
  })
  socket.on("error", close)
  socket.on("close", () => close(new Error("Native helper connection closed")))
  return {
    socket,
    close,
    send(method: string, params: unknown, timeout = 30_000): Promise<unknown> {
      if (socket.destroyed) return Promise.reject(new Error("Native helper connection closed"))
      const id = ++nextID
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { close(new Error("Native helper call timed out")); onTimeout() }, timeout)
        pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value) }, reject: (error) => { clearTimeout(timer); reject(error) } })
        try { socket.write(frame({ jsonrpc: "2.0", id, method, params })) }
        catch (error) { close(error instanceof Error ? error : new Error("Native helper write failed")) }
      })
    },
  }
}

async function connect(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    socket.once("connect", () => { socket.removeAllListeners("error"); resolve(socket) })
    socket.once("error", reject)
  })
}

export function invokeWith(
  processes: AppProcess.Interface,
  platform: NodeJS.Platform = process.platform,
  application = applicationPath(),
) {
  let directory: string | undefined
  let service: ReturnType<typeof connection> | undefined
  let starting: Promise<ReturnType<typeof connection>> | undefined
  let stopping: Promise<void> | undefined
  let chain = Promise.resolve()
  const stop = async () => {
    const current = service
    service = undefined
    if (current && !current.socket.destroyed) await current.send("shutdown", {}, 1000).catch(() => undefined)
    current?.close(new Error("Native helper stopped"))
    if (directory) {
      await rm(directory, { recursive: true, force: true })
      directory = undefined
    }
  }
  const terminate = async () => {
    if (directory) {
      const pid = Number(await readFile(path.join(directory, "pid"), "utf8").catch(() => ""))
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, "SIGTERM") } catch {}
      }
    }
    await stop()
  }
  const launch = async () => {
    if (!directory) directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-computer-"))
    const handoff = path.join(directory, "service.json")
    await writeFile(handoff, JSON.stringify({ action: "service", controlDirectory: directory, ownerPID: process.pid }), { mode: 0o600 })
    await Effect.runPromise(processes.run(ChildProcess.make("/usr/bin/open", ["-n", "-g", "-a", application, "--args", handoff]),
      { timeout: "10 seconds", maxOutputBytes: 1024, maxErrorBytes: 1024 }).pipe(Effect.flatMap(AppProcess.requireSuccess)))
  }
  const ready = async () => {
    if (service && !service.socket.destroyed) return service
    if (starting) return starting
    starting = (async () => {
      if (stopping) await stopping
      if (!directory) directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-computer-"))
      let socket = await connect(path.join(directory, "computer-use.sock")).catch(() => undefined)
      if (!socket) {
        if (service?.socket.destroyed) await terminate()
        await launch()
        const deadline = Date.now() + 5000
        while (!socket && Date.now() < deadline) {
          await Bun.sleep(100)
          socket = await connect(path.join(directory, "computer-use.sock")).catch(() => undefined)
        }
      }
      if (!socket) throw new Error("Native helper did not start within five seconds")
      const candidate = connection(socket, () => { stopping = terminate(); void stopping.catch(() => undefined) })
      try {
        const ping = await candidate.send("ping", { clientApiVersion: apiVersion }, 1000)
        if (!ping || typeof ping !== "object" || !("serverApiVersion" in ping) || ping.serverApiVersion !== apiVersion)
          throw new Error("Native helper API version mismatch")
      } catch (error) {
        candidate.close(new Error("Native helper handshake failed"))
        await terminate()
        throw error
      }
      service = candidate
      return candidate
    })().finally(() => { starting = undefined })
    return starting
  }
  const invoke: Invoke = (request, signal) => {
    if (platform !== "darwin") return Effect.fail(new NativeError({ code: "unsupported_platform", message: `Native computer use has no provider for ${platform}`, outcome: "not_started" }))
    if (request.action === "display.hold") return Effect.tryPromise({
      try: async () => {
        const handoff = await mkdtemp(path.join(os.tmpdir(), "ycoding-computer-"))
        try {
          await writeFile(path.join(handoff, "request.json"), JSON.stringify(request), { mode: 0o600 })
          await Effect.runPromise(processes.run(ChildProcess.make("/usr/bin/open", ["-n", "-g", "-a", application, "--args", path.join(handoff, "request.json"), path.join(handoff, "response.json")]),
            { timeout: "10 seconds", maxOutputBytes: 1024, maxErrorBytes: 1024 }).pipe(Effect.flatMap(AppProcess.requireSuccess)))
          return Schema.decodeUnknownSync(Schema.fromJsonString(Response))(await awaitResponse(handoff))
        } finally { await rm(handoff, { recursive: true, force: true }) }
      },
      catch: () => new NativeError({ code: "background_unavailable", message: "Agent display helper is unavailable", outcome: "not_started" }),
    }).pipe(Effect.flatMap((response) => response.status === "ok" && response.action === request.action
      ? Effect.succeed(response)
      : Effect.fail(new NativeError(response.status === "error"
        ? { code: response.code, message: response.message, outcome: response.outcome }
        : { code: "invalid_response", message: "Agent display helper returned a mismatched action", outcome: "unknown" }))))
    const mutating = request.action === "iterm.send_text" || request.action === "finder.move" || request.action === "desktop.launch" || request.action === "desktop.quit" ||
      request.action.startsWith("webbrowser.") && request.action !== "webbrowser.tabs" ||
      request.action.startsWith("desktop.") && !["desktop.inspect", "desktop.capture", "desktop.list", "desktop.query"].includes(request.action)
    return Effect.uninterruptible(Effect.suspend(() => {
      const work = chain.then(async () => {
        if (signal.aborted) throw new Error("Native helper call cancelled")
        const current = await ready()
        const raw = await current.send("request", { deadlineUnixMilliseconds: Date.now() + 30_000, request })
        return Schema.decodeUnknownSync(Response)(raw)
      })
      chain = work.then(() => undefined, () => undefined)
      return Effect.tryPromise({ try: () => work, catch: () => new NativeError({
        code: mutating ? "unknown_outcome" : "helper_unavailable",
        message: mutating ? "Native helper settlement is unknown; inspect the target before any further mutation" : "Native computer helper is unavailable or returned invalid output",
        outcome: mutating ? "unknown" : "not_started",
      }) }).pipe(Effect.flatMap((response) => response.status === "ok"
        ? response.action === request.action ? Effect.succeed(response) : Effect.fail(new NativeError({ code: "invalid_response", message: "Native computer helper returned a mismatched action", outcome: "unknown" }))
        : Effect.fail(new NativeError({ code: response.code, message: response.message, outcome: response.outcome }))))
    }))
  }
  return Object.assign(invoke, { shutdown: () => Effect.promise(() => chain.then(stop)) })
}

export function invokeWithBridge(processes: AppProcess.Interface, platform: NodeJS.Platform = process.platform, application = applicationPath(), electron?: ReturnType<typeof import("./electron").make>): ReturnType<typeof invokeWith> {
  const native = invokeWith(processes, platform, application)
  return Object.assign((request: Request, signal: AbortSignal) => {
    if (platform !== "darwin" || !request.action.startsWith("desktop.")) return native(request, signal)
    if (request.action === "desktop.list" || request.action === "desktop.inspect" || request.action === "desktop.quit") return native(request, signal)
    return Effect.gen(function* () {
      const { ElectronComputer } = yield* Effect.promise(() => import("./electron"))
      const bridge = electron ?? ElectronComputer.make()
      if (request.action === "desktop.launch") {
        if (!request.remoteDebugging) return yield* native(request, signal)
        const listed = yield* native({ action: "desktop.list", owner: request.owner }, signal)
        const existing = listed.apps?.find((app) => app.bundle_id === request.bundleID)
        if (existing) {
          const active = yield* Effect.promise(() => bridge.ownedEndpoint(existing.pid))
          if (active?.targets.some((entry) => entry.type === "page"))
            return yield* native({ ...request, remoteDebugging: false }, signal)
        }
        const launched = yield* native(request, signal)
        if (launched.pid === undefined) return yield* new NativeError({ code: "unknown_outcome", message: "Electron relaunch returned no PID", outcome: "unknown" })
        const ready = yield* Effect.promise(async () => {
          const deadline = Date.now() + 3000
          while (Date.now() < deadline) {
            if ((await bridge.ownedEndpoint(launched.pid!))?.targets.some((entry) => entry.type === "page")) return true
            await Bun.sleep(50)
          }
          return false
        })
        if (!ready) return yield* new NativeError({ code: "unknown_outcome", message: "Electron relaunch did not expose a PID-owned renderer endpoint", outcome: "unknown" })
        return launched
      }
      if (request.action === "desktop.capture" || request.action === "desktop.click" || request.action === "desktop.drag" ||
          request.action === "desktop.scroll" || request.action === "desktop.type" || request.action === "desktop.key") {
        if ("element" in request && request.element) return yield* native(request, signal)
        if (!(yield* Effect.promise(() => bridge.isElectron(request.target.pid)))) return yield* native(request, signal)
        const listed = yield* native({ action: "desktop.list", owner: request.owner }, signal)
        const target = request.target
        const window = listed.apps?.find((app) => app.pid === target.pid && app.bundle_id === target.bundleID)?.windows.find((item) => item.window_id === target.windowID)
        if (!window) return yield* new NativeError({ code: "target_not_found", message: "Exact Core Graphics window is unavailable", outcome: "not_started" })
        if ("expectedRevision" in request) {
          const before = yield* native({ action: "desktop.inspect", owner: request.owner, target }, signal)
          if (before.revision !== request.expectedRevision)
            return yield* new NativeError({ code: "stale_revision", message: "Target state changed; inspect again", outcome: "not_started" })
        }
        const action = bridgeAction(request)
        if (request.action !== "desktop.capture" && !action)
          return yield* new NativeError({ code: "invalid_request", message: "Invalid Electron desktop action", outcome: "not_started" })
        const operation = request.action === "desktop.capture" ? { type: "capture" as const }
          : { type: "action" as const, action: action! }
        const performed = yield* Effect.tryPromise({
          try: () => bridge.perform(target, window, operation, signal),
          catch: (cause) => cause instanceof NativeError ? cause : new NativeError({
            code: operation.type === "action" ? "unknown_outcome" : "native_failure",
            message: "Electron bridge failed; inspect before retrying", outcome: operation.type === "action" ? "unknown" : "not_started",
          }),
        })
        if (performed) {
          if (performed.type === "capture") {
            const inspected = yield* native({ action: "desktop.inspect", owner: request.owner, target }, signal)
            return { status: "ok" as const, action: request.action, revision: inspected.revision,
              image: performed.image, width: performed.width, height: performed.height, scale: performed.scale }
          }
          const inspected = yield* native({ action: "desktop.inspect", owner: request.owner, target }, signal)
          if (request.action === "desktop.capture") return yield* new NativeError({ code: "invalid_response", message: "Electron bridge returned an action for capture", outcome: "unknown" })
          return { status: "ok" as const, action: request.action, revision: inspected.revision, effect: performed.effect }
        }
        return yield* new NativeError({ code: "background_unavailable", message: "Electron bridge route is unavailable for this window; use an Accessibility element route or stage it on the agent display", outcome: "not_started" })
      }
      return yield* native(request, signal)
    })
  }, { shutdown: native.shutdown })
}

function awaitResponse(directory: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const responsePath = path.join(directory, "response.json")
    const observer = watch(directory, (_event, filename) => {
      if (filename === "response.json") void read()
    })
    const timer = setTimeout(() => settle(new Error("Native helper did not settle within 30 seconds")), 30_000)
    let completed = false
    const settle = (result: string | Error) => {
      if (completed) return
      completed = true
      observer.close()
      clearTimeout(timer)
      if (result instanceof Error) reject(result)
      else resolve(result)
    }
    observer.on("error", settle)
    const read = async () => {
      try {
        const response = await open(responsePath, "r")
        try {
          const buffer = Buffer.alloc(2 * 1024 * 1024 + 1)
          const { bytesRead } = await response.read(buffer, 0, buffer.length, 0)
          settle(
            bytesRead > 2 * 1024 * 1024
              ? new Error("Native helper response exceeds the output limit")
              : buffer.subarray(0, bytesRead).toString("utf8"),
          )
        } finally {
          await response.close()
        }
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return
        settle(error instanceof Error ? error : new Error("Native helper response could not be read"))
      }
    }
    void read()
  })
}
