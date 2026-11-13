import { expect, test } from "bun:test"
import { DotsAccess } from "@ycoding-ai/core/dots/access"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@ycoding-ai/protocol/middleware/schema-error"
import { UnauthorizedError } from "@ycoding-ai/protocol/errors"
import { Context, Effect, Layer } from "effect"
import { HttpRouter, HttpServer, HttpServerRequest } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../src/api"
import { DotsHandler } from "../src/handlers/dots"

const conversationUnavailable = () => Effect.fail(new DotsAccess.Error({ code: "unavailable", message: "The Dots conversation connection is not ready. Try again shortly." }))
const conversationStubs = {
  threads: conversationUnavailable, taskUpdates: conversationUnavailable, readThread: conversationUnavailable, sendMessage: conversationUnavailable,
  interruptTurn: conversationUnavailable, resume: conversationUnavailable, requests: conversationUnavailable, respond: conversationUnavailable,
}

const serve = (service: DotsAccess.Interface) => {
  const handler = HttpRouter.toWebHandler(HttpApiBuilder.layer(HttpApi.make("server").add(Api.groups["server.dots"]).middleware(Authorization).middleware(SchemaErrorMiddleware)).pipe(
    Layer.provide(DotsHandler),
    Layer.provide(Layer.mergeAll(
      Layer.succeed(Authorization, (effect) => Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (request.headers.authorization !== "Bearer synthetic") return yield* new UnauthorizedError({ message: "Authentication required" })
        return yield* effect
      })),
      Layer.succeed(SchemaErrorMiddleware, (effect) => effect),
    )),
    Layer.provide(HttpServer.layerServices),
  ))
  const request = (method: string, pathname: string, body?: unknown, authenticated = true) => handler.handler(new Request(`http://localhost${pathname}`, {
    method, headers: { ...(authenticated ? { authorization: "Bearer synthetic" } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), Context.make(DotsAccess.Service, service))
  return { request, dispose: () => handler.dispose() }
}

test("global Dots HTTP requires authentication without Session middleware and enforces exact CAS payloads", async () => {
  let state = { enabled: false, revision: 0 }
  const calls: unknown[] = []
  const service = DotsAccess.Service.of({
    get: () => Effect.succeed(state),
    status: () => Effect.succeed({ access: state, configuration: { ready: true, profile: "trusted" }, connection: { state: "off" } }),
    set: (input) => Effect.gen(function* () {
      calls.push(input)
      if (input.expectedRevision !== state.revision) return yield* new DotsAccess.Error({ code: "conflict", message: "Stale revision" })
      if (state.enabled !== input.enabled) state = { enabled: input.enabled, revision: state.revision + 1 }
      return state
    }),
    attachComputer: (target) => Effect.sync(() => {
      calls.push(target ?? "attach")
      return { access: state, configuration: { ready: true, profile: "trusted" }, connection: { state: "connected" }, computer: { state: "attached" } }
    }),
    detachComputer: (input) => Effect.sync(() => {
      calls.push({ detach: input })
      return { access: state, configuration: { ready: true, profile: "trusted" }, connection: { state: "connected" }, computer: { state: "detached" } }
    }),
    removeComputer: (input) => Effect.sync(() => {
      calls.push({ remove: input })
      return { access: state, configuration: { ready: true, profile: "trusted" }, connection: { state: "off" }, computer: { state: "removed" } }
    }),
    ...conversationStubs,
    subscribe: () => () => {},
    attachTransport: () => () => {},
  })
  const handler = HttpRouter.toWebHandler(HttpApiBuilder.layer(HttpApi.make("server").add(Api.groups["server.dots"]).middleware(Authorization).middleware(SchemaErrorMiddleware)).pipe(
    Layer.provide(DotsHandler),
    Layer.provide(Layer.mergeAll(
      Layer.succeed(Authorization, (effect) => Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (request.headers.authorization !== "Bearer synthetic") return yield* new UnauthorizedError({ message: "Authentication required" })
        return yield* effect
      })),
      Layer.succeed(SchemaErrorMiddleware, (effect) => effect),
    )),
    Layer.provide(HttpServer.layerServices),
  ))
  const request = (method: string, body?: unknown, pathname = "/api/dots", authenticated = true) => handler.handler(new Request(`http://localhost${pathname}`, {
    method, headers: { ...(authenticated ? { authorization: "Bearer synthetic" } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), Context.make(DotsAccess.Service, service))
  try {
    expect((await request("GET", undefined, "/api/dots", false)).status).toBe(401)
    expect((await request("PUT", { enabled: true, expectedRevision: 0 }, "/api/dots", false)).status).toBe(401)
    expect(calls).toEqual([])
    expect(await (await request("GET")).json()).toEqual({ data: { access: state, configuration: { ready: true, profile: "trusted" }, connection: { state: "off" } } })
    for (const body of [{ enabled: true }, { enabled: true, expectedRevision: -1 }, { enabled: true, expectedRevision: 0, sessionID: "ses_root" }, { enabled: true, expectedRevision: 0, source: {} }, { enabled: true, expectedRevision: 0, explicitDecision: true }, { enabled: true, expectedRevision: 0, validate: true }])
      expect((await request("PUT", body)).status).toBe(400)
    expect(calls).toHaveLength(0)
    const accepted = await request("PUT", { enabled: true, expectedRevision: 0 })
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toEqual({ data: { access: { enabled: true, revision: 1 }, configuration: { ready: true, profile: "trusted" }, connection: { state: "off" } } })
    expect((await request("PUT", { enabled: false, expectedRevision: 0 })).status).toBe(409)
    expect((await request("POST", { enabled: false, expectedRevision: 1 })).status).toBe(404)
    expect((await request("GET", undefined, "/api/session/ses_root/dots/access")).status).toBe(404)
    calls.length = 0
    expect((await request("POST", { replaceOthers: true }, "/api/dots/computer", false)).status).toBe(401)
    for (const body of [{}, { replaceOthers: "true" }, { replaceOthers: 1 }, { replaceOthers: true, environmentID: "env_other" }])
      expect((await request("POST", body, "/api/dots/computer")).status).toBe(400)
    expect(calls).toEqual([])
    const attached = await request("POST", { replaceOthers: false }, "/api/dots/computer")
    expect(attached.status).toBe(200)
    expect(await attached.json()).toEqual({ data: { access: state, configuration: { ready: true, profile: "trusted" }, connection: { state: "connected" }, computer: { state: "attached" } } })
    expect(calls).toEqual([{ replaceOthers: false }])
    const target = { dotID: "dot-a", threadID: "thread-a", environmentID: "env-a", revision: "a".repeat(64) }
    expect((await request("POST", { replaceOthers: true, expectedTarget: target }, "/api/dots/computer")).status).toBe(200)
    expect(calls).toEqual([{ replaceOthers: false }, { replaceOthers: true, expectedTarget: target }])
    expect((await request("POST", { replaceOthers: true, expectedTarget: { ...target, revision: "short" } }, "/api/dots/computer")).status).toBe(400)
    expect(calls).toEqual([{ replaceOthers: false }, { replaceOthers: true, expectedTarget: target }])
    calls.length = 0
    for (const [name, key, computer] of [["detach", "detach", "detached"], ["remove", "remove", "removed"]] as const) {
      const path = `/api/dots/computer/${name}`
      expect((await request("POST", {}, path, false)).status).toBe(401)
      for (const body of [{ replaceOthers: false }, { expectedTarget: { ...target, revision: "short" } }, { expectedTarget: target, extra: true }])
        expect((await request("POST", body, path)).status).toBe(400)
      expect((await request("GET", undefined, path)).status).toBe(404)
      expect(calls).toEqual([])
      const done = await request("POST", {}, path)
      expect(done.status).toBe(200)
      const body: { data: { computer: { state: string } } } = await done.json()
      expect(body.data.computer.state).toBe(computer)
      expect((await request("POST", { expectedTarget: target }, path)).status).toBe(200)
      expect(calls).toEqual([{ [key]: {} }, { [key]: { expectedTarget: target } }])
      calls.length = 0
    }
  } finally {
    await handler.dispose()
  }
})

test("Dot conversation HTTP requires authentication, validates exact inputs and maps a stale answer to a conflict", async () => {
  const calls: unknown[] = []
  const state = { enabled: true, revision: 1 }
  const status = { access: state, configuration: { ready: true }, connection: { state: "connected" as const } }
  const service = DotsAccess.Service.of({
    get: () => Effect.succeed(state), status: () => Effect.succeed(status), set: () => Effect.succeed(state),
    attachComputer: () => Effect.succeed(status), detachComputer: () => Effect.succeed(status), removeComputer: () => Effect.succeed(status),
    subscribe: () => () => {}, attachTransport: () => () => {},
    threads: () => Effect.sync(() => { calls.push(["threads"]); return { dotID: "dot-a", rootThreadID: "thr-root", threads: [{ threadID: "thr-root", kind: "root" as const }], tasks: [] } }),
    taskUpdates: (taskID, page) => Effect.sync(() => { calls.push(["taskUpdates", taskID, page]); return { taskID, updates: [] } }),
    readThread: (threadID, page) => Effect.sync(() => { calls.push(["readThread", threadID, page]); return { thread: { threadID, kind: "task" as const }, turns: [] } }),
    sendMessage: (threadID, input) => Effect.gen(function* () {
      calls.push(["sendMessage", threadID, input])
      if (threadID === "thr-refused") return yield* new DotsAccess.Error({ code: "unavailable", message: "ChatGPT refused the request.", rejection: { code: -32602, message: "thread busy" } })
      return { admission: "started" as const, turnID: "turn-1" }
    }),
    interruptTurn: (threadID, input) => Effect.sync(() => { calls.push(["interruptTurn", threadID, input]); return { outcome: "interrupted" as const } }),
    resume: () => Effect.sync(() => { calls.push(["resume"]); return { outcome: "unconfirmed" as const, threadID: "thr-root", rootChanged: false } }),
    requests: (threadID) => Effect.sync(() => { calls.push(["requests", threadID]); return { threadID, requests: [] } }),
    respond: (threadID, requestID, input) => Effect.gen(function* () {
      calls.push(["respond", threadID, requestID, input])
      if (requestID === "req-stale") return yield* new DotsAccess.Error({ code: "conflict", message: "This request was already answered or is no longer pending. Refresh the pending requests." })
      if (requestID === "req-invalid") return yield* new DotsAccess.Error({ code: "invalid_input", message: "Invalid Dots conversation request" })
      return { outcome: "sent" as const }
    }),
  })
  const { request, dispose } = serve(service)
  try {
    const message = { text: "Continue", clientMessageID: "client-1", mode: "queue" }
    for (const [method, path, body] of [
      ["GET", "/api/dots/threads", undefined], ["GET", "/api/dots/tasks/task-a/updates", undefined], ["GET", "/api/dots/thread/thr-a", undefined],
      ["POST", "/api/dots/thread/thr-a/message", message], ["POST", "/api/dots/thread/thr-a/interrupt", { turnID: "turn-1" }], ["POST", "/api/dots/resume", undefined],
      ["GET", "/api/dots/thread/thr-a/requests", undefined], ["POST", "/api/dots/thread/thr-a/requests/req-1", { decision: "accept" }],
    ] as const) expect((await request(method, path, body, false)).status).toBe(401)
    expect(calls).toEqual([])
    for (const body of [{ ...message, mode: "steer" }, { ...message, text: "   " }, { text: "x", mode: "send" }, { ...message, extra: true }, { ...message, text: "x".repeat(32769) }])
      expect((await request("POST", "/api/dots/thread/thr-a/message", body)).status).toBe(400)
    for (const body of [{ decision: "approve" }, { answers: { q: [] } }, { decision: "accept", extra: true }])
      expect((await request("POST", "/api/dots/thread/thr-a/requests/req-1", body)).status).toBe(400)
    expect((await request("GET", "/api/dots/thread/thr-a?limit=51")).status).toBe(400)
    expect((await request("POST", "/api/dots/thread/thr-a/interrupt", {})).status).toBe(400)
    expect(calls).toEqual([])
    expect(await (await request("GET", "/api/dots/threads")).json()).toEqual({ data: { dotID: "dot-a", rootThreadID: "thr-root", threads: [{ threadID: "thr-root", kind: "root" }], tasks: [] } })
    expect((await request("GET", "/api/dots/tasks/task-a/updates?cursor=c1&limit=5")).status).toBe(200)
    expect((await request("GET", "/api/dots/thread/thr-a?limit=10")).status).toBe(200)
    expect(await (await request("POST", "/api/dots/thread/thr-a/message", message)).json()).toEqual({ data: { admission: "started", turnID: "turn-1" } })
    expect((await request("POST", "/api/dots/thread/thr-a/interrupt", { turnID: "turn-1" })).status).toBe(200)
    expect(await (await request("POST", "/api/dots/resume")).json()).toEqual({ data: { outcome: "unconfirmed", threadID: "thr-root", rootChanged: false } })
    expect((await request("GET", "/api/dots/thread/thr-a/requests")).status).toBe(200)
    expect(await (await request("POST", "/api/dots/thread/thr-a/requests/req-1", { answers: { q1: ["yes"] } })).json()).toEqual({ data: { outcome: "sent" } })
    expect((await request("POST", "/api/dots/thread/thr-a/requests/req-stale", { decision: "decline" })).status).toBe(409)
    expect((await request("POST", "/api/dots/thread/thr-a/requests/req-invalid", { decision: "accept", answers: { q1: ["yes"] } })).status).toBe(400)
    const refused = await request("POST", "/api/dots/thread/thr-refused/message", message)
    expect(refused.status).toBe(400)
    expect(await refused.json()).toEqual({ _tag: "InvalidRequestError", message: "ChatGPT refused the request.", rejection: { code: -32602, message: "thread busy" } })
    calls.pop()
    expect(calls).toEqual([
      ["threads"], ["taskUpdates", "task-a", { cursor: "c1", limit: 5 }], ["readThread", "thr-a", { limit: 10 }], ["sendMessage", "thr-a", message],
      ["interruptTurn", "thr-a", { turnID: "turn-1" }], ["resume"], ["requests", "thr-a"],
      ["respond", "thr-a", "req-1", { answers: { q1: ["yes"] } }], ["respond", "thr-a", "req-stale", { decision: "decline" }],
      ["respond", "thr-a", "req-invalid", { decision: "accept", answers: { q1: ["yes"] } }],
    ])
  } finally {
    await dispose()
  }
})
