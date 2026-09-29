import { spawn } from "bun"
import { join } from "node:path"

type CDPReply = { readonly id?: number; readonly result?: Record<string, unknown>; readonly error?: { readonly message: string } }

export async function openChromePush(input: { readonly home: string; readonly origin: string; readonly cookie: string }) {
  const profile = join(input.home, "push-chrome")
  const launched = spawn(["open", "-g", "-n", "-a", "/Applications/Google Chrome.app", "--args",
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", `${input.origin}/remote`],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [exitCode, stderr] = await Promise.all([launched.exited, new Response(launched.stderr).text()])
  if (exitCode !== 0) throw new Error(`Chrome could not start a headed temporary profile: ${stderr}`)

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
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true })
    socket.addEventListener("error", () => reject(new Error("Chrome debugger socket failed")), { once: true })
  })
  let nextID = 0
  const pending = new Map<number, { resolve: (value: CDPReply) => void; reject: (error: Error) => void }>()
  socket.addEventListener("message", (event) => {
    const reply: CDPReply = JSON.parse(String(event.data))
    if (reply.id === undefined) return
    const waiting = pending.get(reply.id)
    pending.delete(reply.id)
    if (reply.error) waiting?.reject(new Error(reply.error.message))
    else waiting?.resolve(reply)
  })
  const command = (method: string, params: Record<string, unknown> = {}) => new Promise<CDPReply>((resolve, reject) => {
    const id = ++nextID
    pending.set(id, { resolve, reject })
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
    const registration = await navigator.serviceWorker.register("/sw.js", { type: "module" })
    await navigator.serviceWorker.ready
    const keyResponse = await fetch("/api/push/key")
    if (!keyResponse.ok) return "push_key_unavailable"
    const key = (await keyResponse.json()).publicKey
    const bytes = Uint8Array.from(atob(key.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0))
    const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes })
    const data = subscription.toJSON()
    if (!data.keys?.p256dh || !data.keys?.auth) return "missing_browser_keys"
    const registered = await fetch("/api/push/subscriptions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: subscription.endpoint, keys: { p256dh: data.keys.p256dh, auth: data.keys.auth } }) })
    return registered.ok ? "subscribed" : "registration_failed"
  })()`)
  if (subscribed !== "subscribed") {
    await command("Browser.close").catch(() => undefined)
    socket.close()
    throw new Error(`headed Chrome push setup failed: ${String(subscribed)}`)
  }
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
  return {
    leavePage: () => command("Page.navigate", { url: "about:blank" }),
    pageAlerts: () => evaluate("window.__ycodingPageAlerts"),
    notifications: async () => {
      if (!viewing) { await command("Page.navigate", { url: `${input.origin}/remote` }); viewing = true }
      return evaluate(`(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map(item => ({ title: item.title, tag: item.tag })))()`)
    },
    close: async () => { await command("Browser.close").catch(() => undefined); socket.close() },
  }
}
