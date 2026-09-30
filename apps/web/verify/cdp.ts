import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

type Pending = { readonly method: string; readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }

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
    const message = JSON.parse(String(event.data)) as { readonly id?: number; readonly error?: { readonly message: string }; readonly result?: unknown }
    if (message.id === undefined) return
    const wait = pending.get(message.id)
    if (!wait) return
    pending.delete(message.id)
    if (message.error) wait.reject(new Error(`${wait.method}: ${message.error.message}`))
    else wait.resolve(message.result)
  })
  const send = <T>(method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<T>((resolve, reject) => {
      const id = ++next
      pending.set(id, { method, resolve: (value) => resolve(value as T), reject })
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  return {
    async openPage() {
      const target = await send<{ readonly targetId: string }>("Target.createTarget", { url: "about:blank" })
      const attached = await send<{ readonly sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true })
      const call = <T>(method: string, params: Record<string, unknown> = {}) => send<T>(method, params, attached.sessionId)
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
      await call("Network.enable")
      await call("Network.setBlockedURLs", { urls: ["*sw.js*"] })
      await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false })
      return {
        networkFailures: () => failures,
        platformFonts: async (selector: string) => {
          await call("DOM.enable")
          await call("CSS.enable")
          const document = await call<{ readonly root: { readonly nodeId: number } }>("DOM.getDocument")
          const node = await call<{ readonly nodeId: number }>("DOM.querySelector", { nodeId: document.root.nodeId, selector })
          if (node.nodeId === 0) throw new Error(`Font inspection target missing: ${selector}`)
          return (await call<{ readonly fonts: readonly { readonly familyName: string; readonly isCustomFont: boolean; readonly glyphCount: number }[] }>("CSS.getPlatformFontsForNode", { nodeId: node.nodeId })).fonts
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
        screenshot: async () => (await call<{ readonly data: string }>("Page.captureScreenshot", { format: "png" })).data,
        allowServiceWorker: () => call("Network.setBlockedURLs", { urls: [] }),
        blockURLs: (patterns: readonly string[]) => call("Network.setBlockedURLs", { urls: ["*sw.js*", ...patterns] }),
        installabilityErrors: async () => (await call<{ readonly installabilityErrors: readonly { readonly errorId: string }[] }>("Page.getInstallabilityErrors")).installabilityErrors,
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
            const mounted = await call<{ readonly result: { readonly value?: boolean } }>("Runtime.evaluate", {
              expression: "document.readyState === 'complete' && (document.getElementById('app') ?? document.getElementById('root') ?? document.body).children.length > 0",
              returnByValue: true,
            }).then((result) => result.result.value === true, () => false)
            if (mounted) break
            await Bun.sleep(50)
          }
          await Bun.sleep(250)
        },
        async setViewport(nextWidth: number, nextHeight: number) {
          await call("Emulation.setDeviceMetricsOverride", { width: nextWidth, height: nextHeight, deviceScaleFactor: 1, mobile: false })
        },
        async setMobileViewport(nextWidth: number, nextHeight: number) {
          await call("Emulation.setDeviceMetricsOverride", { width: nextWidth, height: nextHeight, deviceScaleFactor: 3, mobile: true })
          await call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 })
        },
        pinch: (x: number, y: number, scaleFactor: number) => call("Input.synthesizePinchGesture", { x, y, scaleFactor, relativeSpeed: 800, gestureSourceType: "touch" }),
        setColorScheme: (scheme: "light" | "dark") => call("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: scheme }],
        }),
        setReducedMotion: (reduce: boolean) => call("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-reduced-motion", value: reduce ? "reduce" : "no-preference" }],
        }),
        setForcedColors: (active: boolean) => call("Emulation.setEmulatedMedia", {
          features: [{ name: "forced-colors", value: active ? "active" : "none" }],
        }),
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
          await call("Emulation.setEmulatedMedia", {
            features: [{ name: "pointer", value: enabled ? "coarse" : "fine" }],
          })
        },
        async pressKey(key: string, code: string, windowsVirtualKeyCode: number, text?: string) {
          await call("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode, ...(text === undefined ? {} : { text }) })
          await call("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode })
        },
        async pressEscape() {
          await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
          await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
        },
        async evaluate<T>(expression: string): Promise<T> {
          const result = await call<{ readonly result: { readonly value: T }; readonly exceptionDetails?: { readonly text: string; readonly exception?: { readonly description?: string } } }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
          if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
          return result.result.value
        },
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
