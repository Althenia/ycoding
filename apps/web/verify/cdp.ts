import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

type Pending = { readonly method: string; readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }

export async function launchBrowser(executable: string, width: number, height: number) {
  const profile = mkdtempSync(join(tmpdir(), "ycoding-web-verify-"))
  const child = spawn(executable, ["--headless", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: ["ignore", "pipe", "pipe"] })
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
      await call("Page.enable")
      await call("Runtime.enable")
      await call("Network.enable")
      await call("Network.setBlockedURLs", { urls: ["*sw.js*"] })
      await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false })
      return {
        async navigate(url: string) {
          await call("Page.navigate", { url })
          await Bun.sleep(250)
        },
        async setViewport(nextWidth: number, nextHeight: number) {
          await call("Emulation.setDeviceMetricsOverride", { width: nextWidth, height: nextHeight, deviceScaleFactor: 1, mobile: false })
        },
        async setCoarsePointer(enabled: boolean) {
          await call("Emulation.setTouchEmulationEnabled", { enabled, maxTouchPoints: enabled ? 1 : 0 })
          await call("Emulation.setEmulatedMedia", {
            features: [{ name: "pointer", value: enabled ? "coarse" : "fine" }],
          })
        },
        async pressKey(key: string, code: string, windowsVirtualKeyCode: number) {
          await call("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode })
          await call("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode })
        },
        async pressEscape() {
          await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
          await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
        },
        async evaluate<T>(expression: string): Promise<T> {
          const result = await call<{ readonly result: { readonly value: T }; readonly exceptionDetails?: { readonly text: string } }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
          if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
          return result.result.value
        },
        close: () => call("Target.closeTarget", { targetId: target.targetId }),
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
