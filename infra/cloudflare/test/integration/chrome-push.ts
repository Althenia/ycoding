import { spawn } from "bun"
import { join } from "node:path"

type CDPReply = { readonly id?: number; readonly result?: Record<string, unknown>; readonly error?: { readonly message: string } }

export async function openChromePush(input: { readonly home: string; readonly origin: string; readonly cookie: string }) {
  const profile = join(input.home, "push-chrome")
  const launched = spawn(["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", `${input.origin}/remote`],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
  let ownedSocket: WebSocket | undefined
  let transferred = false
  const stop = async () => {
    ownedSocket?.close()
    if (launched.exitCode === null) launched.kill()
    await launched.exited
  }

  try {

  const deadline = Date.now() + 30_000
  let port = 0
  while (Date.now() < deadline) {
    const file = Bun.file(join(profile, "DevToolsActivePort"))
    if (await file.exists()) {
      port = Number((await file.text()).split("\n")[0])
      break
    }
    await Bun.sleep(100)
  }
  if (!port) throw new Error("headed Chrome did not expose a temporary debugging port")

  let target: Record<string, unknown> | undefined
  while (Date.now() < deadline) {
    const list: unknown = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
    if (Array.isArray(list)) target = list.find((entry) => typeof entry === "object" && entry !== null && Reflect.get(entry, "type") === "page")
    if (target?.webSocketDebuggerUrl) break
    await Bun.sleep(100)
  }
  if (typeof target?.webSocketDebuggerUrl !== "string") throw new Error("headed Chrome has no page debugger")
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  ownedSocket = socket
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true })
    socket.addEventListener("error", () => reject(new Error("Chrome debugger socket failed")), { once: true })
  })
  let nextID = 0
  const pending = new Map<number, { resolve: (value: CDPReply) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  socket.addEventListener("message", (event) => {
    const reply: CDPReply = JSON.parse(String(event.data))
    if (reply.id === undefined) return
    const waiting = pending.get(reply.id)
    pending.delete(reply.id)
    if (waiting) clearTimeout(waiting.timer)
    if (reply.error) waiting?.reject(new Error(reply.error.message))
    else waiting?.resolve(reply)
  })
  socket.addEventListener("close", () => {
    for (const waiting of pending.values()) {
      clearTimeout(waiting.timer)
      waiting.reject(new Error("Chrome debugger closed"))
    }
    pending.clear()
  })
  const command = (method: string, params: Record<string, unknown> = {}) => new Promise<CDPReply>((resolve, reject) => {
    const id = ++nextID
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Chrome command timed out: ${method}`))
    }, method === "Runtime.evaluate" ? 90_000 : 10_000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression: string) => {
    const response = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
    const result = response.result?.result
    if (typeof result !== "object" || result === null) throw new Error("Chrome evaluation had no result")
    const exception = response.result?.exceptionDetails
    if (exception) throw new Error("Chrome page evaluation failed")
    return Reflect.get(result, "value") as unknown
  }
  await command("Network.enable")
  const [name, value] = input.cookie.split("=")
  await command("Network.setCookie", { name, value, url: input.origin, sameSite: "Lax" })
  await command("Browser.grantPermissions", { origin: input.origin, permissions: ["notifications"] })
  await command("Page.navigate", { url: `${input.origin}/remote` })
  while (Date.now() < deadline) {
    if (await evaluate("document.readyState") === "complete") break
    await Bun.sleep(100)
  }
  const subscribed = await evaluate(`(async () => {
    if (Notification.permission !== "granted") return "permission_not_granted"
    window.__ycodingPushSetupStage = "worker-registration"
    const registration = await navigator.serviceWorker.register("/sw.js", { type: "module" })
    window.__ycodingPushSetupStage = "worker-ready"
    await navigator.serviceWorker.ready
    window.__ycodingPushSetupStage = "push-key"
    const keyResponse = await fetch("/api/push/key")
    if (!keyResponse.ok) return "push_key_unavailable"
    const key = (await keyResponse.json()).publicKey
    const bytes = Uint8Array.from(atob(key.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0))
    window.__ycodingPushSetupStage = "browser-subscription"
    const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes })
    const data = subscription.toJSON()
    if (!data.keys?.p256dh || !data.keys?.auth) return "missing_browser_keys"
    window.__ycodingPushSetupStage = "backend-registration"
    const registered = await fetch("/api/push/subscriptions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: subscription.endpoint, keys: { p256dh: data.keys.p256dh, auth: data.keys.auth }, categories: { "agent-completed": true, "approval-requested": true, "machine-offline": true } }) })
    if (registered.ok) {
      const hash = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))))
        .map((byte) => byte.toString(16).padStart(2, "0")).join("")
      return { state: "subscribed", endpointHash: await hash(subscription.endpoint), servedPublicKeyHash: await hash(key) }
    }
    const failure = await registered.json().catch(() => undefined)
    return { state: "registration_failed", status: registered.status,
      code: ["invalid_message", "unauthorized", "internal_error", "not_found", "rate_limited"].includes(failure?.error?.code) ? failure.error.code : "unreported" }
  })()`).catch(async (error: unknown) => {
    const stage = await evaluate("window.__ycodingPushSetupStage").catch(() => undefined)
    const known = ["worker-registration", "worker-ready", "push-key", "browser-subscription", "backend-registration"]
    throw new Error(`Chrome push setup did not settle at ${typeof stage === "string" && known.includes(stage) ? stage : "unreported"}: ${error instanceof Error && error.message === "Chrome command timed out: Runtime.evaluate" ? "timeout" : "evaluation failed"}`)
  })
  if (typeof subscribed !== "object" || subscribed === null || Reflect.get(subscribed, "state") !== "subscribed") {
    throw new Error(`headed Chrome push setup failed: ${typeof subscribed === "string" ? subscribed : JSON.stringify(subscribed)}`)
  }
  const endpointHash: unknown = Reflect.get(subscribed, "endpointHash")
  const servedPublicKeyHash: unknown = Reflect.get(subscribed, "servedPublicKeyHash")
  if (typeof endpointHash !== "string" || !/^[a-f0-9]{64}$/.test(endpointHash) ||
    typeof servedPublicKeyHash !== "string" || !/^[a-f0-9]{64}$/.test(servedPublicKeyHash)) throw new Error("Chrome push setup returned invalid diagnostic hashes")
  await evaluate(`(() => {
    window.__ycodingPageAlerts = []
    const original = ServiceWorkerRegistration.prototype.showNotification
    ServiceWorkerRegistration.prototype.showNotification = function(title, options) {
      window.__ycodingPageAlerts.push(options?.tag)
      return original.call(this, title, options)
    }
    return true
  })()`)
  let viewing = false
  transferred = true
  return {
    endpointHash,
    servedPublicKeyHash,
    leavePage: () => command("Page.navigate", { url: "about:blank" }),
    pageAlerts: () => evaluate("window.__ycodingPageAlerts"),
    notifications: async () => {
      if (!viewing) { await command("Page.navigate", { url: `${input.origin}/remote` }); viewing = true }
      return evaluate(`(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map(item => ({ title: item.title, tag: item.tag })))()`)
    },
    close: async () => { await command("Browser.close").catch(() => undefined); await stop() },
  }
  } finally {
    if (!transferred) await stop()
  }
}
