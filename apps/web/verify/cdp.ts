import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

type Pending = { readonly method: string; readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }

export type Decoder<T> = (value: unknown) => T
export type Page = Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>

export function decodeString(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a string")
  return value
}

export function decodeNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Expected a finite number")
  return value
}

export function decodeBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Expected a boolean")
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function decodeRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected a record")
  return value
}

export const decodeArray = <T>(decode: Decoder<T>): Decoder<T[]> => (value) => {
  if (!Array.isArray(value)) throw new Error("Expected an array")
  return value.map((item: unknown) => decode(item))
}

export const decodeOptional = <T>(decode: Decoder<T>): Decoder<T | undefined> => (value) => value === undefined ? undefined : decode(value)
export const decodeNullable = <T>(decode: Decoder<T>): Decoder<T | null> => (value) => value === null ? null : decode(value)

export const decodeLiteral = <const T extends string | number | boolean | null | undefined>(literal: T): Decoder<T> => (value) => {
  if (value !== literal) throw new Error("Expected the literal value")
  return literal
}

export const decodeUnion = <A, B>(first: Decoder<A>, second: Decoder<B>): Decoder<A | B> => (value) => {
  const errors: unknown[] = []
  for (const decode of [first, second]) {
    try { return decode(value) }
    catch (cause) { errors.push(cause) }
  }
  throw new AggregateError(errors, "Expected a value from either union member")
}

export const decodeDictionary = <T>(decode: Decoder<T>): Decoder<Record<string, T>> => (value) =>
  Object.fromEntries(Object.entries(decodeRecord(value)).map(([key, item]) => [key, decode(item)] as const))

export function decodeCDPMessage(value: unknown) {
  const message = decodeRecord(value)
  if (message.id === undefined) return undefined
  const id = decodeNumber(message.id)
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("Expected a positive CDP response id")
  if (message.error !== undefined) return { id, error: decodeString(decodeRecord(message.error).message) }
  if (!("result" in message)) throw new Error("Expected a CDP response result")
  return { id, result: message.result }
}

export const cdpResponses = {
  "Target.createTarget": (value: unknown) => {
    const result = decodeRecord(value)
    return { ...result, targetId: decodeString(result.targetId) }
  },
  "Target.attachToTarget": (value: unknown) => {
    const result = decodeRecord(value)
    return { ...result, sessionId: decodeString(result.sessionId) }
  },
  "DOM.getDocument": (value: unknown) => {
    const result = decodeRecord(value)
    const root = decodeRecord(result.root)
    return { ...result, root: { ...root, nodeId: decodeNumber(root.nodeId) } }
  },
  "DOM.querySelector": (value: unknown) => {
    const result = decodeRecord(value)
    return { ...result, nodeId: decodeNumber(result.nodeId) }
  },
  "CSS.getPlatformFontsForNode": (value: unknown) => {
    const result = decodeRecord(value)
    return { ...result, fonts: decodeArray((value) => {
      const font = decodeRecord(value)
      return { ...font, familyName: decodeString(font.familyName), isCustomFont: decodeBoolean(font.isCustomFont), glyphCount: decodeNumber(font.glyphCount) }
    })(result.fonts) }
  },
  "Page.captureScreenshot": (value: unknown) => {
    const result = decodeRecord(value)
    return { ...result, data: decodeString(result.data) }
  },
  "Page.getInstallabilityErrors": (value: unknown) => {
    const result = decodeRecord(value)
    return { ...result, installabilityErrors: decodeArray((value) => {
      const error = decodeRecord(value)
      return { ...error, errorId: decodeString(error.errorId) }
    })(result.installabilityErrors) }
  },
  "Runtime.evaluate": (value: unknown): unknown => {
    const result = decodeRecord(value)
    if (result.exceptionDetails !== undefined) {
      const error = decodeRecord(result.exceptionDetails)
      const text = decodeString(error.text)
      const exception = decodeOptional(decodeRecord)(error.exception)
      throw new Error(exception?.description === undefined ? text : decodeString(exception.description))
    }
    const remote = decodeRecord(result.result)
    decodeString(remote.type)
    return remote.value
  },
}

export async function launchBrowser(executable: string, width: number, height: number, options: { readonly scrollbars?: boolean } = {}) {
  const profile = mkdtempSync(join(tmpdir(), "ycoding-web-verify-"))
  const child = spawn(executable, ["--headless", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--enable-unsafe-swiftshader", ...(options.scrollbars ? [] : ["--hide-scrollbars"]), "about:blank"], { stdio: ["ignore", "pipe", "pipe"] })
  const endpoint = await devtoolsEndpoint(child)
  const socket = new WebSocket(endpoint)
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true })
    socket.addEventListener("error", () => reject(new Error("Chrome DevTools connection failed")), { once: true })
  })
  let next = 0
  const pending = new Map<number, Pending>()
  socket.addEventListener("message", (event) => {
    let message: ReturnType<typeof decodeCDPMessage>
    try {
      const value: unknown = JSON.parse(String(event.data))
      message = decodeCDPMessage(value)
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      for (const wait of pending.values()) wait.reject(error)
      pending.clear()
      return
    }
    if (message === undefined) return
    const wait = pending.get(message.id)
    if (!wait) return
    pending.delete(message.id)
    if (message.error !== undefined) wait.reject(new Error(`${wait.method}: ${message.error}`))
    else wait.resolve(message.result)
  })
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++next
      pending.set(id, { method, resolve, reject })
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  return {
    async openPage() {
      const target = cdpResponses["Target.createTarget"](await send("Target.createTarget", { url: "about:blank" }))
      const attached = cdpResponses["Target.attachToTarget"](await send("Target.attachToTarget", { targetId: target.targetId, flatten: true }))
      const call = (method: string, params: Record<string, unknown> = {}) => send(method, params, attached.sessionId)
      function evaluate(expression: string): Promise<unknown>
      function evaluate<T>(expression: string, decode: Decoder<T>): Promise<T>
      async function evaluate(expression: string, decode?: Decoder<unknown>): Promise<unknown> {
        const value = cdpResponses["Runtime.evaluate"](await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }))
        return decode === undefined ? value : decode(value)
      }
      const media = new Map<string, string>()
      const setMedia = (name: string, value: string) => {
        media.set(name, value)
        return call("Emulation.setEmulatedMedia", { features: [...media].map(([name, value]) => ({ name, value })) })
      }
      const requests = new Map<string, string>()
      const failures: string[] = []
      const pausedCleanup = new Set<() => void>()
      const observeFailure = (event: MessageEvent) => {
        const message: unknown = JSON.parse(String(event.data))
        if (!message || typeof message !== "object" || !("sessionId" in message) || message.sessionId !== attached.sessionId || !("method" in message)) return
        const params = "params" in message && message.params && typeof message.params === "object" ? message.params : undefined
        const requestID = params && "requestId" in params && typeof params.requestId === "string" ? params.requestId : undefined
        if (message.method === "Network.requestWillBeSent" && requestID && params && "request" in params && params.request && typeof params.request === "object" && "url" in params.request && typeof params.request.url === "string") {
          requests.set(requestID, new URL(params.request.url).pathname)
        }
        if (message.method === "Network.loadingFailed") {
          failures.push(`${requests.get(requestID ?? "") ?? "unknown"}: ${params && "errorText" in params && typeof params.errorText === "string" ? params.errorText : "unknown"}`)
        }
        if ((message.method === "Network.loadingFailed" || message.method === "Network.loadingFinished") && requestID) requests.delete(requestID)
      }
      socket.addEventListener("message", observeFailure)
      await call("Page.enable")
      await call("Runtime.enable")
      await call("Emulation.setFocusEmulationEnabled", { enabled: true })
      await setMedia("prefers-reduced-motion", "no-preference")
      await call("Network.enable")
      await call("Network.setBlockedURLs", { urls: ["*sw.js*"] })
      await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false })
      return {
        networkFailures: () => failures,
        platformFonts: async (selector: string) => {
          await call("DOM.enable")
          await call("CSS.enable")
          const document = cdpResponses["DOM.getDocument"](await call("DOM.getDocument"))
          const node = cdpResponses["DOM.querySelector"](await call("DOM.querySelector", { nodeId: document.root.nodeId, selector }))
          if (node.nodeId === 0) throw new Error(`Font inspection target missing: ${selector}`)
          return cdpResponses["CSS.getPlatformFontsForNode"](await call("CSS.getPlatformFontsForNode", { nodeId: node.nodeId })).fonts
        },
        injectOnNewDocument: (source: string) => call("Page.addScriptToEvaluateOnNewDocument", { source }),
        disableCache: () => call("Network.setCacheDisabled", { cacheDisabled: true }),
        pauseFontRequests: async () => {
          const paused = new Set<string>()
          const observe = (event: MessageEvent) => {
            const message: unknown = JSON.parse(String(event.data))
            if (!message || typeof message !== "object" || !("sessionId" in message) || message.sessionId !== attached.sessionId || !("method" in message) || message.method !== "Fetch.requestPaused" || !("params" in message) || !message.params || typeof message.params !== "object" || !("requestId" in message.params) || typeof message.params.requestId !== "string") return
            paused.add(message.params.requestId)
          }
          const cleanup = () => socket.removeEventListener("message", observe)
          socket.addEventListener("message", observe)
          pausedCleanup.add(cleanup)
          await call("Fetch.enable", { patterns: [{ urlPattern: "*.woff2*", requestStage: "Request" }] })
          return {
            pending: () => paused.size,
            release: async () => {
              await Promise.all([...paused].map((requestId) => call("Fetch.continueRequest", { requestId })))
              paused.clear()
              await call("Fetch.disable")
              cleanup()
              pausedCleanup.delete(cleanup)
            },
          }
        },
        screenshot: async () => cdpResponses["Page.captureScreenshot"](await call("Page.captureScreenshot", { format: "png" })).data,
        allowServiceWorker: () => call("Network.setBlockedURLs", { urls: [] }),
        blockURLs: (patterns: readonly string[]) => call("Network.setBlockedURLs", { urls: ["*sw.js*", ...patterns] }),
        installabilityErrors: async () => cdpResponses["Page.getInstallabilityErrors"](await call("Page.getInstallabilityErrors")).installabilityErrors,
        setOffline: (offline: boolean) => call("Network.emulateNetworkConditions", {
          offline,
          latency: 0,
          downloadThroughput: 0,
          uploadThroughput: 0,
        }),
        async navigate(url: string) {
          await call("Page.navigate", { url })
          // The router mounts the first route after its async initial load, and a cold Vite graph
          // compiles on first visit; wait briefly for the application root to hold a rendered child.
          // Fixtures that render into detached hosts leave the root empty and fall through after the cap.
          for (let attempt = 0; attempt < 30; attempt += 1) {
            const mounted = await call("Runtime.evaluate", {
              expression: "document.readyState === 'complete' && (document.getElementById('app') ?? document.getElementById('root') ?? document.body).children.length > 0",
              returnByValue: true,
            }).then((result) => cdpResponses["Runtime.evaluate"](result) === true, () => false)
            if (mounted) break
            await Bun.sleep(50)
          }
          await Bun.sleep(250)
        },
        async setViewport(nextWidth: number, nextHeight: number) {
          await call("Emulation.setDeviceMetricsOverride", { width: nextWidth, height: nextHeight, deviceScaleFactor: 1, mobile: false })
        },
        setSafeAreaInsets: (top: number, bottom: number) => call("Emulation.setSafeAreaInsetsOverride", { insets: { top, bottom, left: 0, right: 0 } }),
        async setMobileViewport(nextWidth: number, nextHeight: number) {
          await call("Emulation.setDeviceMetricsOverride", { width: nextWidth, height: nextHeight, deviceScaleFactor: 3, mobile: true })
          await call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 })
        },
        pinch: (x: number, y: number, scaleFactor: number) => call("Input.synthesizePinchGesture", { x, y, scaleFactor, relativeSpeed: 800, gestureSourceType: "touch" }),
        setColorScheme: (scheme: "light" | "dark") => setMedia("prefers-color-scheme", scheme),
        async setAnimationPlaybackRate(playbackRate: number) {
          await call("Animation.enable")
          await call("Animation.setPlaybackRate", { playbackRate })
        },
        setReducedMotion: (reduce: boolean) => setMedia("prefers-reduced-motion", reduce ? "reduce" : "no-preference"),
        setForcedColors: (active: boolean) => setMedia("forced-colors", active ? "active" : "none"),
        mouse: (type: "mouseMoved" | "mousePressed" | "mouseReleased", x: number, y: number, held = false) => call("Input.dispatchMouseEvent", {
          type,
          x,
          y,
          button: type === "mouseMoved" ? "none" : "left",
          buttons: type === "mousePressed" || held ? 1 : 0,
          clickCount: type === "mouseMoved" ? 0 : 1,
        }),
        touch: (type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel", x = 0, y = 0) => call("Input.dispatchTouchEvent", {
          type, touchPoints: type === "touchEnd" || type === "touchCancel" ? [] : [{ x, y, id: 1 }],
        }),
        wheel: (x: number, y: number, deltaX: number, deltaY: number) => call("Input.dispatchMouseEvent", {
          type: "mouseWheel", x, y, deltaX, deltaY,
        }),
        async setCoarsePointer(enabled: boolean) {
          await call("Emulation.setTouchEmulationEnabled", { enabled, ...(enabled ? { maxTouchPoints: 1 } : {}) })
          await setMedia("pointer", enabled ? "coarse" : "fine")
        },
        async pressKey(key: string, code: string, windowsVirtualKeyCode: number, text?: string) {
          await call("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode, ...(text === undefined ? {} : { text }) })
          await call("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode })
        },
        async pressEscape() {
          await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
          await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
        },
        evaluate,
        async close() {
          pausedCleanup.forEach((cleanup) => cleanup())
          pausedCleanup.clear()
          socket.removeEventListener("message", observeFailure)
          await call("Target.closeTarget", { targetId: target.targetId })
        },
      }
    },
    async close() {
      socket.close()
      child.kill("SIGKILL")
      rmSync(profile, { recursive: true, force: true })
    },
  }
}

function devtoolsEndpoint(child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolve, reject) => {
    let stderr = ""
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
      const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/)
      if (match) resolve(match[1]!)
    })
    child.once("error", (error) => reject(new Error(`Chrome did not start: ${error.message}`)))
    child.once("exit", (code) => reject(new Error(`Chrome exited before DevTools was ready (${code})`)))
  })
}
