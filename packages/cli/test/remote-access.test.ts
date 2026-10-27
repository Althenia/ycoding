import { expect, test } from "bun:test"
import type { SessionInfo } from "@ycoding-ai/client/promise"
import type { RemoteRequest } from "@ycoding-ai/remote"
import { createLocalServer, LocalFailure, type LocalServer } from "../src/remote-local"
import { createSessionRegistry, createSubscriptions, executeRemoteOperation } from "../src/remote-operations"

const session = { id: "ses_access", projectID: "prj_access", title: "Synthetic access", time: { created: 1, updated: 1 }, location: { directory: "/synthetic" } } as SessionInfo
const access = { sessionID: session.id, rootSessionID: session.id, enabled: false, configured: true, inherited: false, revision: 2 }

test("Dots access operations verify the Session and preserve exact revision and conflicts", async () => {
  const calls: unknown[][] = []
  let failure: LocalFailure | undefined
  const local = new Proxy({} as LocalServer, { get: (_target, name) => async (...args: unknown[]) => {
    if (name === "listPage") return { data: [session] }
    if (name === "getSession") return args[0] === session.id ? session : undefined
    calls.push([name, ...args])
    if (failure) throw failure
    return access
  } })
  const sessions = createSessionRegistry({ local })
  await sessions.refresh()
  const subscriptions = createSubscriptions()
  const run = (operation: string, input?: Record<string, unknown>, sessionID = session.id) => executeRemoteOperation({ request: { type: "request", id: "req_access", operation, sessionID, input } as RemoteRequest, local, sessions, subscriptions })
  expect(await run("session.dots.access.get")).toEqual([{ type: "response", id: "req_access", ok: true, value: { data: access } }])
  expect(await run("session.dots.access.set", { enabled: true, expectedRevision: 2 })).toEqual([{ type: "response", id: "req_access", ok: true, value: { data: access } }])
  expect(calls).toEqual([
    ["dotsAccessGet", session.id, session.location],
    ["dotsAccessSet", session.id, session.location, { enabled: true, expectedRevision: 2 }],
  ])
  for (const input of [{ enabled: true }, { enabled: "true", expectedRevision: 2 }, { enabled: true, expectedRevision: -1 }, { enabled: true, expectedRevision: 1.5 }, { enabled: true, expectedRevision: 2, directory: "/other" }])
    expect(await run("session.dots.access.set", input)).toMatchObject([{ ok: false, error: { code: "invalid_message" } }])
  expect(await run("session.dots.access.get", undefined, "ses_missing")).toMatchObject([{ ok: false, error: { code: "session_not_allowed" } }])
  expect(calls).toHaveLength(2)
  failure = new LocalFailure("conflict", "Synthetic conflict")
  expect(await run("session.dots.access.set", { enabled: true, expectedRevision: 1 })).toMatchObject([{ ok: false, error: { code: "invalid_message" } }])
  failure = new LocalFailure("transport", "Synthetic incomplete response")
  expect(await run("session.dots.access.set", { enabled: true, expectedRevision: 2 })).toMatchObject([{ ok: false, error: { code: "outcome_unknown" } }])
  expect(calls).toHaveLength(4)
})

test("Dots access local adapter sends only bound Location and revision fields", async () => {
  const requests: unknown[] = []
  const server = Bun.serve({ port: 0, fetch: async (request) => {
    requests.push({ path: new URL(request.url).pathname, method: request.method, directory: request.headers.get("x-ycoding-directory"), workspace: request.headers.get("x-ycoding-workspace"), body: request.method === "GET" ? undefined : await request.json() })
    return Response.json({ data: access })
  } })
  try {
    const local = createLocalServer({ url: server.url.href })
    const location = { directory: "/synthetic location", workspaceID: "wrk_synthetic" }
    expect(await local.dotsAccessGet(session.id, location)).toEqual(access)
    expect(await local.dotsAccessSet(session.id, location, { enabled: true, expectedRevision: 2 })).toEqual(access)
    expect(requests).toEqual([
      { path: `/api/session/${session.id}/dots/access`, method: "GET", directory: encodeURIComponent(location.directory), workspace: location.workspaceID, body: undefined },
      { path: `/api/session/${session.id}/dots/access`, method: "POST", directory: encodeURIComponent(location.directory), workspace: location.workspaceID, body: { enabled: true, expectedRevision: 2 } },
    ])
  } finally { await server.stop(true) }
})
