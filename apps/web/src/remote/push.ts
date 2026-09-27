import type { PushSubscriptionInput } from "@ycoding-ai/remote"
import { createPushHttp } from "./http"

export type PushStatus = "unsupported" | "unavailable" | "blocked" | "off" | "needs-setup" | "on" | "error"

export function pushStatusView(status: PushStatus) {
  switch (status) {
    case "unsupported": return { label: "Unsupported", detail: "Use a secure browser with Push support. On iPhone or iPad, install YCoding to your Home Screen.", disabled: true, pressed: false }
    case "unavailable": return { label: "Unavailable", detail: "This server has not enabled Web Push.", disabled: true, pressed: false }
    case "blocked": return { label: "Blocked", detail: "Allow notifications for this site in your browser settings.", disabled: true, pressed: false }
    case "on": return { label: "Turn off", detail: "Push is registered on this device for approval and stopped-work alerts.", disabled: false, pressed: true }
    case "needs-setup": return { label: "Re-enable", detail: "Push is off because this device has no active subscription. Re-enable alerts to this device.", disabled: false, pressed: false }
    case "error": return { label: "Retry setup", detail: "Push setup did not complete. Try again.", disabled: false, pressed: false }
    case "off": return { label: "Turn on", detail: "Enable alerts when the installed app is closed.", disabled: false, pressed: false }
  }
  throw new Error("Unknown push state")
}

type Subscription = { readonly endpoint: string; getKey: (name: "p256dh" | "auth") => ArrayBuffer | null; unsubscribe: () => Promise<boolean> }
type Registration = { readonly pushManager: { getSubscription: () => Promise<Subscription | null>;
  subscribe: (options: { readonly userVisibleOnly: true; readonly applicationServerKey: Uint8Array<ArrayBuffer> }) => Promise<Subscription> } }

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
  const standalone = window.matchMedia("(display-mode: standalone)").matches || Reflect.get(navigator, "standalone") === true
  return { secure: window.isSecureContext, supported: "serviceWorker" in navigator && "PushManager" in window && "Notification" in window,
    installed: !iOS || standalone,
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

export async function readPushState(platform: PushPlatform, http: ReturnType<typeof createPushHttp>): Promise<PushStatus> {
  const support = pushSupport(platform)
  if (support !== "off") return support
  const key = await http.key()
  if (!key.ok) return key.status === 503 ? "unavailable" : "error"
  try {
    if (await (await platform.registration()).pushManager.getSubscription()) return "on"
    return platform.permission() === "granted" ? "needs-setup" : "off"
  } catch {
    return "unavailable"
  }
}

export async function enablePush(platform: PushPlatform, http: ReturnType<typeof createPushHttp>): Promise<{ status: PushStatus; message?: string }> {
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
    const p256dh = subscription.getKey("p256dh")
    const auth = subscription.getKey("auth")
    if (!p256dh || !auth) {
      if (!existing) await subscription.unsubscribe()
      return { status: "error", message: "The browser did not provide push keys." }
    }
    const input: PushSubscriptionInput = { endpoint: subscription.endpoint,
      keys: { p256dh: encodeKey(new Uint8Array(p256dh)), auth: encodeKey(new Uint8Array(auth)) } }
    const registered = await http.subscribe(input)
    if (!registered.ok) {
      if (!existing) await subscription.unsubscribe()
      return { status: "error", message: registered.message }
    }
    return { status: "on" }
  } catch (cause) {
    return { status: "error", message: cause instanceof Error ? cause.message : "This browser could not subscribe." }
  }
}

export async function disablePush(platform: PushPlatform, http: ReturnType<typeof createPushHttp>): Promise<{ status: PushStatus; message?: string }> {
  try {
    const subscription = await (await platform.registration()).pushManager.getSubscription()
    if (!subscription) return { status: "off" }
    const removed = await http.remove(subscription.endpoint)
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
