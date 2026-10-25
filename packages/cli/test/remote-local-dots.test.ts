import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLocalServer, LocalFailure } from "../src/remote-local"
import { createSessionRegistry, createSubscriptions, executeRemoteOperation } from "../src/remote-operations"
import { SessionID } from "@ycoding-ai/schema/session-id"

type Recorded = {
  readonly method: string
  readonly path: string
  readonly query: Record<string, string>
  readonly directory: string | null
  readonly workspace: string | null
  readonly body: unknown
}

const sessionID = "ses_dots_cli"
const location = { directory: "/work/synthetic dots repository", workspaceID: "wsp_dots" }
const target = {
  profile: "synthetic-profile",
  dotID: "dot_synthetic",
  threadID: "thread_synthetic",
  generation: "generation-1",
  label: "Synthetic Dot",
}
const send = {
  id: "msg_synthetic_send",
  text: "Synthetic message",
  files: [{ uri: "ycoding-attachment://sha256/" + "a".repeat(64), name: "synthetic.txt" }],
  causalMessageID: "msg_synthetic_cause",
  expectedTarget: target,
}

const serve = (respond: (request: Recorded) => Response) => {
  const requests: Recorded[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const text = request.method === "GET" ? "" : await request.text()
      const recorded = {
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        directory: request.headers.get("x-ycoding-directory"),
        workspace: request.headers.get("x-ycoding-workspace"),
        body: text === "" ? undefined : JSON.parse(text),
      }
      requests.push(recorded)
      return respond(recorded)
    },
  })
  return {
    requests,
    server,
    local: createLocalServer({ url: `http://127.0.0.1:${server.port}` }, { timeoutMs: 2_000 }),
  }
}

const calls = (local: ReturnType<typeof createLocalServer>) => [
  () => local.dotsTargets(sessionID, location, target.profile),
  () => local.dotsStatus(sessionID, location),
  () => local.dotsBind(sessionID, location, target),
  () => local.dotsSend(sessionID, location, send),
  () => local.dotsPause(sessionID, location, target),
  () => local.dotsResume(sessionID, location, target),
]

test("the local Dots status preserves a disabled capability without native discovery", async () => {
  const { requests, server, local } = serve(() => Response.json({ data: { enabled: false, state: "disconnected" } }))
  try {
    expect(await local.dotsStatus(sessionID, location)).toEqual({ enabled: false, state: "disconnected" })
    expect(requests.map(request => [request.method, request.path])).toEqual([["GET", `/api/session/${sessionID}/dots`]])
  } finally {
    await server.stop(true)
  }
})

test("each Dots method forwards its exact endpoint, identity and arguments and returns the server result", async () => {
  const status = { enabled: true, state: "connected", target }
  const delivery = { messageID: send.id, status: "accepted" }
  const { requests, server, local } = serve((request) => {
    if (request.path.endsWith("/dots/targets")) return Response.json({ data: [target] })
    if (request.path.endsWith("/dots/bind")) return Response.json({ data: status })
    if (request.path.endsWith("/dots/send")) return Response.json({ data: delivery })
    if (request.path.endsWith("/dots/pause")) return Response.json({ data: { ...status, runtimeState: "paused" } })
    if (request.path.endsWith("/dots/resume")) return Response.json({ data: { ...status, runtimeState: "unpaused" } })
    return Response.json({ data: status })
  })
  try {
    const results = []
    for (const call of calls(local)) results.push(await call())
    expect(results).toEqual([[target], status, status, delivery, { ...status, runtimeState: "paused" }, { ...status, runtimeState: "unpaused" }])
    const headers = { directory: encodeURIComponent(location.directory), workspace: location.workspaceID }
    expect(requests).toEqual([
      {
        method: "GET",
        path: `/api/session/${sessionID}/dots/targets`,
        query: { profile: target.profile },
        ...headers,
        body: undefined,
      },
      { method: "GET", path: `/api/session/${sessionID}/dots`, query: {}, ...headers, body: undefined },
      { method: "POST", path: `/api/session/${sessionID}/dots/bind`, query: {}, ...headers, body: target },
      { method: "POST", path: `/api/session/${sessionID}/dots/send`, query: {}, ...headers, body: send },
      {
        method: "POST",
        path: `/api/session/${sessionID}/dots/pause`,
        query: {},
        ...headers,
        body: { expectedTarget: target },
      },
      {
        method: "POST",
        path: `/api/session/${sessionID}/dots/resume`,
        query: {},
        ...headers,
        body: { expectedTarget: target },
      },
    ])
  } finally {
    await server.stop(true)
  }
})

test("each Dots method surfaces a rejected request as an invalid local failure, never success", async () => {
  const { requests, server, local } = serve(() =>
    Response.json({ _tag: "InvalidRequestError", message: "Synthetic Dots rejection", field: "dots" }, { status: 400 }),
  )
  try {
    for (const call of calls(local)) {
      const failure = await call().then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(failure).toBeInstanceOf(LocalFailure)
      expect(failure).toMatchObject({ kind: "invalid" })
    }
    expect(requests).toHaveLength(6)
  } finally {
    await server.stop(true)
  }
})

test("an admitted exchange with an unconfirmed return maps to an unknown outcome without replay", async () => {
  const { requests, server, local } = serve(() => Response.json({
    _tag: "InvalidRequestError", field: "dots", kind: "outcome_unknown", message: "Admission occurred; inspect the exchange.",
  }, { status: 400 }))
  try {
    const failure = await local.dotsExchangeCreate(sessionID, location, {
      exchangeID: "exchange_uncertain", expectedAttachment: target, targetSessionID: SessionID.make("ses_target"), channel: "task", delivery: "queue", text: "Synthetic task",
    }, { requestID: "request_fixture", epoch: "epoch_fixture", principal: { ownerID: "owner_fixture", deviceID: "device_fixture", clientID: "client_fixture" } }).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(LocalFailure)
    expect(failure).toMatchObject({ kind: "transport" })
    expect(requests).toHaveLength(1)
  } finally {
    await server.stop(true)
  }
})

test("each Dots method surfaces a missing Session as a not-found local failure, never success", async () => {
  const { server, local } = serve(() =>
    Response.json(
      { _tag: "SessionNotFoundError", sessionID, message: `Session not found: ${sessionID}` },
      { status: 404 },
    ),
  )
  try {
    for (const call of calls(local)) {
      const failure = await call().then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(failure).toBeInstanceOf(LocalFailure)
      expect(failure).toMatchObject({ kind: "not_found" })
    }
  } finally {
    await server.stop(true)
  }
})

test("runtime controls use the verified Session Location and preserve returned state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ycoding-dots-control-"))
  const currentLocation = { ...location, directory }
  const session = {
    id: sessionID,
    projectID: "global",
    title: "Synthetic Dots Session",
    agent: "build",
    model: { providerID: "test", id: "test" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
    location: currentLocation,
  }
  let parentID: string | undefined
  let failControls = false
  const { requests, server, local } = serve((request) => {
    const info = { ...session, ...(parentID === undefined ? {} : { parentID }) }
    if (request.path === "/api/session") return Response.json({ data: [info], cursor: {} })
    if (request.path === `/api/session/${sessionID}`) return Response.json({ data: info })
    if (request.path.endsWith("/dots/targets")) return Response.json({ data: [target] })
    if (request.path.endsWith("/dots/send")) return Response.json({ data: { messageID: send.id, status: "accepted" } })
    if (failControls) return Response.json({ error: "Unavailable" }, { status: 503 })
    return Response.json({ data: { enabled: true, state: "connected", target, runtimeState: request.path.endsWith("/pause") ? "paused" : "unknown" } })
  })
  const sessions = createSessionRegistry({ local, verifyWindowMs: 0 })
  const subscriptions = createSubscriptions()
  try {
    await sessions.refresh()
    for (const [operation, input] of [
      ["session.dots.targets", { profile: target.profile }],
      ["session.dots.status", undefined],
      ["session.dots.bind", target],
      ["session.dots.send", { id: send.id, text: send.text, expectedTarget: target }],
    ] as const) {
      const result = await executeRemoteOperation({ request: { type: "request", id: "req_existing", operation, sessionID, input }, local, sessions, subscriptions })
      expect(result[0]).toMatchObject({ ok: true })
    }
    for (const operation of ["session.dots.pause", "session.dots.resume"] as const) {
      requests.length = 0
      const result = await executeRemoteOperation({
        request: { type: "request", id: "req_control", operation, sessionID, input: { expectedTarget: target } },
        local, sessions, subscriptions,
      })
      expect(result).toEqual([{ type: "response", id: "req_control", ok: true, value: {
        data: { enabled: true, state: "connected", target, runtimeState: operation.endsWith("pause") ? "paused" : "unknown" },
      } }])
      expect(requests.filter((request) => request.method === "POST")).toEqual([{
        method: "POST", path: `/api/session/${sessionID}/dots/${operation.endsWith("pause") ? "pause" : "resume"}`,
        query: {}, directory: encodeURIComponent(currentLocation.directory), workspace: currentLocation.workspaceID,
        body: { expectedTarget: target },
      }])
      for (const input of [{ expectedTarget: target, directory: "/other" }, { turnID: "turn" }]) {
        requests.length = 0
        const invalid = await executeRemoteOperation({ request: { type: "request", id: "req_invalid", operation, sessionID, input }, local, sessions, subscriptions })
        expect(invalid[0]).toMatchObject({ ok: false, error: { code: "invalid_message" } })
        expect(requests.some((request) => request.method === "POST")).toBe(false)
      }
    }
    failControls = true
    for (const operation of ["session.dots.pause", "session.dots.resume"] as const) {
      requests.length = 0
      const result = await executeRemoteOperation({ request: { type: "request", id: "req_unknown", operation, sessionID, input: { expectedTarget: target } }, local, sessions, subscriptions })
      expect(result[0]).toMatchObject({ ok: false, error: { code: "outcome_unknown" } })
      expect(requests.filter((request) => request.method === "POST")).toHaveLength(1)
    }
    failControls = false
    parentID = "ses_parent"
    await sessions.refresh()
    requests.length = 0
    for (const operation of ["session.dots.pause", "session.dots.resume"] as const) {
      const result = await executeRemoteOperation({ request: { type: "request", id: "req_child", operation, sessionID, input: { expectedTarget: target } }, local, sessions, subscriptions })
      expect(result[0]).toMatchObject({ ok: false, error: { code: "subagent_read_only" } })
    }
    expect(requests.some((request) => request.method === "POST")).toBe(false)
  } finally {
    await server.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
})
