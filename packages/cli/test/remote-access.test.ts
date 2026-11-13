import { expect, test } from "bun:test"
import type { RemoteDotsStatus, RemoteRequest } from "@ycoding-ai/remote"
import { createLocalServer, LocalFailure, type LocalServer } from "../src/remote-local"
import { createSessionRegistry, createSubscriptions, executeRemoteOperation } from "../src/remote-operations"

const stubLocal = (handler: ProxyHandler<LocalServer>): LocalServer => new Proxy(Object.create(null), handler)
const rawRequest = (request: object): RemoteRequest => JSON.parse(JSON.stringify(request))

const status: RemoteDotsStatus = { access: { enabled: false, revision: 2 }, configuration: { ready: true, profile: "Synthetic" }, connection: { state: "off" } }

test("remote attachment dispatch preserves the replace mode and target receipt", async () => {
  const target = { dotID: "dot-a", threadID: "thread-a", environmentID: "env-a", revision: "a".repeat(64) }
  const calls: unknown[][] = []
  const local = new Proxy({} as LocalServer, { get: (_target, name) => async (...args: unknown[]) => { calls.push([name, ...args]); return status } })
  const dispatch = (input: Record<string, unknown>) => executeRemoteOperation({ local, sessions: createSessionRegistry({ local }), subscriptions: createSubscriptions(), request: {
    type: "request", id: "req_target", operation: "dots.attach", input,
  } })
  expect(await dispatch({ replaceOthers: false, expectedTarget: target })).toMatchObject([{ ok: true }])
  expect(await dispatch({ replaceOthers: true, expectedTarget: target })).toMatchObject([{ ok: true }])
  expect(calls).toEqual([
    ["dotsAttach", { replaceOthers: false, expectedTarget: target }],
    ["dotsAttach", { replaceOthers: true, expectedTarget: target }],
  ])
})

test("global Dots operations need no Session inventory and preserve exact revision and conflicts", async () => {
  const calls: unknown[][] = []
  let failure: LocalFailure | undefined
  const local = new Proxy({} as LocalServer, { get: (_target, name) => async (...args: unknown[]) => {
    calls.push([name, ...args])
    if (failure) throw failure
    return status
  } })
  const sessions = createSessionRegistry({ local })
  const subscriptions = createSubscriptions()
  const run = (operation: string, input?: Record<string, unknown>, sessionID?: string) => executeRemoteOperation({ request: { type: "request", id: "req_access", operation, sessionID, input } as RemoteRequest, local, sessions, subscriptions })
  expect(await run("dots.get")).toEqual([{ type: "response", id: "req_access", ok: true, value: { data: status } }])
  expect(await run("dots.set", { enabled: true, expectedRevision: 2 })).toEqual([{ type: "response", id: "req_access", ok: true, value: { data: status } }])
  expect(await run("dots.attach", { replaceOthers: false })).toEqual([{ type: "response", id: "req_access", ok: true, value: { data: status } }])
  expect(await run("dots.attach", { replaceOthers: true })).toEqual([{ type: "response", id: "req_access", ok: true, value: { data: status } }])
  expect(calls).toEqual([
    ["dotsGet"],
    ["dotsSet", { enabled: true, expectedRevision: 2 }],
    ["dotsAttach", { replaceOthers: false }],
    ["dotsAttach", { replaceOthers: true }],
  ])
  for (const input of [undefined, {}, { replaceOthers: "true" }, { replaceOthers: 1 }, { replaceOthers: true, environmentID: "env_other" }, { replaceOthers: false, expectedTarget: { dotID: "dot-a" } }])
    expect(await run("dots.attach", input)).toMatchObject([{ ok: false, error: { code: "invalid_message" } }])
  expect(await run("dots.attach", { replaceOthers: true }, "ses_existing")).toMatchObject([{ ok: false, error: { code: "invalid_message" } }])
  calls.length = 2
  for (const input of [{ enabled: true }, { enabled: "true", expectedRevision: 2 }, { enabled: true, expectedRevision: -1 }, { enabled: true, expectedRevision: 1.5 }, { enabled: true, expectedRevision: 2, directory: "/other" }])
    expect(await run("dots.set", input)).toMatchObject([{ ok: false, error: { code: "invalid_message" } }])
  for (const input of [{}, { directory: "/synthetic" }]) expect(await run("dots.get", input)).toMatchObject([{ ok: false, error: { code: "invalid_message" } }])
  expect(await run("dots.get", undefined, "ses_existing")).toMatchObject([{ ok: false, error: { code: "invalid_message" } }])
  expect(await run("dots.set", { enabled: true, expectedRevision: 2 }, "ses_existing")).toMatchObject([{ ok: false, error: { code: "invalid_message" } }])
  expect(await run("session.dots.access.get")).toMatchObject([{ ok: false, error: { code: "unknown_operation" } }])
  expect(await run("session.dots.access.set", { enabled: true, expectedRevision: 2 })).toMatchObject([{ ok: false }])
  expect(calls).toHaveLength(2)
  failure = new LocalFailure("conflict", "Synthetic conflict")
  expect(await run("dots.set", { enabled: true, expectedRevision: 1 })).toMatchObject([{ ok: false, error: { code: "invalid_message" } }])
  failure = new LocalFailure("transport", "Synthetic incomplete response")
  expect(await run("dots.set", { enabled: true, expectedRevision: 2 })).toMatchObject([{ ok: false, error: { code: "outcome_unknown" } }])
  expect(await run("dots.attach", { replaceOthers: true })).toMatchObject([{ ok: false, error: { code: "outcome_unknown" } }])
  expect(calls).toHaveLength(5)
  expect(calls.at(-1)).toEqual(["dotsAttach", { replaceOthers: true }])
})

test("global Dots local adapter sends no Session or Location and only revision-fenced fields", async () => {
  const requests: unknown[] = []
  const server = Bun.serve({ port: 0, fetch: async (request) => {
    requests.push({ path: new URL(request.url).pathname, query: new URL(request.url).search, method: request.method, directory: request.headers.get("x-ycoding-directory"), workspace: request.headers.get("x-ycoding-workspace"), body: request.method === "GET" ? undefined : await request.json() })
    return Response.json({ data: status })
  } })
  try {
    const local = createLocalServer({ url: server.url.href })
    expect(await local.dotsGet()).toEqual(status)
    expect(await local.dotsSet({ enabled: true, expectedRevision: 2 })).toEqual(status)
    expect(await local.dotsAttach({ replaceOthers: false })).toEqual(status)
    const target = { dotID: "dot-a", threadID: "thread-a", environmentID: "env-a", revision: "a".repeat(64) }
    expect(await local.dotsAttach({ replaceOthers: true, expectedTarget: target })).toEqual(status)
    expect(requests).toEqual([
      { path: "/api/dots", query: "", method: "GET", directory: null, workspace: null, body: undefined },
      { path: "/api/dots", query: "", method: "PUT", directory: null, workspace: null, body: { enabled: true, expectedRevision: 2 } },
      { path: "/api/dots/computer", query: "", method: "POST", directory: null, workspace: null, body: { replaceOthers: false } },
      { path: "/api/dots/computer", query: "", method: "POST", directory: null, workspace: null, body: { replaceOthers: true, expectedTarget: target } },
    ])
  } finally { await server.stop(true) }
})

test("remote detachment and removal dispatch preserve the optional target receipt and reject unknown fields", async () => {
  const target = { dotID: "dot-a", threadID: "thread-a", environmentID: "env-a", revision: "a".repeat(64) }
  const calls: unknown[][] = []
  const local = stubLocal({ get: (_target, name) => async (...args: unknown[]) => { calls.push([name, ...args]); return status } })
  const dispatch = (operation: string, input?: Record<string, unknown>, sessionID?: string) => executeRemoteOperation({ local, sessions: createSessionRegistry({ local }), subscriptions: createSubscriptions(), request: rawRequest({
    type: "request", id: "req_detach", operation, sessionID, input,
  }) })
  expect(await dispatch("dots.detach")).toEqual([{ type: "response", id: "req_detach", ok: true, value: { data: status } }])
  expect(await dispatch("dots.detach", { expectedTarget: target })).toMatchObject([{ ok: true }])
  expect(await dispatch("dots.remove", {})).toMatchObject([{ ok: true }])
  expect(await dispatch("dots.remove", { expectedTarget: target })).toMatchObject([{ ok: true }])
  expect(calls).toEqual([["dotsDetach", {}], ["dotsDetach", { expectedTarget: target }], ["dotsRemove", {}], ["dotsRemove", { expectedTarget: target }]])
  for (const operation of ["dots.detach", "dots.remove"]) {
    for (const input of [{ replaceOthers: false }, { expectedTarget: { dotID: "dot-a" } }])
      expect(await dispatch(operation, input)).toMatchObject([{ ok: false, error: { code: "invalid_message" } }])
    expect(await dispatch(operation, {}, "ses_existing")).toMatchObject([{ ok: false, error: { code: "invalid_message" } }])
  }
  expect(calls).toHaveLength(4)
  const failing = stubLocal({ get: () => async () => { throw new LocalFailure("transport", "Synthetic incomplete response") } })
  for (const operation of ["dots.detach", "dots.remove"])
    expect(await executeRemoteOperation({ local: failing, sessions: createSessionRegistry({ local: failing }), subscriptions: createSubscriptions(), request: rawRequest({ type: "request", id: "req_x", operation }) }))
      .toMatchObject([{ ok: false, error: { code: "outcome_unknown" } }])
})

test("the browser relay does not expose the Dot conversation operations", async () => {
  const calls: unknown[][] = []
  const local = stubLocal({ get: (_target, name) => async (...args: unknown[]) => { calls.push([name, ...args]); return status } })
  for (const operation of ["dots.threads", "dots.task.updates", "dots.thread.read", "dots.thread.send", "dots.thread.interrupt", "dots.resume", "dots.thread.requests", "dots.thread.respond"])
    expect(await executeRemoteOperation({ local, sessions: createSessionRegistry({ local }), subscriptions: createSubscriptions(), request: rawRequest({
      type: "request", id: "req_conversation", operation,
    }) })).toMatchObject([{ ok: false, error: { code: "unknown_operation" } }])
  expect(calls).toEqual([])
})
