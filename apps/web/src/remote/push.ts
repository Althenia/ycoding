import type { PushCategories, PushKeys } from "@ycoding-ai/remote"
import { isInstalledApp } from "../pwa/installed"
import { createPushHttp } from "./http"

export type PushStatus = "unsupported" | "unavailable" | "blocked" | "off" | "needs-setup" | "on" | "error"

export function pushStatusView(status: PushStatus) {
  switch (status) {
    case "unsupported": return { label: "Unsupported", detail: "Use a secure browser with Push support. On iPhone or iPad, install YCoding to your Home Screen.", disabled: true, pressed: false }
    case "unavailable": return { label: "Unavailable", detail: "This server has not enabled Web Push.", disabled: true, pressed: false }
    case "blocked": return { label: "Blocked", detail: "Allow notifications for this site in your browser settings.", disabled: true, pressed: false }
    case "on": return { label: "Turn off", detail: "Push is registered on this device for the System alerts chosen above.", disabled: false, pressed: true }
    case "needs-setup": return { label: "Re-enable", detail: "Push is off because this device has no active subscription. Re-enable alerts to this device.", disabled: false, pressed: false }
    case "error": return { label: "Retry setup", detail: "Push setup did not complete. Try again.", disabled: false, pressed: false }
    case "off": return { label: "Turn on", detail: "Turn on to receive the System alerts chosen above on this device when YCoding is closed.", disabled: false, pressed: false }
  }
  throw new Error("Unknown push state")
}

type Subscription = { readonly endpoint: string; getKey: (name: "p256dh" | "auth") => ArrayBuffer | null; unsubscribe: () => Promise<boolean>;
  readonly options?: { readonly applicationServerKey: ArrayBuffer | null } }
type Registration = { readonly pushManager: { getSubscription: () => Promise<Subscription | null>;
  subscribe: (options: { readonly userVisibleOnly: true; readonly applicationServerKey: Uint8Array<ArrayBuffer> }) => Promise<Subscription> } }

type PushHttp = Pick<ReturnType<typeof createPushHttp>, "key" | "subscribe" | "remove" | "test">

export type PushPlatform = {
  readonly secure: boolean
  readonly supported: boolean
  readonly installed: boolean
  readonly permission: () => NotificationPermission
  readonly requestPermission: () => Promise<NotificationPermission>
  readonly registration: () => Promise<Registration>
}

export function browserPushPlatform(): PushPlatform {
  const iOS = /iPhone|iPad|iPod/.test(navigator.userAgent)
  return { secure: window.isSecureContext, supported: "serviceWorker" in navigator && "PushManager" in window && "Notification" in window,
    installed: !iOS || isInstalledApp(),
    permission: () => Notification.permission,
    requestPermission: () => Notification.requestPermission(),
    registration: () => navigator.serviceWorker.ready,
  }
}

export function pushSupport(platform: PushPlatform): PushStatus {
  if (!platform.secure || !platform.supported || !platform.installed) return "unsupported"
  if (platform.permission() === "denied") return "blocked"
  return "off"
}

export async function syncPushState(platform: PushPlatform, http: PushHttp, categories: () => PushCategories): Promise<PushStatus> {
  const support = pushSupport(platform)
  if (support !== "off") return support
  const key = await http.key()
  if (!key.ok) return key.status === 503 ? "unavailable" : "error"
  const applicationServerKey = decodeKey(key.value.publicKey)
  if (applicationServerKey === undefined) return "unavailable"
  try {
    const manager = (await platform.registration()).pushManager
    const existing = await manager.getSubscription()
    if (!existing) return platform.permission() === "granted" ? "needs-setup" : "off"
    const madeFor = existing.options?.applicationServerKey
    const stale = madeFor !== undefined && madeFor !== null && !sameBytes(new Uint8Array(madeFor), applicationServerKey)
    if (stale) await existing.unsubscribe()
    const current = stale ? await manager.subscribe({ userVisibleOnly: true, applicationServerKey }) : existing
    const input = subscriptionInput(current)
    if (!input) return "error"
    const registered = await register(http, input, categories)
    if (!registered.ok) return "error"
    if (stale) await serialized(() => http.remove(existing.endpoint))
    return "on"
  } catch {
    return "error"
  }
}

function subscriptionInput(subscription: Subscription): { readonly endpoint: string; readonly keys: PushKeys } | undefined {
  const p256dh = subscription.getKey("p256dh")
  const auth = subscription.getKey("auth")
  if (!p256dh || !auth) return undefined
  return { endpoint: subscription.endpoint, keys: { p256dh: encodeKey(new Uint8Array(p256dh)), auth: encodeKey(new Uint8Array(auth)) } }
}

let relayWrites: Promise<unknown> = Promise.resolve()

function serialized<Value>(write: () => Promise<Value>): Promise<Value> {
  const next = relayWrites.then(write, write)
  relayWrites = next.catch(() => undefined)
  return next
}

function register(http: PushHttp, input: { readonly endpoint: string; readonly keys: PushKeys }, categories: () => PushCategories) {
  return serialized(() => http.subscribe({ ...input, categories: categories() }))
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export async function enablePush(platform: PushPlatform, http: PushHttp, categories: () => PushCategories): Promise<{ status: PushStatus; message?: string }> {
  const support = pushSupport(platform)
  if (support !== "off") return { status: support }
  const permission = await platform.requestPermission()
  if (permission !== "granted") return { status: permission === "denied" ? "blocked" : "off" }
  const key = await http.key()
  if (!key.ok) return { status: key.status === 503 ? "unavailable" : "error", message: key.message }
  const applicationServerKey = decodeKey(key.value.publicKey)
  if (applicationServerKey === undefined) return { status: "unavailable", message: "The server push key is invalid." }
  try {
    const manager = (await platform.registration()).pushManager
    const existing = await manager.getSubscription()
    const subscription = existing ?? await manager.subscribe({ userVisibleOnly: true, applicationServerKey })
    const input = subscriptionInput(subscription)
    if (!input) {
      if (!existing) await subscription.unsubscribe()
      return { status: "error", message: "The browser did not provide push keys." }
    }
    const registered = await register(http, input, categories)
    if (!registered.ok) {
      if (!existing) await subscription.unsubscribe()
      return { status: "error", message: registered.message }
    }
    return { status: "on" }
  } catch (cause) {
    return { status: "error", message: cause instanceof Error ? cause.message : "This browser could not subscribe." }
  }
}

export async function savePushCategories(platform: PushPlatform, http: PushHttp, categories: () => PushCategories): Promise<{ status: PushStatus; message?: string }> {
  try {
    const subscription = pushSupport(platform) === "off" ? await (await platform.registration()).pushManager.getSubscription() : null
    if (!subscription) return { status: "off" }
    const input = subscriptionInput(subscription)
    if (!input) return { status: "error", message: "Saved on this device only. The browser did not provide push keys." }
    const registered = await register(http, input, categories)
    if (!registered.ok) return { status: "error", message: `Saved on this device only. Closed-app alerts still use the previous choice: ${registered.message}` }
    return { status: "on" }
  } catch (cause) {
    return { status: "error", message: `Saved on this device only. Closed-app alerts still use the previous choice: ${cause instanceof Error ? cause.message : "the browser push state is unavailable"}` }
  }
}

export async function sendPushTest(platform: PushPlatform, http: PushHttp): Promise<{ status: PushStatus; message: string }> {
  try {
    const subscription = await (await platform.registration()).pushManager.getSubscription()
    if (!subscription) return { status: "off", message: "This device has no push subscription. Turn on push first." }
    const result = await http.test(subscription.endpoint)
    if (!result.ok) return { status: result.status === 404 ? "needs-setup" : "on", message: result.message }
    const status = result.value.status ?? 0
    if (result.value.outcome === "accepted")
      return { status: "on", message: `The push service accepted a test alert (HTTP ${status}). If none appears, check this device's notification settings for this browser or app.` }
    if (result.value.outcome === "rejected") return { status: "error", message: `The push service refused the test alert (HTTP ${status}).` }
    if (result.value.outcome === "unreachable") return { status: "on", message: "The relay could not reach the push service. Try again later." }
    await subscription.unsubscribe()
    return { status: "needs-setup", message: "The push service reports this subscription expired. Use Re-enable to register this device again." }
  } catch (cause) {
    return { status: "error", message: cause instanceof Error ? cause.message : "This browser could not send a test alert." }
  }
}

export async function disablePush(platform: PushPlatform, http: PushHttp): Promise<{ status: PushStatus; message?: string }> {
  try {
    const subscription = await (await platform.registration()).pushManager.getSubscription()
    if (!subscription) return { status: "off" }
    const removed = await serialized(() => http.remove(subscription.endpoint))
    if (!removed.ok) return { status: "error", message: removed.message }
    if (!await subscription.unsubscribe()) return { status: "error", message: "The browser could not unsubscribe." }
    return { status: "off" }
  } catch (cause) {
    return { status: "error", message: cause instanceof Error ? cause.message : "This browser could not unsubscribe." }
  }
}

function decodeKey(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined
  try {
    const bytes = atob(value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "="))
    const key = new Uint8Array(bytes.length)
    for (let index = 0; index < bytes.length; index += 1) key[index] = bytes.charCodeAt(index)
    return key.length === 65 && key[0] === 4 ? key : undefined
  } catch { return undefined }
}

function encodeKey(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}
