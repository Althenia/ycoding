export * as ElectronComputer from "./electron"

import path from "node:path"
import { NativeError, type WindowInfo } from "./types"
import type { MacOSComputer } from "./macos"

export type Rect = WindowInfo["bounds"]
export type Operation = { readonly type: "capture" } | { readonly type: "action"; readonly action: MacOSComputer.Action }
type BridgeResult =
  | { readonly type: "capture"; readonly image: string; readonly width: number; readonly height: number; readonly scale: number }
  | { readonly type: "action"; readonly effect: "changed" | "unchanged" }

export interface Runtime {
  readonly appPath: (pid: number) => Promise<string | undefined>
  readonly fuseBytes: (appPath: string) => Promise<Uint8Array>
  readonly ownedPorts: (pid: number) => Promise<ReadonlyArray<number>>
  readonly signal: (pid: number) => Promise<void>
  readonly sleep: (milliseconds: number) => Promise<void>
  readonly frameworkExists?: (appPath: string) => Promise<boolean>
}

const sentinel = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX")
const unavailable = () => new NativeError({ code: "background_unavailable", message: "No owned Electron debug route is available", outcome: "not_started" })
const missing = () => new NativeError({ code: "target_not_found", message: "No exact Electron window matches the Core Graphics window", outcome: "not_started" })
const namedKeys: Record<string, string> = { enter: "Enter", return: "Enter", tab: "Tab", escape: "Escape", space: " ",
  delete: "Backspace", forward_delete: "Delete", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft",
  right: "ArrowRight", page_up: "PageUp", page_down: "PageDown", home: "Home", end: "End" }
const keyName = (key: string) => namedKeys[key]
  ?? (key.startsWith("f") && /^f(?:[1-9]|1[0-2])$/.test(key) ? key.toUpperCase() : key)
const field = (value: unknown, name: string): unknown =>
  value && typeof value === "object" ? Reflect.get(value, name) : undefined

async function pagePlacement(cdp: CDP) {
  const value = await cdp.evaluate("({screenX,screenY,outerWidth,outerHeight,innerWidth,innerHeight})")
  const [x, y, outerWidth, outerHeight, innerWidth, innerHeight] = ["screenX", "screenY", "outerWidth", "outerHeight", "innerWidth", "innerHeight"]
    .map((name) => field(value, name)).map((part) => typeof part === "number" && Number.isFinite(part) ? part : Number.NaN)
  if (![x, y, outerWidth, outerHeight, innerWidth, innerHeight].every((part) => Number.isFinite(part))) return undefined
  return { bounds: { x, y, width: outerWidth, height: outerHeight },
    content: { x: x + (outerWidth - innerWidth) / 2, y: y + outerHeight - innerHeight, width: innerWidth, height: innerHeight } }
}

export function inspectFuse(bytes: Uint8Array): "on" | "off" | "removed" | "absent" {
  const buffer = Buffer.from(bytes)
  const index = buffer.indexOf(sentinel)
  const start = index + sentinel.length
  if (index < 0 || start + 2 > buffer.length || buffer[start] !== 1 || start + 2 + buffer[start + 1] > buffer.length || buffer[start + 1] < 4) return "absent"
  const fuse = buffer[start + 2 + 3]
  return fuse === 49 ? "on" : fuse === 48 ? "off" : fuse === 114 ? "removed" : "absent"
}

export function mediaSourceWindow(source: string, windowID: number) {
  return source === `window:${windowID}:0`
}

export function contentPoint(bounds: Rect, content: Rect, scale: number, x: number, y: number) {
  const point = { x: x / scale - (content.x - bounds.x), y: y / scale - (content.y - bounds.y) }
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x >= content.width || point.y >= content.height)
    throw new NativeError({ code: "invalid_request", message: "Pixel coordinate is outside the target content area", outcome: "not_started" })
  return point
}

const live: Runtime = {
  appPath: async (pid) => {
    const output = Bun.spawnSync(["/bin/ps", "-o", "comm=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" })
    if (output.exitCode !== 0) return undefined
    const command = output.stdout.toString().trim()
    const end = command.indexOf(".app/")
    return end < 0 ? undefined : command.slice(0, end + 4)
  },
  fuseBytes: async (appPath) => {
    const file = Bun.file(path.join(appPath, "Contents/Frameworks/Electron Framework.framework/Electron Framework"))
    if (file.size > 512 * 1024 * 1024) throw unavailable()
    return new Uint8Array(await file.arrayBuffer())
  },
  ownedPorts: async (pid) => {
    const output = Bun.spawnSync(["/usr/sbin/lsof", "-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN"], { stdout: "pipe", stderr: "ignore" })
    return output.exitCode !== 0 ? [] : Array.from(output.stdout.toString().matchAll(/127\.0\.0\.1:(\d+)\s+\(LISTEN\)/g), (match) => Number(match[1]))
  },
  signal: async (pid) => { process.kill(pid, "SIGUSR1") },
  sleep: (milliseconds) => Bun.sleep(milliseconds),
}

interface Endpoint { readonly port: number; readonly targets: ReadonlyArray<{ readonly type: string; readonly id?: string; readonly title?: string; readonly webSocketDebuggerUrl: string }> }

async function endpoint(port: number): Promise<Endpoint | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(800), redirect: "error" })
    if (!response.ok) return undefined
    if (Number(response.headers.get("content-length")) > 1_000_000) return undefined
    const text = await response.text()
    if (text.length > 1_000_000) return undefined
    const raw: unknown = JSON.parse(text)
    if (!Array.isArray(raw) || raw.length > 64) return undefined
    const targets = raw.filter((item): item is Endpoint["targets"][number] => {
      if (!item || typeof item !== "object") return false
      if (typeof field(item, "type") !== "string" || typeof field(item, "webSocketDebuggerUrl") !== "string") return false
      try {
        const url = new URL(String(field(item, "webSocketDebuggerUrl")))
        return url.protocol === "ws:" && url.hostname === "127.0.0.1" && Number(url.port) === port
      } catch { return false }
    })
    return targets.length ? { port, targets } : undefined
  } catch { return undefined }
}

class CDP {
  private id = 0
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string" || event.data.length > 24_000_000) {
        socket.close()
        return
      }
      let data: { id?: number; result?: unknown; error?: { message?: string } }
      try { data = JSON.parse(String(event.data)) } catch { return }
      const pending = data.id === undefined ? undefined : this.pending.get(data.id)
      if (!pending || data.id === undefined) return
      this.pending.delete(data.id)
      if (data.error) pending.reject(new Error(data.error.message ?? "Electron debug command failed"))
      else pending.resolve(data.result)
    })
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) pending.reject(new Error("Electron debug connection closed"))
      this.pending.clear()
    })
  }

  static async connect(url: string) {
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error("Electron debug connection timed out")) }, 1500)
      socket.addEventListener("open", () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Electron debug connection failed")) }, { once: true })
    })
    return new CDP(socket)
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++this.id
    const result = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }))
    this.socket.send(JSON.stringify({ id, method, params }))
    try { return await Promise.race([result, Bun.sleep(3000).then(() => { throw new Error("Electron debug command timed out") })]) }
    finally { this.pending.delete(id) }
  }

  fire(method: string, params: Record<string, unknown>) { this.socket.send(JSON.stringify({ id: ++this.id, method, params })) }
  close() { this.socket.close() }

  async evaluate(expression: string): Promise<unknown> {
    const response = await this.send("Runtime.evaluate", { expression, includeCommandLineAPI: true, awaitPromise: true, returnByValue: true })
    if (field(response, "exceptionDetails")) throw missing()
    return field(field(response, "result"), "value")
  }
}

function geometry(value: unknown): { bounds: Rect; content: Rect } | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as { bounds?: Rect; content?: Rect }
  const valid = (rect: Rect | undefined): rect is Rect => !!rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0
  return valid(record.bounds) && valid(record.content) ? { bounds: record.bounds, content: record.content } : undefined
}

function exact(bounds: Rect, title: string, candidate: Rect, candidateTitle: string) {
  return title === candidateTitle && Math.abs(bounds.x - candidate.x) <= 1 && Math.abs(bounds.y - candidate.y) <= 1 &&
    Math.abs(bounds.width - candidate.width) <= 1 && Math.abs(bounds.height - candidate.height) <= 1
}

async function render(dataURL: string, bounds: Rect, content: Rect) {
  if (dataURL.length > 20_000_000) throw unavailable()
  if (!dataURL.startsWith("data:image/png;base64,") && !dataURL.startsWith("data:image/jpeg;base64,")) throw unavailable()
  const photon = await import("@silvia-odwyer/photon-node")
  const source = photon.PhotonImage.new_from_byteslice(Buffer.from(dataURL.slice(dataURL.indexOf(",") + 1), "base64"))
  const scale = Math.min(1, 1280 / Math.max(bounds.width, bounds.height))
  const width = Math.max(1, Math.floor(bounds.width * scale))
  const height = Math.max(1, Math.floor(bounds.height * scale))
  const contentWidth = Math.max(1, Math.floor(content.width * scale))
  const contentHeight = Math.max(1, Math.floor(content.height * scale))
  const resized = photon.resize(source, contentWidth, contentHeight, photon.SamplingFilter.Lanczos3)
  try {
    const pixels = new Uint8Array(width * height * 4)
    for (let index = 3; index < pixels.length; index += 4) pixels[index] = 255
    const image = resized.get_raw_pixels()
    const offsetX = Math.round((content.x - bounds.x) * scale)
    const offsetY = Math.round((content.y - bounds.y) * scale)
    for (let y = 0; y < contentHeight; y++) {
      const row = y + offsetY
      if (row < 0 || row >= height) continue
      const start = Math.max(0, offsetX)
      const end = Math.min(width, offsetX + contentWidth)
      if (start >= end) continue
      pixels.set(image.subarray((y * contentWidth + start - offsetX) * 4, (y * contentWidth + end - offsetX) * 4), (row * width + start) * 4)
    }
    const output = new photon.PhotonImage(pixels, width, height)
    try {
      for (const quality of [60, 45, 30, 20]) {
        const candidate = Buffer.from(output.get_bytes_jpeg(quality))
        if (candidate.length <= 600_000) return { image: candidate.toString("base64"), width, height, scale }
      }
      throw unavailable()
    } finally { output.free() }
  } finally { resized.free(); source.free() }
}

function inspectorWindow(windowID: number) {
  return `(()=>{const win=require('electron').BrowserWindow.getAllWindows().find(w=>w.getMediaSourceId()==='window:${windowID}:0');return win||null})()`
}

async function inspectorWork(cdp: CDP, target: MacOSComputer.DesktopTarget, window: WindowInfo, operation: Operation, onDispatch: () => void): Promise<BridgeResult> {
  const selector = inspectorWindow(target.windowID)
  const info = geometry(await cdp.evaluate(`(()=>{const w=${selector};return w?{bounds:w.getBounds(),content:w.getContentBounds()}:null})()`))
  if (!info || !exact(window.bounds, window.title, info.bounds, window.title)) throw missing()
  const capture = async () => {
    await cdp.evaluate(`(async()=>{const w=${selector};if(!w)return null;await w.webContents.capturePage();w.webContents.invalidate();return null})()`)
    const image = await cdp.evaluate(`(async()=>{const w=${selector};if(!w)return null;let last='';for(let i=0;i<5;i++){await new Promise(r=>setTimeout(r,150));const next=(await w.webContents.capturePage()).toDataURL();if(next===last)return next;last=next}return last})()`)
    if (typeof image !== "string") throw missing()
    return render(image, info.bounds, info.content)
  }
  if (operation.type === "capture") return { type: "capture", ...await capture() }
  const before = await capture()
  const action = operation.action
  const send = async (event: Record<string, unknown>) => {
    onDispatch()
    const delivered = await cdp.evaluate(`(()=>{const w=${selector};if(!w)return false;w.webContents.sendInputEvent(${JSON.stringify(event)});return true})()`)
    if (delivered !== true) throw missing()
  }
  if (action.type === "desktop.click" && "x" in action) {
    const point = contentPoint(info.bounds, info.content, before.scale, action.x, action.y)
    const button = action.button ?? "left"
    for (let clickCount = 1; clickCount <= (action.count ?? 1); clickCount++) {
      for (const type of ["mouseMove", "mouseDown", "mouseUp"]) await send({ type, ...point, button, clickCount })
    }
  } else if (action.type === "desktop.drag") {
    const from = contentPoint(info.bounds, info.content, before.scale, action.fromX, action.fromY)
    const to = contentPoint(info.bounds, info.content, before.scale, action.toX, action.toY)
    await send({ type: "mouseDown", ...from, button: "left", clickCount: 1 })
    for (let step = 1; step <= 5; step++)
      await send({ type: "mouseDrag", x: from.x + (to.x - from.x) * step / 5, y: from.y + (to.y - from.y) * step / 5, button: "left" })
    await send({ type: "mouseUp", ...to, button: "left", clickCount: 1 })
  } else if (action.type === "desktop.type" && !action.element) {
    if (Buffer.byteLength(action.text, "utf8") > 4096) throw unavailable()
    onDispatch()
    const delivered = await cdp.evaluate(`(()=>{const w=${selector};if(!w)return false;w.webContents.insertText(${JSON.stringify(action.text)});return true})()`)
    if (delivered !== true) throw missing()
  } else if (action.type === "desktop.key" && !action.element) {
    const keyCode = keyName(action.key).replace(/^Arrow/, "").replace(/^Enter$/, "Return")
    const modifiers = (action.modifiers ?? []).map((modifier) => modifier === "command" ? "meta" : modifier === "option" ? "alt" : modifier)
    for (const type of ["keyDown", "char", "keyUp"]) await send({ type, keyCode, modifiers })
  } else if (action.type === "desktop.scroll" && "x" in action) {
    const point = contentPoint(info.bounds, info.content, before.scale, action.x, action.y)
    await send({ type: "mouseWheel", ...point, deltaX: action.deltaX, deltaY: action.deltaY })
  } else throw unavailable()
  const changed = async (attempt: number): Promise<boolean> =>
    (await capture()).image !== before.image || (attempt < 3 && changed(attempt + 1))
  return { type: "action", effect: await changed(1) ? "changed" : "unchanged" }
}

async function rendererWork(cdp: CDP, placement: { bounds: Rect; content: Rect }, operation: Operation, onDispatch: () => void): Promise<BridgeResult> {
  const bounds = placement.bounds
  const content = placement.content
  const capture = async () => {
    const response = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })
    const data = field(response, "data")
    if (typeof data !== "string") throw unavailable()
    return render(`data:image/png;base64,${data}`, bounds, content)
  }
  if (operation.type === "capture") return { type: "capture", ...await capture() }
  const before = await capture()
  const action = operation.action
  if (action.type === "desktop.click" && "x" in action) {
    const point = contentPoint(bounds, content, before.scale, action.x, action.y)
    const button = action.button ?? "left"
    for (let count = 1; count <= (action.count ?? 1); count++) {
      onDispatch()
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button, clickCount: count })
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button, clickCount: count })
    }
  } else if (action.type === "desktop.drag") {
    const from = contentPoint(bounds, content, before.scale, action.fromX, action.fromY)
    const to = contentPoint(bounds, content, before.scale, action.toX, action.toY)
    onDispatch()
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...from, button: "left", clickCount: 1 })
    for (let step = 1; step <= 5; step++)
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x + (to.x - from.x) * step / 5, y: from.y + (to.y - from.y) * step / 5, button: "left", buttons: 1 })
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...to, button: "left", clickCount: 1 })
  } else if (action.type === "desktop.type" && !action.element) {
    onDispatch()
    await cdp.send("Input.insertText", { text: action.text })
  } else if (action.type === "desktop.key" && !action.element) {
    const modifiers = (action.modifiers ?? []).reduce((flags, modifier) => flags | ({ option: 1, control: 2, command: 4, shift: 8, fn: 0 }[modifier]), 0)
    const key = keyName(action.key)
    onDispatch()
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, modifiers, ...(key.length === 1 && !modifiers ? { text: key } : {}) })
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, modifiers })
  } else if (action.type === "desktop.scroll" && "x" in action) {
    const point = contentPoint(bounds, content, before.scale, action.x, action.y)
    onDispatch()
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX: action.deltaX, deltaY: action.deltaY })
  } else throw unavailable()
  const after = await capture()
  return { type: "action", effect: before.image === after.image ? "unchanged" : "changed" }
}

export function make(runtime: Runtime = live) {
  const ownedEndpoint = async (pid: number) => {
    for (const port of await runtime.ownedPorts(pid)) {
      const found = await endpoint(port)
      if (found) return found
    }
    return undefined
  }

  return {
    ownedEndpoint,
    async isElectron(pid: number) {
      const app = await runtime.appPath(pid)
      if (!app) return false
      return (runtime.frameworkExists ?? ((appPath) => Bun.file(path.join(appPath, "Contents/Frameworks/Electron Framework.framework/Electron Framework")).exists()))(app)
    },
    async perform(target: MacOSComputer.DesktopTarget, window: WindowInfo, operation: Operation, signal?: AbortSignal): Promise<BridgeResult | undefined> {
      if (signal?.aborted) throw unavailable()
      const app = await runtime.appPath(target.pid)
      if (!app) return undefined
      const bytes = await runtime.fuseBytes(app).catch(() => undefined)
      if (!bytes) return undefined
      const fuse = inspectFuse(bytes)
      const existing = await ownedEndpoint(target.pid)
      const pages = existing?.targets.filter((entry) => entry.type === "page" && entry.id && entry.title) ?? []
      if (pages.length) {
        if (!existing) throw unavailable()
        for (const page of pages) {
          if (!(await runtime.ownedPorts(target.pid)).includes(existing.port)) throw unavailable()
          const cdp = await CDP.connect(page.webSocketDebuggerUrl)
          let dispatched = false
          try {
            const placement = await pagePlacement(cdp)
            if (!placement || !exact(window.bounds, window.title, placement.bounds, page.title ?? "")) continue
            return await rendererWork(cdp, placement, operation, () => {
              if (signal?.aborted) throw dispatched ? new NativeError({ code: "unknown_outcome", message: "Electron input was interrupted", outcome: "unknown" }) : unavailable()
              dispatched = true
            })
          } catch (error) {
            if (dispatched) throw new NativeError({ code: "unknown_outcome", message: "Electron input may have been dispatched; inspect before retrying", outcome: "unknown" })
            throw error
          } finally { cdp.close() }
        }
        throw missing()
      }
      if (fuse !== "on") return undefined
      const initial = new Set(await runtime.ownedPorts(target.pid))
      await runtime.signal(target.pid)
      const started = Date.now()
      let opened: Endpoint | undefined
      while (Date.now() - started < 3000) {
        for (const port of await runtime.ownedPorts(target.pid)) {
          if (!initial.has(port)) opened = await endpoint(port)
          if (opened?.targets.some((entry) => entry.type === "node")) break
          opened = undefined
        }
        if (opened) break
        await runtime.sleep(50)
      }
      if (!opened) throw new NativeError({ code: "inspector_close_failed", message: "Inspector startup or cleanup could not be confirmed", outcome: "unknown" })
      const inspector = opened.targets.find((entry) => entry.type === "node")
      if (!inspector) throw unavailable()
      if (!(await runtime.ownedPorts(target.pid)).includes(opened.port)) throw unavailable()
      let result: BridgeResult | undefined
      let failure: unknown
      let dispatched = false
      try {
        const cdp = await CDP.connect(inspector.webSocketDebuggerUrl)
        try { result = await inspectorWork(cdp, target, window, operation, () => {
          if (signal?.aborted) throw dispatched ? new NativeError({ code: "unknown_outcome", message: "Electron input was interrupted", outcome: "unknown" }) : unavailable()
          dispatched = true
        }) }
        catch (error) { failure = error }
        finally {
          try {
            cdp.fire("Runtime.evaluate", { expression: "require('inspector').close()", includeCommandLineAPI: true })
            await Bun.sleep(20)
          } finally { cdp.close() }
        }
      } catch (error) { failure = error }
      const deadline = Date.now() + 2000
      while ((await runtime.ownedPorts(target.pid)).includes(opened.port) && Date.now() < deadline) await runtime.sleep(50)
      if ((await runtime.ownedPorts(target.pid)).includes(opened.port))
        throw new NativeError({ code: "inspector_close_failed", message: "Electron inspector did not close after the call", outcome: "unknown" })
      if (failure) throw dispatched
        ? new NativeError({ code: "unknown_outcome", message: "Electron input may have been dispatched; inspect before retrying", outcome: "unknown" }) : failure
      return result
    },
  }
}
