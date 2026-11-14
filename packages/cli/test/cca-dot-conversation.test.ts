import { expect, test } from "bun:test"
import type { NativeDots } from "@ycoding-ai/core/dots/native"
import { createCcaDotConversation } from "../src/remote-control/cca-dot-conversation"
import { ccaDurableAdmissionTimeoutMs, type CcaDurableClient, type CcaDurableReply } from "../src/remote-control/cca-durable-host"

const base = "https://chatgpt.com/backend-api"
const dotID = "tbo_synthetic_conversation_0001"
const rootThreadID = "thr_synthetic_conversation_root_0001"
const taskThreadID = "thr_synthetic_conversation_task_0001"
const roomID = "room_synthetic/conversation+0001"
const roomURL = `${base}/messaging/rooms/${encodeURIComponent(roomID)}/messages`
const configuration: NativeDots.Configuration = {
  enabled: true, accessRevision: 1, profile: "dots", credentialID: "synthetic-credential-conversation-0001",
  accountID: "synthetic-account-conversation-0001", accountGeneration: 1,
}
const credential = {
  access: "synthetic-access-conversation-0001", accountID: configuration.accountID, key: "synthetic-key-conversation-0001",
  profile: configuration.profile, credentialID: configuration.credentialID, accountGeneration: configuration.accountGeneration,
}
const message = { text: "Synthetic delivery notification", clientMessageID: "synthetic-message-conversation-0001", mode: "send" as const }
const json = (body: unknown, status = 200) => Response.json(body, { status })
type Reply = Response | Error

function fixture(options: {
  readonly attempts?: number
  readonly listed?: readonly string[]
  readonly profile?: unknown
  readonly roomReplies?: readonly Reply[]
  readonly resumeReplies?: readonly Reply[]
  readonly roomCreateReplies?: readonly Reply[]
  readonly dmReplies?: readonly Reply[]
  readonly connected?: boolean
  readonly durableReplies?: Record<string, readonly CcaDurableReply[]>
} = {}) {
  const count = options.attempts ?? 1
  const routes: Record<string, Reply[]> = {
    [`GET ${base}/tbo?limit=25&include_room_preview=false`]: Array.from({ length: count }, () => json({ items: [{ id: dotID, status: "active" }], cursor: null })),
    [`GET ${base}/tbo/${dotID}/root-thread`]: Array.from({ length: count }, () => json({ root_thread_id: rootThreadID })),
    [`GET ${base}/tbo/${dotID}/threads?limit=100&include_hidden=false`]: Array.from({ length: count }, () => json({ items: (options.listed ?? [taskThreadID]).map((thread_id) => ({ thread_id })), cursor: null })),
    [`GET ${base}/tbo/${dotID}/tasks?limit=100`]: [json({ data: [], next_cursor: null })],
    [`GET ${base}/tbo/${dotID}`]: Array.from({ length: count }, () => json(options.profile ?? { id: dotID, messaging_room_id: roomID })),
    [`POST ${roomURL}`]: [...(options.roomReplies ?? [json({ id: "synthetic-room-message-0001" })])],
    [`POST ${base}/tbo/${dotID}/runtime/resume`]: [...(options.resumeReplies ?? [json({ thread_id: rootThreadID, status: "resumed" })])],
    [`POST ${base}/tbo/${dotID}/messaging-room`]: [...(options.roomCreateReplies ?? [])],
    [`POST ${base}/messaging/dots/${dotID}/dm`]: [...(options.dmReplies ?? [])],
  }
  const replies = Object.fromEntries(Object.entries(options.durableReplies ?? {
    "thread/resume": [{ kind: "error", code: -32600, message: "Some requested entity was not found: thread not found" }],
  } satisfies Record<string, readonly CcaDurableReply[]>).map(([key, values]) => [key, [...values]]))
  const rest: { readonly method: string; readonly url: string; readonly headers: Headers; readonly body: unknown }[] = []
  const requests: { readonly method: string; readonly params: unknown; readonly timeoutMs?: number }[] = []
  const durable: CcaDurableClient = {
    connected: () => options.connected ?? true,
    request: async (method, params, timeoutMs) => {
      requests.push({ method, params, ...(timeoutMs === undefined ? {} : { timeoutMs }) })
      const reply = replies[method]?.shift()
      if (reply === undefined) throw new Error(`Unexpected durable request: ${method}`)
      return reply
    },
    watch: (threadID) => durable.request("thread/resume", { threadId: threadID, excludeTurns: true }, ccaDurableAdmissionTimeoutMs),
    pending: () => [],
    answer: async () => "stale",
    close: async () => {},
  }
  const conversation = createCcaDotConversation({
    native: { configuration: async () => configuration, credential: async () => credential },
    durable: () => durable,
    fetch: async (url, init) => {
      const method = init?.method ?? "GET"
      rest.push({ method, url, headers: new Headers(init?.headers), body: init?.body })
      expect(init?.redirect).toBe("error")
      init?.signal?.throwIfAborted()
      const response = routes[`${method} ${url}`]?.shift()
      if (response === undefined) throw new Error(`Unexpected REST request: ${method} ${url}`)
      if (response instanceof Error) throw response
      return response
    },
  })
  return { conversation, rest, requests }
}

test.each(["send", "queue"] as const)("sends the listed root through its room with exact JSON fields in %s mode without durable access", async (mode) => {
  const harness = fixture({ attempts: 2, connected: false })
  const listing = await harness.conversation.threads()
  expect(listing).toEqual({ ok: true, value: {
    dotID, rootThreadID, threads: [{ threadID: rootThreadID, kind: "root" }, { threadID: taskThreadID, kind: "task" }], tasks: [],
  } })
  if (!listing.ok || listing.value.rootThreadID === undefined) throw new Error("Expected a listed root thread")
  expect(await harness.conversation.send(listing.value.rootThreadID, { ...message, mode })).toEqual({ ok: true, value: { admission: "started" } })
  const posts = harness.rest.filter((request) => request.method === "POST")
  expect(posts).toHaveLength(1)
  expect(posts[0].url).toBe(roomURL)
  expect(posts[0].headers.get("content-type")).toBe("application/json")
  expect(posts[0].headers.get("authorization")).toBe(`Bearer ${credential.access}`)
  expect(posts[0].headers.get("chatgpt-account-id")).toBe(configuration.accountID)
  expect(posts[0].headers.has("x-openai-expected-account-id")).toBe(false)
  expect(typeof posts[0].body).toBe("string")
  expect(JSON.parse(String(posts[0].body))).toEqual({
    content: { text: message.text }, request_id: message.clientMessageID, idempotency_token: message.clientMessageID,
    timezone_offset_min: new Date().getTimezoneOffset(),
  })
  expect(harness.requests).toEqual([])
})

test.each([
  ["unparseable JSON", () => new Response("not JSON")],
  ["an empty body", () => new Response(null, { status: 204 })],
  ["a missing message id", () => json({})],
  ["a non-string message id", () => json({ id: 42 })],
  ["an unreadable body", () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("Synthetic read failure")) } }))],
] as const)("reports unknown for a successful room response with %s", async (_name, reply) => {
  const harness = fixture({ roomReplies: [reply()] })
  expect(await harness.conversation.send(rootThreadID, message)).toEqual({ ok: true, value: { admission: "unknown" } })
  expect(harness.rest.filter((request) => request.method === "POST")).toHaveLength(1)
  expect(harness.requests).toEqual([])
})

test.each([408, 429, 500, 503])("reports a room HTTP %i as unknown without replay or durable fallback", async (status) => {
  const harness = fixture({ roomReplies: [json({ detail: "Synthetic unavailable response" }, status)] })
  expect(await harness.conversation.send(rootThreadID, message)).toEqual({ ok: true, value: { admission: "unknown" } })
  expect(harness.rest.filter((request) => request.method === "POST")).toHaveLength(1)
  expect(harness.requests).toEqual([])
})

test("reports a failed room fetch as unknown without replay or durable fallback", async () => {
  const harness = fixture({ roomReplies: [new Error("Synthetic connection reset") ] })
  expect(await harness.conversation.send(rootThreadID, message)).toEqual({ ok: true, value: { admission: "unknown" } })
  expect(harness.rest.filter((request) => request.method === "POST")).toHaveLength(1)
  expect(harness.requests).toEqual([])
})

test("reports a room HTTP 401 as an authentication failure", async () => {
  const harness = fixture({ roomReplies: [json({ detail: "Synthetic sign-in failure" }, 401)] })
  expect(await harness.conversation.send(rootThreadID, message)).toEqual({ ok: false, problem: "authentication" })
  expect(harness.requests).toEqual([])
})

test.each([
  ["a policy rejection", () => json({ detail: { code: "aeon_delivery_rejected", message: "  Synthetic\npolicy\u0007 refusal  " } }, 403), { code: 403, errorCode: "aeon_delivery_rejected", message: "Synthetic policy  refusal" }],
  ["a text response", () => new Response("  Synthetic\ninvalid message  ", { status: 400 }), { code: 400, message: "Synthetic invalid message" }],
  ["a string detail", () => json({ detail: "Synthetic conflicting request" }, 409), { code: 409, message: "Synthetic conflicting request" }],
  ["an oversized detail", () => json({ detail: { code: "x".repeat(200), message: "y".repeat(1500) } }, 422), { code: 422, errorCode: "x".repeat(128), message: "y".repeat(1000) }],
] as const)("preserves a bounded room rejection for %s", async (_name, reply, rejection) => {
  const harness = fixture({ roomReplies: [reply()] })
  expect(await harness.conversation.send(rootThreadID, message)).toEqual({ ok: false, problem: "rejected", rejection })
  expect(harness.requests).toEqual([])
})

test.each([42, "", "x".repeat(257)])("rejects malformed messaging_room_id %j before posting", async (messaging_room_id) => {
  const harness = fixture({ profile: { id: dotID, messaging_room_id } })
  expect(await harness.conversation.send(rootThreadID, message)).toEqual({ ok: false, problem: "malformed" })
  expect(harness.rest.filter((request) => request.method === "POST")).toEqual([])
  expect(harness.requests).toEqual([])
})

test("reuses the same room request and idempotency IDs when a message is resent after an unknown outcome", async () => {
  const harness = fixture({ attempts: 2, roomReplies: [new Error("Synthetic lost response"), json({ id: "synthetic-room-message-0001" })] })
  expect(await harness.conversation.send(rootThreadID, message)).toEqual({ ok: true, value: { admission: "unknown" } })
  expect(await harness.conversation.send(rootThreadID, message)).toEqual({ ok: true, value: { admission: "started" } })
  const bodies = harness.rest.filter((request) => request.method === "POST").map((request) => JSON.parse(String(request.body)))
  expect(bodies.map((body) => [body.request_id, body.idempotency_token])).toEqual([
    [message.clientMessageID, message.clientMessageID], [message.clientMessageID, message.clientMessageID],
  ])
  expect(harness.requests).toEqual([])
})

test("shares one in-flight room send for the same thread and client message ID", async () => {
  const harness = fixture()
  const first = harness.conversation.send(rootThreadID, message)
  const second = harness.conversation.send(rootThreadID, message)
  expect(second).toBe(first)
  expect(await first).toEqual({ ok: true, value: { admission: "started" } })
  expect(harness.rest.filter((request) => request.method === "POST")).toHaveLength(1)
  expect(harness.requests).toEqual([])
})

test.each(["send", "queue"] as const)("keeps task %s delivery on durable resume and turn/addUserMessage", async (mode) => {
  const harness = fixture({ durableReplies: {
    "thread/resume": [{ kind: "result", result: {} }],
    "turn/addUserMessage": [{ kind: "result", result: { admissionOutcome: "started", turn: { id: "synthetic-turn-0001" } } }],
  } })
  expect(await harness.conversation.send(taskThreadID, { ...message, mode })).toEqual({ ok: true, value: { admission: "started", turnID: "synthetic-turn-0001" } })
  expect(harness.requests).toEqual([
    { method: "thread/resume", params: { threadId: taskThreadID, excludeTurns: true }, timeoutMs: ccaDurableAdmissionTimeoutMs },
    { method: "turn/addUserMessage", timeoutMs: ccaDurableAdmissionTimeoutMs, params: {
      threadId: taskThreadID, input: [{ type: "text", text: message.text, text_elements: [] }], clientUserMessageId: message.clientMessageID,
      messageThreadId: expect.stringMatching(/^[0-9a-f-]{36}$/), ...(mode === "queue" ? { mode: "queue" } : {}),
    } },
  ])
  expect(harness.rest.some((request) => request.url === `${base}/tbo/${dotID}` || request.method === "POST")).toBe(false)
})

test("refuses a thread outside the Dot without reading the room or sending", async () => {
  const harness = fixture()
  expect(await harness.conversation.send("thr_synthetic_other_dot", message)).toEqual({ ok: false, problem: "thread-unavailable" })
  expect(harness.rest.some((request) => request.url === `${base}/tbo/${dotID}` || request.method === "POST")).toBe(false)
  expect(harness.requests).toEqual([])
})

test("keeps runtime resume bodyless with its existing JSON headers", async () => {
  const harness = fixture()
  expect(await harness.conversation.resume()).toEqual({ ok: true, value: { outcome: "resumed", threadID: rootThreadID, rootChanged: false } })
  const posts = harness.rest.filter((request) => request.method === "POST")
  expect(posts).toHaveLength(1)
  expect(posts[0].url).toBe(`${base}/tbo/${dotID}/runtime/resume`)
  expect(posts[0].body).toBeUndefined()
  expect(posts[0].headers.get("content-type")).toBe("application/json")
  expect(posts[0].headers.get("x-openai-expected-account-id")).toBeNull()
})

const posts = (harness: ReturnType<typeof fixture>) => harness.rest.filter((request) => request.method === "POST")
const resumeURL = `${base}/tbo/${dotID}/runtime/resume`
const roomCreateURL = `${base}/tbo/${dotID}/messaging-room`
const dmURL = `${base}/messaging/dots/${dotID}/dm`

test("resumes a paused Dot runtime bodylessly before posting the root room message", async () => {
  const harness = fixture({ profile: { id: dotID, messaging_room_id: roomID, is_paused: true } })
  expect(await harness.conversation.send(rootThreadID, message)).toEqual({ ok: true, value: { admission: "started" } })
  expect(posts(harness).map((request) => request.url)).toEqual([resumeURL, roomURL])
  expect(posts(harness)[0].body).toBeUndefined()
  expect(JSON.parse(String(posts(harness)[1].body)).request_id).toBe(message.clientMessageID)
  expect(harness.requests).toEqual([])
})

test.each([
  ["an unconfirmed resume", () => json({ thread_id: rootThreadID, status: "unconfirmed" })],
  ["a resume that moved the root", () => json({ thread_id: "thr_synthetic_conversation_root_0002", status: "resumed" })],
  ["a resume without a thread ID", () => json({ status: "resumed" })],
  ["a resume HTTP 408", () => json({ detail: "Synthetic timeout" }, 408)],
  ["a resume HTTP 429", () => json({ detail: "Synthetic busy" }, 429)],
  ["a resume HTTP 503", () => json({ detail: "Synthetic unavailable" }, 503)],
  ["a failed resume fetch", () => new Error("Synthetic connection reset")],
] as const)("reports unknown without posting the room message after %s for a paused Dot", async (_name, reply) => {
  const harness = fixture({ profile: { id: dotID, messaging_room_id: roomID, is_paused: true }, resumeReplies: [reply()] })
  expect(await harness.conversation.send(rootThreadID, message)).toEqual({ ok: true, value: { admission: "unknown" } })
  expect(posts(harness).map((request) => request.url)).toEqual([resumeURL])
  expect(harness.requests).toEqual([])
})

test.each([
  [401, "authentication"],
  [403, "authentication"],
  [400, "rejected"],
  [404, "rejected"],
] as const)("reports a paused Dot resume HTTP %i as %s without posting the room message", async (status, problem) => {
  const harness = fixture({ profile: { id: dotID, messaging_room_id: roomID, is_paused: true }, resumeReplies: [json({ detail: "Synthetic resume failure" }, status)] })
  expect(await harness.conversation.send(rootThreadID, message)).toEqual({ ok: false, problem })
  expect(posts(harness).map((request) => request.url)).toEqual([resumeURL])
})

test.each([undefined, null])("creates the personal room when messaging_room_id is %j and posts to it with the account header", async (messaging_room_id) => {
  const harness = fixture({ profile: { id: dotID, messaging_room_id }, roomCreateReplies: [json({ id: dotID, messaging_room_id: roomID })] })
  expect(await harness.conversation.send(rootThreadID, message)).toEqual({ ok: true, value: { admission: "started" } })
  expect(posts(harness).map((request) => request.url)).toEqual([roomCreateURL, roomURL])
  expect(posts(harness)[0].body).toBeUndefined()
  expect(posts(harness)[0].headers.get("chatgpt-account-id")).toBe(configuration.accountID)
  expect(posts(harness)[0].headers.has("x-openai-expected-account-id")).toBe(false)
  expect(posts(harness)[0].headers.get("authorization")).toBe(`Bearer ${credential.access}`)
  expect(harness.requests).toEqual([])
})

test.each([
  ["another Dot ID", { id: "tbo_synthetic_other_dot", messaging_room_id: roomID }],
  ["a missing room ID", { id: dotID, messaging_room_id: null }],
  ["a non-string room ID", { id: dotID, messaging_room_id: 42 }],
  ["an empty room ID", { id: dotID, messaging_room_id: "" }],
] as const)("rejects a created personal room response with %s without posting the message", async (_name, body) => {
  const harness = fixture({ profile: { id: dotID, messaging_room_id: null }, roomCreateReplies: [json(body)] })
  expect(await harness.conversation.send(rootThreadID, message)).toEqual({ ok: false, problem: "malformed" })
  expect(posts(harness).map((request) => request.url)).toEqual([roomCreateURL])
})

test.each([
  ["an HTTP 503", () => json({ detail: "Synthetic unavailable" }, 503), { ok: true, value: { admission: "unknown" } }],
  ["a failed fetch", () => new Error("Synthetic connection reset"), { ok: true, value: { admission: "unknown" } }],
  ["an HTTP 401", () => json({ detail: "Synthetic sign-in failure" }, 401), { ok: false, problem: "authentication" }],
  ["an HTTP 409", () => json({ detail: "Synthetic room conflict" }, 409), { ok: false, problem: "rejected", rejection: { code: 409, message: "Synthetic room conflict" } }],
] as const)("does not post the message when personal room creation returns %s", async (_name, reply, result) => {
  const harness = fixture({ profile: { id: dotID, messaging_room_id: null }, roomCreateReplies: [reply()] })
  expect(await harness.conversation.send(rootThreadID, message)).toEqual(result)
  expect(posts(harness).map((request) => request.url)).toEqual([roomCreateURL])
})

test("posts a shared Dot root message to the account DM room instead of the profile room", async () => {
  const harness = fixture({ profile: { id: dotID, scope: "shared", messaging_room_id: "room_synthetic_shared_profile_0001" }, dmReplies: [json({ id: roomID })] })
  expect(await harness.conversation.send(rootThreadID, message)).toEqual({ ok: true, value: { admission: "started" } })
  expect(posts(harness).map((request) => request.url)).toEqual([dmURL, roomURL])
  expect(posts(harness)[0].body).toBeUndefined()
  expect(posts(harness)[0].headers.get("chatgpt-account-id")).toBe(configuration.accountID)
  expect(posts(harness)[0].headers.has("x-openai-expected-account-id")).toBe(false)
})

test.each([{}, { id: 42 }, { id: "" }])("rejects a shared Dot DM response %j without posting the message", async (body) => {
  const harness = fixture({ profile: { id: dotID, scope: "shared" }, dmReplies: [json(body)] })
  expect(await harness.conversation.send(rootThreadID, message)).toEqual({ ok: false, problem: "malformed" })
  expect(posts(harness).map((request) => request.url)).toEqual([dmURL])
})

test("keeps an explicit retired root listed as a task on the durable route without room fallback", async () => {
  const retiredRootThreadID = "thr_synthetic_conversation_retired_root_0001"
  const harness = fixture({ listed: [retiredRootThreadID, taskThreadID] })
  expect(await harness.conversation.send(retiredRootThreadID, message)).toEqual({
    ok: false, problem: "rejected", rejection: { code: -32600, message: "Some requested entity was not found: thread not found" },
  })
  expect(harness.requests).toEqual([{ method: "thread/resume", params: { threadId: retiredRootThreadID, excludeTurns: true }, timeoutMs: ccaDurableAdmissionTimeoutMs }])
  expect(harness.rest.some((request) => request.url === `${base}/tbo/${dotID}` || request.method === "POST")).toBe(false)
})
