import { expect, test } from "bun:test"
import { enablePush, disablePush, readPushState, pushSupport, pushStatusView, type PushPlatform } from "./push"

function fixture() {
  const calls: string[] = []
  let permission: NotificationPermission = "default"
  let subscription: { endpoint: string; getKey: (name: string) => ArrayBuffer | null; unsubscribe: () => Promise<boolean> } | null = null
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
    subscribe: async () => { calls.push("register"); return { ok: true as const, value: undefined } },
    remove: async () => { calls.push("remove"); return { ok: true as const, value: undefined } },
  }
  return { platform, http, calls, setPermission: (value: NotificationPermission) => { permission = value },
    setSubscription: (value: typeof subscription) => { subscription = value } }
}

test("push support distinguishes secure installed capability and permission denial", async () => {
  const test = fixture()
  expect(pushSupport({ ...test.platform, secure: false })).toBe("unsupported")
  expect(pushSupport({ ...test.platform, installed: false })).toBe("unsupported")
  test.setPermission("denied")
  expect(pushSupport(test.platform)).toBe("blocked")
  test.setPermission("default")
  expect(await readPushState(test.platform, test.http)).toBe("off")
  const unavailable = { ...test.http, key: async () => ({ ok: false as const, status: 503, kind: "http" as const, message: "Web Push is unavailable" }) }
  expect(await readPushState(test.platform, unavailable)).toBe("unavailable")
  const unauthenticated = { ...test.http, key: async () => ({ ok: false as const, status: 401, kind: "http" as const, message: "Sign in" }) }
  expect(await readPushState(test.platform, unauthenticated)).toBe("error")
})

test("push Settings labels every capability and permission state without claiming delivery while blocked", () => {
  expect(pushStatusView("unsupported")).toMatchObject({ label: "Unsupported", disabled: true, pressed: false })
  expect(pushStatusView("unavailable")).toMatchObject({ label: "Unavailable", disabled: true, pressed: false })
  expect(pushStatusView("blocked")).toMatchObject({ label: "Blocked", disabled: true, pressed: false })
  expect(pushStatusView("off")).toMatchObject({ label: "Turn on", disabled: false, pressed: false })
  expect(pushStatusView("on")).toMatchObject({ label: "Turn off", disabled: false, pressed: true })
})

test("push enable requests permission on click, registers only after subscribe, and disable removes before unsubscribe", async () => {
  const test = fixture()
  expect(await enablePush(test.platform, test.http)).toEqual({ status: "on" })
  expect(test.calls).toEqual(["permission", "subscribe", "register"])
  expect(await readPushState(test.platform, test.http)).toBe("on")
  expect(await disablePush(test.platform, test.http)).toEqual({ status: "off" })
  expect(test.calls).toEqual(["permission", "subscribe", "register", "remove", "unsubscribe"])
})

test("push registration failure rolls back a newly created browser subscription", async () => {
  const test = fixture()
  const failing = { ...test.http, subscribe: async () => ({ ok: false as const, status: 500, kind: "http" as const, message: "Failed" }) }
  expect(await enablePush(test.platform, failing)).toEqual({ status: "error", message: "Failed" })
  expect(test.calls).toEqual(["permission", "subscribe", "unsubscribe"])
})
