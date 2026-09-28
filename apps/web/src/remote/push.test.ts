import { expect, test } from "bun:test"
import { enablePush, disablePush, syncPushState, pushSupport, pushStatusView, type PushPlatform } from "./push"

type FixtureSubscription = { endpoint: string; getKey: (name: string) => ArrayBuffer | null; unsubscribe: () => Promise<boolean>;
  options?: { applicationServerKey: ArrayBuffer | null } }

function serverKey() {
  const key = new Uint8Array(65)
  key[0] = 4
  return key
}

function existingSubscription(h: ReturnType<typeof fixture>, key: Uint8Array<ArrayBuffer>): FixtureSubscription {
  return { endpoint: "https://fcm.googleapis.com/send/existing", getKey: (name) => new Uint8Array(name === "p256dh" ? 65 : 16).buffer,
    options: { applicationServerKey: key.buffer.slice(0) },
    unsubscribe: async () => { h.calls.push("unsubscribe-existing"); h.setSubscription(null); return true } }
}

function fixture() {
  const calls: string[] = []
  const registered: string[] = []
  const removed: string[] = []
  let permission: NotificationPermission = "default"
  let subscription: FixtureSubscription | null = null
  const bytes = (size: number) => new Uint8Array(size).buffer
  const platform: PushPlatform = {
    secure: true, supported: true, installed: true,
    permission: () => permission,
    requestPermission: async () => { calls.push("permission"); permission = "granted"; return permission },
    registration: async () => ({ pushManager: {
      getSubscription: async () => subscription,
      subscribe: async () => {
        calls.push("subscribe")
        subscription = { endpoint: "https://fcm.googleapis.com/send/a", getKey: (name) => name === "p256dh" ? bytes(65) : bytes(16),
          unsubscribe: async () => { calls.push("unsubscribe"); subscription = null; return true } }
        return subscription
      },
    } }),
  }
  const http = {
    key: async () => ({ ok: true as const, value: { publicKey: "BA" + "A".repeat(85) } }),
    subscribe: async (input: { readonly endpoint: string }) => { calls.push("register"); registered.push(input.endpoint); return { ok: true as const, value: undefined } },
    remove: async (endpoint: string) => { calls.push("remove"); removed.push(endpoint); return { ok: true as const, value: undefined } },
  }
  return { platform, http, calls, registered, removed, setPermission: (value: NotificationPermission) => { permission = value },
    setSubscription: (value: FixtureSubscription | null) => { subscription = value } }
}

test("push support distinguishes secure installed capability and permission denial", async () => {
  const test = fixture()
  expect(pushSupport({ ...test.platform, secure: false })).toBe("unsupported")
  expect(pushSupport({ ...test.platform, installed: false })).toBe("unsupported")
  test.setPermission("denied")
  expect(pushSupport(test.platform)).toBe("blocked")
  test.setPermission("default")
  expect(await syncPushState(test.platform, test.http)).toBe("off")
  const unavailable = { ...test.http, key: async () => ({ ok: false as const, status: 503, kind: "http" as const, message: "Web Push is unavailable" }) }
  expect(await syncPushState(test.platform, unavailable)).toBe("unavailable")
  const unauthenticated = { ...test.http, key: async () => ({ ok: false as const, status: 401, kind: "http" as const, message: "Sign in" }) }
  expect(await syncPushState(test.platform, unauthenticated)).toBe("error")
})

test("push Settings labels every capability and permission state without claiming delivery while blocked", () => {
  expect(pushStatusView("unsupported")).toMatchObject({ label: "Unsupported", disabled: true, pressed: false })
  expect(pushStatusView("unavailable")).toMatchObject({ label: "Unavailable", disabled: true, pressed: false })
  expect(pushStatusView("blocked")).toMatchObject({ label: "Blocked", disabled: true, pressed: false })
  expect(pushStatusView("off")).toMatchObject({ label: "Turn on", disabled: false, pressed: false })
  expect(pushStatusView("needs-setup")).toMatchObject({ label: "Re-enable", disabled: false, pressed: false })
  expect(pushStatusView("on")).toMatchObject({ label: "Turn off", disabled: false, pressed: true })
})

test("a granted device with a revoked browser subscription shows push off and offers re-enable", async () => {
  const h = fixture()
  h.setPermission("granted")
  expect(await syncPushState(h.platform, h.http)).toBe("needs-setup")
  expect(pushStatusView(await syncPushState(h.platform, h.http)).detail).toContain("no active subscription")
  expect(await enablePush(h.platform, h.http)).toEqual({ status: "on" })
  expect(h.calls).toEqual(["permission", "subscribe", "register"])
})

test("push enable requests permission on click, registers only after subscribe, and disable removes before unsubscribe", async () => {
  const test = fixture()
  expect(await enablePush(test.platform, test.http)).toEqual({ status: "on" })
  expect(test.calls).toEqual(["permission", "subscribe", "register"])
  expect(await syncPushState(test.platform, test.http)).toBe("on")
  expect(await disablePush(test.platform, test.http)).toEqual({ status: "off" })
  expect(test.calls).toEqual(["permission", "subscribe", "register", "register", "remove", "unsubscribe"])
})

test("sync re-registers this device's existing subscription with the relay on every workspace load", async () => {
  const h = fixture()
  h.setPermission("granted")
  h.setSubscription(existingSubscription(h, serverKey()))
  expect(await syncPushState(h.platform, h.http)).toBe("on")
  expect(h.calls).toEqual(["register"])
  expect(h.registered).toEqual(["https://fcm.googleapis.com/send/existing"])
})

test("sync replaces a subscription made for a rotated server key before registering it", async () => {
  const h = fixture()
  h.setPermission("granted")
  const rotated = serverKey()
  rotated[1] = 9
  h.setSubscription(existingSubscription(h, rotated))
  expect(await syncPushState(h.platform, h.http)).toBe("on")
  expect(h.calls).toEqual(["unsubscribe-existing", "subscribe", "register", "remove"])
  expect(h.registered).toEqual(["https://fcm.googleapis.com/send/a"])
  expect(h.removed).toEqual(["https://fcm.googleapis.com/send/existing"])
})

test("sync reports a relay rejection instead of claiming push is on", async () => {
  const h = fixture()
  h.setPermission("granted")
  h.setSubscription(existingSubscription(h, serverKey()))
  const failing = { ...h.http, subscribe: async () => ({ ok: false as const, status: 500, kind: "http" as const, message: "Failed" }) }
  expect(await syncPushState(h.platform, failing)).toBe("error")
})

test("sync leaves an ungranted or unsubscribed device untouched", async () => {
  const h = fixture()
  expect(await syncPushState(h.platform, h.http)).toBe("off")
  h.setPermission("granted")
  expect(await syncPushState(h.platform, h.http)).toBe("needs-setup")
  expect(h.calls).toEqual([])
})

test("push registration failure rolls back a newly created browser subscription", async () => {
  const test = fixture()
  const failing = { ...test.http, subscribe: async () => ({ ok: false as const, status: 500, kind: "http" as const, message: "Failed" }) }
  expect(await enablePush(test.platform, failing)).toEqual({ status: "error", message: "Failed" })
  expect(test.calls).toEqual(["permission", "subscribe", "unsubscribe"])
})
