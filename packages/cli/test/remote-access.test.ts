import { expect, test } from "bun:test"
import type { RemoteDotsStatus, RemoteRequest } from "@ycoding-ai/remote"
import { createLocalServer, LocalFailure, type LocalServer } from "../src/remote-local"
import { createSessionRegistry, createSubscriptions, executeRemoteOperation } from "../src/remote-operations"

const status: RemoteDotsStatus = { access: { enabled: false, revision: 2 }, configuration: { ready: true, profile: "Synthetic" }, connection: { state: "off" } }

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
  expect(calls).toEqual([
    ["dotsGet"],
    ["dotsSet", { enabled: true, expectedRevision: 2 }],
  ])
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
  expect(calls).toHaveLength(4)
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
    expect(requests).toEqual([
      { path: "/api/dots", query: "", method: "GET", directory: null, workspace: null, body: undefined },
      { path: "/api/dots", query: "", method: "PUT", directory: null, workspace: null, body: { enabled: true, expectedRevision: 2 } },
    ])
  } finally { await server.stop(true) }
})
