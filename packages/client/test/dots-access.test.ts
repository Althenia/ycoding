import { expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

const status = { access: { enabled: true, revision: 1 }, configuration: { ready: true, profile: "Synthetic" }, connection: { state: "connected", hostname: "synthetic-host" } }
const threads = { dotID: "dot_1", rootThreadID: "thr_1", threads: [{ threadID: "thr_1", kind: "root" }], tasks: [] }
const updates = { taskID: "task_1", updates: [{ updateID: "upd_1", text: "Synthetic update", createdAt: "2026-11-13T00:00:00Z" }] }
const transcript = { thread: { threadID: "thr_1", kind: "root" }, turns: [{ turnID: "turn_1", items: [{ type: "userMessage", itemID: "item_1", text: "hello" }] }] }
const sent = { admission: "started", turnID: "turn_1" }
const interrupted = { outcome: "interrupted" }
const pending = { threadID: "thr_1", requests: [{ requestID: "req_1", threadID: "thr_1", kind: "command-approval", command: "ls" }] }
const responded = { outcome: "sent" }
const resumed = { outcome: "resumed", threadID: "thr_1" }
const responses: Record<string, unknown> = {
  "GET /api/dots": status,
  "PUT /api/dots": status,
  "POST /api/dots/computer": status,
  "POST /api/dots/computer/detach": status,
  "POST /api/dots/computer/remove": status,
  "GET /api/dots/threads": threads,
  "GET /api/dots/tasks/task_1/updates": updates,
  "GET /api/dots/thread/thr_1": transcript,
  "POST /api/dots/thread/thr_1/message": sent,
  "POST /api/dots/thread/thr_1/interrupt": interrupted,
  "GET /api/dots/thread/thr_1/requests": pending,
  "POST /api/dots/thread/thr_1/requests/req_1": responded,
  "POST /api/dots/resume": resumed,
}
const respond = (method: string, url: string) => Response.json({ data: responses[`${method} ${new URL(url).pathname}`] })

test("generated Promise global Dots methods serialize only the revision-fenced payload and unwrap status", async () => {
  const { YCoding } = await import("../src/promise/index")
  const requests: Request[] = []
  const controller = new AbortController()
  const client = YCoding.make({ baseUrl: "http://localhost", fetch: async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init)
    requests.push(request)
    return respond(request.method, request.url)
  } })
  const signal = { signal: controller.signal }
  expect(await client.dots.get(signal)).toEqual(status)
  expect(await client.dots.set({ enabled: true, expectedRevision: 0 }, signal)).toEqual(status)
  expect(await client.dots.attach({ replaceOthers: true }, signal)).toEqual(status)
  expect(await client.dots.detach(undefined, signal)).toEqual(status)
  expect(await client.dots.remove(undefined, signal)).toEqual(status)
  expect(await client.dots.threads(signal)).toEqual(threads)
  expect(await client.dots.task.updates({ taskID: "task_1", cursor: "c1", limit: 5 }, signal)).toEqual(updates)
  expect(await client.dots.thread.read({ threadID: "thr_1", cursor: "c2", limit: 10 }, signal)).toEqual(transcript)
  expect(await client.dots.thread.send({ threadID: "thr_1", text: "hello", clientMessageID: "msg_1", mode: "send" }, signal)).toEqual(sent)
  expect(await client.dots.thread.interrupt({ threadID: "thr_1", turnID: "turn_1" }, signal)).toEqual(interrupted)
  expect(await client.dots.thread.requests({ threadID: "thr_1" }, signal)).toEqual(pending)
  expect(await client.dots.thread.respond({ threadID: "thr_1", requestID: "req_1", decision: "accept" }, signal)).toEqual(responded)
  expect(await client.dots.resume(signal)).toEqual(resumed)
  expect(Object.keys(client.dots)).toEqual(["get", "set", "attach", "detach", "remove", "threads", "task", "thread", "resume"])
  expect(Object.keys(client.dots.task)).toEqual(["updates"])
  expect(Object.keys(client.dots.thread)).toEqual(["read", "send", "interrupt", "requests", "respond"])
  expect(requests.map((request) => [request.method, new URL(request.url).pathname, new URL(request.url).search, request.headers.get("x-ycoding-directory"), request.headers.get("x-ycoding-workspace")])).toEqual([
    ["GET", "/api/dots", "", null, null], ["PUT", "/api/dots", "", null, null], ["POST", "/api/dots/computer", "", null, null],
    ["POST", "/api/dots/computer/detach", "", null, null], ["POST", "/api/dots/computer/remove", "", null, null],
    ["GET", "/api/dots/threads", "", null, null], ["GET", "/api/dots/tasks/task_1/updates", "?cursor=c1&limit=5", null, null],
    ["GET", "/api/dots/thread/thr_1", "?cursor=c2&limit=10", null, null], ["POST", "/api/dots/thread/thr_1/message", "", null, null],
    ["POST", "/api/dots/thread/thr_1/interrupt", "", null, null], ["GET", "/api/dots/thread/thr_1/requests", "", null, null],
    ["POST", "/api/dots/thread/thr_1/requests/req_1", "", null, null], ["POST", "/api/dots/resume", "", null, null],
  ])
  expect(await requests[1]!.json()).toEqual({ enabled: true, expectedRevision: 0 })
  expect(await requests[2]!.json()).toEqual({ replaceOthers: true })
  expect(await requests[3]!.json()).toEqual({})
  expect(await requests[4]!.json()).toEqual({})
  expect(await requests[8]!.json()).toEqual({ text: "hello", clientMessageID: "msg_1", mode: "send" })
  expect(await requests[9]!.json()).toEqual({ turnID: "turn_1" })
  expect(await requests[11]!.json()).toEqual({ decision: "accept" })
  controller.abort()
  expect(requests.map((request) => request.signal.aborted)).toEqual(requests.map(() => true))
})

test("generated Effect global Dots methods retain the canonical serialized request and status", async () => {
  const { YCoding } = await import("../src/effect/index")
  const requests: unknown[] = []
  const http = HttpClient.make((request) => {
    requests.push({ method: request.method, path: new URL(request.url).pathname, query: new URL(request.url).search,
      urlParams: Object.fromEntries(request.urlParams.params),
      directory: request.headers["x-ycoding-directory"], workspace: request.headers["x-ycoding-workspace"],
      body: request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined })
    return Effect.succeed(HttpClientResponse.fromWeb(request, respond(request.method, request.url)))
  })
  await Effect.runPromise(Effect.gen(function* () {
    const client = yield* YCoding.make({ baseUrl: "http://localhost" })
    expect(yield* client.dots.get()).toEqual(status)
    expect(yield* client.dots.set({ enabled: true, expectedRevision: 0 })).toEqual(status)
    expect(yield* client.dots.attach({ replaceOthers: true })).toEqual(status)
    expect(yield* client.dots.detach()).toEqual(status)
    expect(yield* client.dots.remove()).toEqual(status)
    expect(yield* client.dots.threads()).toEqual(threads)
    expect(yield* client.dots.task.updates({ taskID: "task_1", cursor: "c1", limit: 5 })).toEqual(updates)
    expect(yield* client.dots.thread.read({ threadID: "thr_1", cursor: "c2", limit: 10 })).toEqual(transcript)
    expect(yield* client.dots.thread.send({ threadID: "thr_1", text: "hello", clientMessageID: "msg_1", mode: "send" })).toEqual(sent)
    expect(yield* client.dots.thread.interrupt({ threadID: "thr_1", turnID: "turn_1" })).toEqual(interrupted)
    expect(yield* client.dots.thread.requests({ threadID: "thr_1" })).toEqual(pending)
    expect(yield* client.dots.thread.respond({ threadID: "thr_1", requestID: "req_1", decision: "accept" })).toEqual(responded)
    expect(yield* client.dots.resume()).toEqual(resumed)
    expect(Object.keys(client.dots)).toEqual(["get", "set", "attach", "detach", "remove", "threads", "task", "thread", "resume"])
    expect(Object.keys(client.dots.task)).toEqual(["updates"])
    expect(Object.keys(client.dots.thread)).toEqual(["read", "send", "interrupt", "requests", "respond"])
  }).pipe(Effect.provideService(HttpClient.HttpClient, http)))
  const call = (method: string, path: string, urlParams: Record<string, string> = {}, body?: unknown) =>
    ({ method, path, query: "", urlParams, directory: undefined, workspace: undefined, body })
  expect(requests).toEqual([
    call("GET", "/api/dots"),
    call("PUT", "/api/dots", {}, { enabled: true, expectedRevision: 0 }),
    call("POST", "/api/dots/computer", {}, { replaceOthers: true }),
    call("POST", "/api/dots/computer/detach", {}, {}),
    call("POST", "/api/dots/computer/remove", {}, {}),
    call("GET", "/api/dots/threads"),
    call("GET", "/api/dots/tasks/task_1/updates", { cursor: "c1", limit: "5" }),
    call("GET", "/api/dots/thread/thr_1", { cursor: "c2", limit: "10" }),
    call("POST", "/api/dots/thread/thr_1/message", {}, { text: "hello", clientMessageID: "msg_1", mode: "send" }),
    call("POST", "/api/dots/thread/thr_1/interrupt", {}, { turnID: "turn_1" }),
    call("GET", "/api/dots/thread/thr_1/requests"),
    call("POST", "/api/dots/thread/thr_1/requests/req_1", {}, { decision: "accept" }),
    call("POST", "/api/dots/resume"),
  ])
})
