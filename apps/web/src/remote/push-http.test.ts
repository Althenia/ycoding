import { expect, test } from "bun:test"
import { createPushHttp } from "./http"

test("push HTTP reads the VAPID key and writes a bounded subscription through same-origin credentials", async () => {
  const calls: Request[] = []
  const http = createPushHttp({ fetch: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Request(input, init))
    const path = new URL(calls.at(-1)?.url ?? "").pathname
    return Response.json(path === "/api/push/key" ? { publicKey: "public" } : { subscribed: true })
  }, { preconnect: () => undefined }), baseURL: "https://relay.test" })
  expect(await http.key()).toEqual({ ok: true, value: { publicKey: "public" } })
  const input = { endpoint: "https://fcm.googleapis.com/send/a", keys: { p256dh: "public", auth: "secret" },
    categories: { "agent-completed": true, "approval-requested": false, "machine-offline": true } }
  expect(await http.subscribe(input)).toEqual({ ok: true, value: undefined })
  expect(await http.remove(input.endpoint)).toEqual({ ok: true, value: undefined })
  expect(calls.map((call) => [call.method, new URL(call.url).pathname])).toEqual([
    ["GET", "/api/push/key"], ["POST", "/api/push/subscriptions"], ["DELETE", "/api/push/subscriptions"],
  ])
  const subscription = calls[1]
  const removal = calls[2]
  if (!subscription || !removal) throw new Error("push requests were not sent")
  expect(await subscription.json()).toEqual(input)
  expect(await removal.json()).toEqual({ endpoint: input.endpoint })
})

test("push HTTP distinguishes unavailable key from a malformed response", async () => {
  const unavailable = createPushHttp({ fetch: Object.assign(async () => Response.json({ error: { message: "Web Push is unavailable" } }, { status: 503 }), { preconnect: () => undefined }) })
  expect(await unavailable.key()).toMatchObject({ ok: false, status: 503, message: "Web Push is unavailable" })
  const malformed = createPushHttp({ fetch: Object.assign(async () => Response.json({ publicKey: 123 }), { preconnect: () => undefined }) })
  expect(await malformed.key()).toMatchObject({ ok: false, kind: "unexpected-body" })
})
