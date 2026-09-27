import { expect, test } from "bun:test"

test("service worker shows one notification per push including malformed and focused, opens Session, and resubscribes", async () => {
  const listeners = new Map<string, (event: unknown) => void>()
  const previous = { addEventListener: Reflect.get(globalThis, "addEventListener"), clients: Reflect.get(globalThis, "clients"),
    registration: Reflect.get(globalThis, "registration"), location: Reflect.get(globalThis, "location"), fetch: globalThis.fetch }
  const shown: { title: string; options: Record<string, unknown> }[] = []
  const posted: unknown[] = []
  const calls: Request[] = []
  let focusFails = false
  const windowClient = { visibilityState: "visible", focused: true, url: "https://relay.test/remote", focus: async () => {
    if (focusFails) throw new Error("window closed")
  },
    postMessage: (message: unknown) => posted.push(message) }
  const windowClients: typeof windowClient[] = [windowClient]
  let opened = ""
  Reflect.set(globalThis, "addEventListener", (name: string, listener: (event: unknown) => void) => listeners.set(name, listener))
  Reflect.set(globalThis, "clients", { claim: () => undefined, matchAll: async () => windowClients,
    openWindow: async (url: string) => { opened = url; return undefined } })
  Reflect.set(globalThis, "registration", { showNotification: async (title: string, options: Record<string, unknown>) => { shown.push({ title, options }) },
    pushManager: { subscribe: async () => ({ endpoint: "https://fcm.googleapis.com/send/replacement",
      getKey: (name: string) => new Uint8Array(name === "p256dh" ? 65 : 16).buffer }) } })
  Reflect.set(globalThis, "location", { origin: "https://relay.test" })
  Reflect.set(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(new URL(input instanceof Request ? input.url : input instanceof URL ? input.href : input, "https://relay.test"), init)
    calls.push(request)
    return Response.json(new URL(request.url).pathname === "/api/push/key" ? { publicKey: "BA" + "A".repeat(85) } : { subscribed: true })
  })
  try {
    await import("./service-worker")
    const emit = async (name: string, event: Record<string, unknown>) => {
      let pending: Promise<unknown> | undefined
      listeners.get(name)?.({ ...event, waitUntil: (promise: Promise<unknown>) => { pending = promise } })
      if (!pending) throw new Error(`Missing ${name} event handler`)
      await pending
    }
    await emit("push", { data: { json: () => { throw new Error("malformed") } } })
    expect(shown).toEqual([{ title: "YCoding — update", options: { body: "Open YCoding to check your work.", tag: "ycoding-update",
      icon: "/icons/icon-256.png", badge: "/icons/icon-256.png" } }])
    await emit("push", {})
    expect(shown).toHaveLength(2)
    expect(shown[1]).toEqual(shown[0])
    await emit("notificationclick", { notification: { close: () => undefined } })
    expect(opened).toBe("/remote")
    opened = ""
    const payload = { category: "approval-requested", sessionID: "ses_1", deviceID: "dev_1" }
    await emit("push", { data: { json: () => payload } })
    expect(shown).toHaveLength(3)
    expect(shown[2]).toMatchObject({ title: "YCoding — approval needed", options: { tag: "ycoding-ses_1-approval-requested", data: { sessionID: "ses_1" } } })
    windowClients.length = 0
    await emit("push", { data: { json: () => payload } })
    expect(shown).toHaveLength(4)
    expect(shown[3]).toMatchObject({ title: "YCoding — approval needed", options: { tag: "ycoding-ses_1-approval-requested", data: { sessionID: "ses_1" } } })
    await emit("notificationclick", { notification: { data: { sessionID: "ses_1" }, close: () => undefined } })
    expect(opened).toBe("/remote#session=ses_1")
    windowClients.push(windowClient)
    await emit("notificationclick", { notification: { data: { sessionID: "ses_1" }, close: () => undefined } })
    expect(posted).toEqual([{ type: "ycoding:open-session", sessionID: "ses_1" }])
    focusFails = true
    opened = ""
    await emit("notificationclick", { notification: { data: { sessionID: "ses_1" }, close: () => undefined } })
    expect(opened).toBe("/remote#session=ses_1")
    focusFails = false
    opened = ""
    posted.length = 0
    windowClients.splice(0, windowClients.length, { ...windowClient, url: "https://relay.test/docs" })
    await emit("notificationclick", { notification: { data: { sessionID: "ses_1" }, close: () => undefined } })
    expect(posted).toEqual([])
    expect(opened).toBe("/remote#session=ses_1")
    await emit("pushsubscriptionchange", {})
    expect(calls.map((call) => [call.method, new URL(call.url).pathname])).toEqual([["GET", "/api/push/key"], ["POST", "/api/push/subscriptions"]])
    await emit("pushsubscriptionchange", { oldSubscription: { endpoint: "https://fcm.googleapis.com/send/replacement" },
      newSubscription: { endpoint: "https://fcm.googleapis.com/send/replacement2",
        getKey: (name: string) => new Uint8Array(name === "p256dh" ? 65 : 16).buffer } })
    expect(calls.slice(2).map((call) => call.method)).toEqual(["GET", "POST", "DELETE"])
    expect(await calls[4]?.json()).toEqual({ endpoint: "https://fcm.googleapis.com/send/replacement" })
  } finally {
    for (const [key, value] of Object.entries(previous)) Reflect.set(globalThis, key, value)
  }
})
