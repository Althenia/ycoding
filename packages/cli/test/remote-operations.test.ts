import { describe, expect, test } from "bun:test"
import type { SessionInfo } from "@ycoding-ai/client/promise"
import { RemoteLimits, parseChunkedValue, requireSession, type RemoteRequest } from "@ycoding-ai/remote"
import type { AllowlistSession } from "../src/remote-config"
import { assertPrivateEndpoint, type LocalLocation, type LocalServer } from "../src/remote-local"
import { LocalFailure as LocalFailureClass } from "../src/remote-local"
import {
  createSessionRegistry,
  createSubscriptions,
  executeRemoteOperation,
  listPage,
  parseListQuery,
  successFrames,
} from "../src/remote-operations"

function sessionInfo(id: string, table: { updated: number; title?: string; directory?: string; parentID?: string }): SessionInfo {
  const directory = table.directory ?? "/work"
  return {
    id,
    ...(table.parentID === undefined ? {} : { parentID: table.parentID }),
    projectID: "prj_1",
    // The contract carries a Model.Ref object, never a provider/model string.
    model: { providerID: "test", id: "model" },
    cost: { amount: 0, currency: "USD" },
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    time: { created: table.updated, updated: table.updated },
    title: table.title ?? id,
    location: { directory, workspaceID: undefined },
  } as unknown as SessionInfo
}

type Call = { readonly method: string; readonly args: readonly unknown[] }

function fakeLocal(results: Partial<Record<keyof LocalServer, unknown>> = {}) {
  const calls: Call[] = []
  const local = new Proxy({} as LocalServer, {
    get(_target, property: PropertyKey) {
      return (...args: unknown[]) => {
        calls.push({ method: String(property), args })
        const result = results[property as keyof LocalServer]
        if (typeof result === "function") return Promise.resolve((result as (...a: unknown[]) => unknown)(...args))
        if (result instanceof Error) return Promise.reject(result)
        return Promise.resolve(result)
      }
    },
  })
  return { local, calls }
}

const entry: AllowlistSession = { sessionID: "ses_1", directory: "/work", workspaceID: undefined, title: "One" }
const other: AllowlistSession = { sessionID: "ses_2", directory: "/work/two", workspaceID: undefined, title: "Two" }

async function harness(options: {
  entries?: readonly AllowlistSession[]
  results?: Partial<Record<keyof LocalServer, unknown>>
  sessions?: readonly SessionInfo[]
}) {
  const entries = options.entries ?? [entry]
  const infos = options.sessions ?? [sessionInfo("ses_1", { updated: 1 })]
  // The caller keeps the reference so a test can install a failure after setup.
  const results = options.results ?? {}
  results.getSession ??= async () => infos[0]
  const { local, calls } = fakeLocal(results)
  const registry = createSessionRegistry({
    local,
    entries,
    staleMs: 0,
  })
  await registry.refresh()
  // Registry verification is setup, not part of the operation under test.
  calls.length = 0
  const subscriptions = createSubscriptions()
  return { local, calls, registry, subscriptions }
}

function request(operation: RemoteRequest["operation"], input?: Record<string, unknown>): RemoteRequest {
  return {
    type: "request",
    id: "req_1",
    operation,
    ...(requireSession(operation) ? { sessionID: "ses_1" } : {}),
    ...(input === undefined ? {} : { input }),
  }
}

/** Read operations this suite maps; the shared contract owns the full operation list. */
const readOperations = [
  "session.get",
  "session.messages",
  "session.snapshot",
  "session.active",
  "session.log",
  "session.autonomy.get",
  "session.permission.list",
  "session.guardrail.status",
  "session.guardrail.request.list",
  "session.question.list",
  "session.fileChange.list",
] as const

function valueOf(frames: readonly { ok: boolean }[]) {
  expect(frames).toHaveLength(1)
  const frame = frames[0] as { ok: true; value: unknown }
  expect(frame.ok).toBe(true)
  return frame.value
}

function errorOf(frames: readonly { ok: boolean }[]) {
  expect(frames).toHaveLength(1)
  const frame = frames[0] as { ok: false; error: { code: string; message: string } }
  expect(frame.ok).toBe(false)
  return frame.error
}

describe("allowlist authorization", () => {
  test("refuses a session outside the advertisement without touching the local server", async () => {
    const { local, registry, subscriptions, calls } = await harness({})
    const outcome = await executeRemoteOperation({
      request: { ...request("session.messages"), sessionID: "ses_other" },
      sessions: registry,
      subscriptions,
      local,
    })
    expect(errorOf(outcome).code).toBe("session_not_allowed")
    expect(calls).toEqual([])
  })

  test("serves only advertised sessions from the local list", async () => {
    const sessions = [sessionInfo("ses_1", { updated: 2 }), sessionInfo("ses_2", { updated: 1, directory: "/work/two" })]
    const { local, registry, subscriptions } = await harness({
      entries: [entry, other],
      sessions,
      results: { getSession: async (sessionID: string) => sessions.find((session) => session.id === sessionID) },
    })
    await registry.refresh()
    const outcome = await executeRemoteOperation({ request: request("session.list"), sessions: registry, subscriptions, local })
    const value = valueOf(outcome) as { data: readonly SessionInfo[] }
    expect(value.data.map((session) => session.id)).toEqual(["ses_1", "ses_2"])
    // The relayed session keeps the contract's field shapes: Model.Ref stays an object.
    expect(value.data[0].model).toEqual({ providerID: "test", id: "model" })
  })

  test("always addresses the local server at the allowlisted Location, never a remote value", async () => {
    const { local, registry, subscriptions, calls } = await harness({
      results: { prompt: async () => ({ id: "msg_1" }) },
    })
    const rejected = await executeRemoteOperation({
      request: request("session.prompt", { text: "hi", directory: "/etc" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(errorOf(rejected).code).toBe("invalid_message")
    expect(calls).toEqual([])

    const accepted = await executeRemoteOperation({
      request: request("session.prompt", { text: "hi" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(valueOf(accepted)).toEqual({ data: { id: "msg_1" } })
    expect(calls.at(-1)).toEqual({ method: "prompt", args: ["ses_1", { directory: "/work" }, { text: "hi" }] })
  })
})

describe("operation mapping", () => {
  test("maps each mutation onto its exact Protocol call and payload", async () => {
    const { local, registry, subscriptions, calls } = await harness({
      results: {
        prompt: async () => ({ id: "msg_1" }),
        interrupt: async () => undefined,
        permissionReply: async () => undefined,
        guardrailReply: async () => undefined,
        questionReply: async () => undefined,
        autonomySet: async () => ({ mode: "yolo" }),
        guardrailRequestList: async () => [{ id: "grq_1", sessionID: "ses_1", rootSessionID: "ses_1" }],
      },
    })

    const prompt = await executeRemoteOperation({
      request: request("session.prompt", {
        id: "msg_1",
        text: "hello",
        files: [{ uri: "file:///a.ts", name: "a.ts" }],
        agents: [{ name: "build" }],
        delivery: "queue",
        resume: false,
      }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(valueOf(prompt)).toEqual({ data: { id: "msg_1" } })
    expect(calls.at(-1)).toEqual({
      method: "prompt",
      args: [
        "ses_1",
        { directory: "/work" },
        {
          id: "msg_1",
          text: "hello",
          files: [{ uri: "file:///a.ts", name: "a.ts" }],
          agents: [{ name: "build" }],
          delivery: "queue",
          resume: false,
        },
      ],
    })

    await executeRemoteOperation({ request: request("session.interrupt"), sessions: registry, subscriptions, local })
    expect(calls.at(-1)).toEqual({ method: "interrupt", args: ["ses_1", { directory: "/work" }] })

    await executeRemoteOperation({
      request: request("session.permission.reply", { requestID: "per_1", reply: "always", message: "ok" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(calls.at(-1)).toEqual({ method: "permissionReply", args: ["ses_1", { directory: "/work" }, "per_1", "always", "ok"] })

    await executeRemoteOperation({
      request: request("session.guardrail.reply", { requestID: "grq_1", reply: "once" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(calls.at(-1)).toEqual({ method: "guardrailReply", args: ["ses_1", { directory: "/work" }, "grq_1", "once"] })

    await executeRemoteOperation({
      request: request("session.question.reply", { requestID: "que_1", answers: [["yes"], []] }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(calls.at(-1)).toEqual({
      method: "questionReply",
      args: ["ses_1", { directory: "/work" }, "que_1", [["yes"], []]],
    })

    await executeRemoteOperation({
      request: request("session.autonomy.set", { yolo: 3, maxNoProgress: 2 }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(calls.at(-1)).toEqual({
      method: "autonomySet",
      args: ["ses_1", { directory: "/work" }, { yolo: 3, maxNoProgress: 2 }],
    })

    await executeRemoteOperation({
      request: request("session.goal.set", { goal: "ship it" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(calls.at(-1)).toEqual({
      method: "autonomySet",
      args: ["ses_1", { directory: "/work" }, { goal: "ship it" }],
    })

    await executeRemoteOperation({
      request: request("session.goal.stop", {}),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(calls.at(-1)).toEqual({ method: "autonomySet", args: ["ses_1", { directory: "/work" }, { goal: null }] })
  })

  test("returns each read body verbatim and never calls the local server for logical subscriptions", async () => {
    const snapshot = { sourceEpoch: "epoch_1", session: sessionInfo("ses_1", { updated: 1 }), messages: [], watermark: { seq: 4 } }
    const { local, registry, subscriptions, calls } = await harness({
      results: {
        snapshot: async () => snapshot,
        messages: async () => [{ id: "msg_1" }],
        log: async () => [{ id: "evt_1" }],
        autonomyGet: async () => ({ mode: "normal" }),
        permissionList: async () => [{ id: "per_1", sessionID: "ses_1" }],
        guardrailStatus: async () => ({ profile: "standard" }),
        guardrailRequestList: async () => [],
        questionList: async () => [],
        fileChangeList: async () => [{ path: "a.ts" }],
      },
    })

    expect(valueOf(await executeRemoteOperation({ request: request("session.snapshot"), sessions: registry, subscriptions, local }))).toEqual(snapshot)
    expect(valueOf(await executeRemoteOperation({ request: request("session.messages"), sessions: registry, subscriptions, local }))).toEqual({ data: [{ id: "msg_1" }] })
    expect(valueOf(await executeRemoteOperation({ request: request("session.log", { after: 4 }), sessions: registry, subscriptions, local }))).toEqual({ data: [{ id: "evt_1" }] })
    expect(valueOf(await executeRemoteOperation({ request: request("session.autonomy.get"), sessions: registry, subscriptions, local }))).toEqual({ data: { mode: "normal" } })
    expect(valueOf(await executeRemoteOperation({ request: request("session.permission.list"), sessions: registry, subscriptions, local }))).toEqual({ data: [{ id: "per_1", sessionID: "ses_1" }] })
    expect(valueOf(await executeRemoteOperation({ request: request("session.guardrail.status"), sessions: registry, subscriptions, local }))).toEqual({ data: { profile: "standard" } })
    expect(valueOf(await executeRemoteOperation({ request: request("session.question.list"), sessions: registry, subscriptions, local }))).toEqual({ data: [] })
    expect(valueOf(await executeRemoteOperation({ request: request("session.fileChange.list"), sessions: registry, subscriptions, local }))).toEqual({ data: [{ path: "a.ts" }] })
    expect(calls.filter((call) => call.method === "log").at(-1)).toEqual({ method: "log", args: ["ses_1", { directory: "/work" }, 4] })

    const before = calls.filter((call) => call.method !== "getSession").length
    expect(valueOf(await executeRemoteOperation({ request: request("session.subscribe"), sessions: registry, subscriptions, local }))).toBeNull()
    expect(valueOf(await executeRemoteOperation({ request: request("session.subscribe"), sessions: registry, subscriptions, local }))).toBeNull()
    expect(valueOf(await executeRemoteOperation({ request: request("session.unsubscribe"), sessions: registry, subscriptions, local }))).toBeNull()
    expect(calls.filter((call) => call.method !== "getSession").length).toBe(before)
    expect(subscriptions.count("ses_1")).toBe(1)
    expect(subscriptions.has("ses_1")).toBe(true)
    expect(valueOf(await executeRemoteOperation({ request: request("session.unsubscribe"), sessions: registry, subscriptions, local }))).toBeNull()
    expect(subscriptions.has("ses_1")).toBe(false)
  })

  test("maps every shared read operation the relay advertises", async () => {
    const { local, registry, subscriptions, calls } = await harness({
      // `session.get` is served by the verification read itself, so the default
      // session info stands in for it.
      results: Object.fromEntries(
        readOperations
          .filter((operation) => operation !== "session.get")
          .map((operation) => [readMethod(operation), async () => []]),
      ),
    })
    for (const operation of readOperations) {
      const outcome = await executeRemoteOperation({
        request: operation === "session.log" ? request(operation, { after: 0 }) : request(operation),
        sessions: registry,
        subscriptions,
        local,
      })
      expect({ operation, frame: outcome[0] }).toMatchObject({ operation, frame: { ok: true } })
    }
    // `session.get` itself is the verification read, so it is counted below.
    expect(calls.filter((call) => call.method !== "getSession").map((call) => call.method)).toEqual(
      readOperations.map(readMethod).filter((method) => method !== "getSession"),
    )
    // One verification per session-scoped read, plus one allowlist refresh for the
    // process-wide running-status read.
    const scoped = readOperations.filter(requireSession)
    expect(calls.filter((call) => call.method === "getSession")).toHaveLength(scoped.length + 1)
  })

  test("reports running status for shared sessions only", async () => {
    const { local, registry, subscriptions, calls } = await harness({
      sessions: [sessionInfo("ses_1", { updated: 1 })],
      results: {
        activeSessions: async () => ({ ses_1: { type: "running" }, ses_hidden: { type: "running" } }),
      },
    })
    const outcome = await executeRemoteOperation({
      request: request("session.active"),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(valueOf(outcome)).toEqual({ data: { ses_1: { type: "running" } } })
    expect(calls.filter((call) => call.method === "activeSessions")).toHaveLength(1)

    const rejected = await executeRemoteOperation({
      request: request("session.active", { sessionID: "ses_1" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(errorOf(rejected).code).toBe("invalid_message")
  })

  test("fails closed when an advertised Session moved and reports the new location instead of following it", async () => {
    const infos = [sessionInfo("ses_1", { updated: 1 })]
    let moved = false
    const results: Partial<Record<keyof LocalServer, unknown>> = {
      getSession: async () => {
        if (moved) throw new LocalFailureClass("not_found", "gone")
        return infos[0]
      },
      listPage: async () => ({ data: [sessionInfo("ses_1", { updated: 1, directory: "/work/moved" })] }),
      messages: async () => [{ id: "msg_1" }],
    }
    const { local, calls } = fakeLocal(results)
    const reported: Array<{ sessionID: string; location: LocalLocation }> = []
    const registry = createSessionRegistry({
      local,
      entries: [entry],
      staleMs: 0,
      onMoved: (sessionID, location) => reported.push({ sessionID, location }),
    })
    await registry.refresh()
    calls.length = 0
    expect(registry.advertised("ses_1")).toBe(true)

    moved = true
    const outcome = await executeRemoteOperation({
      request: request("session.messages"),
      sessions: registry,
      subscriptions: createSubscriptions(),
      local,
    })
    expect(errorOf(outcome).code).toBe("session_not_allowed")
    expect(calls.some((call) => call.method === "messages")).toBe(false)
    expect(reported).toEqual([{ sessionID: "ses_1", location: { directory: "/work/moved" } }])
    expect(registry.advertised("ses_1")).toBe(false)
  })
})

function readMethod(operation: (typeof readOperations)[number]) {
  const method: Record<(typeof readOperations)[number], keyof LocalServer> = {
    "session.get": "getSession",
    "session.messages": "messages",
    "session.snapshot": "snapshot",
    "session.active": "activeSessions",
    "session.log": "log",
    "session.autonomy.get": "autonomyGet",
    "session.permission.list": "permissionList",
    "session.guardrail.status": "guardrailStatus",
    "session.guardrail.request.list": "guardrailRequestList",
    "session.question.list": "questionList",
    "session.fileChange.list": "fileChangeList",
  }
  return method[operation]
}

describe("family-wide guardrail reviews", () => {
  test("filters reviews owned by sessions outside the advertisement and refuses their replies", async () => {
    const { local, registry, subscriptions, calls } = await harness({
      results: {
        guardrailRequestList: async () => ({
          data: [
            { id: "grq_mine", sessionID: "ses_1", rootSessionID: "ses_1" },
            { id: "grq_sibling", sessionID: "ses_child", rootSessionID: "ses_1" },
          ],
        }),
        guardrailReply: async () => undefined,
      },
    })
    const listed = await executeRemoteOperation({
      request: request("session.guardrail.request.list"),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(valueOf(listed)).toEqual({ data: [{ id: "grq_mine", sessionID: "ses_1", rootSessionID: "ses_1" }] })

    const refused = await executeRemoteOperation({
      request: request("session.guardrail.reply", { requestID: "grq_sibling", reply: "once" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(errorOf(refused).code).toBe("session_not_allowed")
    expect(calls.some((call) => call.method === "guardrailReply")).toBe(false)

    const allowed = await executeRemoteOperation({
      request: request("session.guardrail.reply", { requestID: "grq_mine", reply: "once" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(valueOf(allowed)).toBeNull()
    expect(calls.at(-1)).toEqual({ method: "guardrailReply", args: ["ses_1", { directory: "/work" }, "grq_mine", "once"] })
  })

  test("refuses an unknown review and allows a granted child addressed through the root", async () => {
    const child: AllowlistSession = { sessionID: "ses_child", directory: "/work", workspaceID: undefined, title: "Child" }
    const infos = [sessionInfo("ses_1", { updated: 1 }), sessionInfo("ses_child", { updated: 1, parentID: "ses_1" })]
    const { local, registry, subscriptions, calls } = await harness({
      entries: [entry, child],
      results: {
        getSession: async (sessionID: string) => infos.find((info) => info.id === sessionID),
        guardrailRequestList: async () => [{ id: "grq_child", sessionID: "ses_child", rootSessionID: "ses_1" }],
        guardrailReply: async () => undefined,
      },
    })
    await registry.refresh()

    const unknown = await executeRemoteOperation({
      request: request("session.guardrail.reply", { requestID: "grq_missing", reply: "reject" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(errorOf(unknown).code).toBe("invalid_message")

    const throughRoot = await executeRemoteOperation({
      request: request("session.guardrail.reply", { requestID: "grq_child", reply: "reject" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(valueOf(throughRoot)).toBeNull()
    expect(calls.at(-1)).toEqual({
      method: "guardrailReply",
      args: ["ses_1", { directory: "/work" }, "grq_child", "reject"],
    })
  })
})

describe("session shell output read", () => {
  const ownedShell = { id: "sh_1", status: "exited", metadata: { sessionID: "ses_1" } }

  async function shellHarness(results: Partial<Record<keyof LocalServer, unknown>> = {}) {
    return harness({
      results: {
        shellGet: async () => ownedShell,
        shellOutput: async () => ({ output: "page", cursor: 4, size: 4, truncated: false }),
        ...results,
      },
    })
  }

  test("refuses a shell owned by another Session before reading any output", async () => {
    const { local, registry, subscriptions, calls } = await shellHarness({
      shellGet: async () => ({ id: "sh_1", metadata: { sessionID: "ses_2" } }),
    })
    const outcome = await executeRemoteOperation({
      request: request("session.shell.output", { shellID: "sh_1" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(errorOf(outcome).code).toBe("forbidden")
    // The refused read never reaches the local output route, so no bytes are copied.
    expect(calls.some((call) => call.method === "shellOutput")).toBe(false)
    expect(JSON.stringify(outcome)).not.toContain("page")
  })

  test("refuses a shell whose owning Session is not recorded", async () => {
    const { local, registry, subscriptions, calls } = await shellHarness({
      shellGet: async () => ({ id: "sh_1", metadata: {} }),
    })
    const outcome = await executeRemoteOperation({
      request: request("session.shell.output", { shellID: "sh_1" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(errorOf(outcome).code).toBe("forbidden")
    expect(calls.some((call) => call.method === "shellOutput")).toBe(false)
  })

  test("returns the stored page verbatim after verifying ownership at the session location", async () => {
    const { local, registry, subscriptions, calls } = await shellHarness()
    const outcome = await executeRemoteOperation({
      request: request("session.shell.output", { shellID: "sh_1", cursor: 0, limit: 2_048 }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(valueOf(outcome)).toEqual({ data: { output: "page", cursor: 4, size: 4, truncated: false } })
    expect(calls.filter((call) => call.method === "shellGet")).toEqual([
      { method: "shellGet", args: ["sh_1", { directory: "/work" }] },
    ])
    expect(calls.at(-1)).toEqual({
      method: "shellOutput",
      args: ["sh_1", { directory: "/work" }, { cursor: 0, limit: 2_048 }],
    })
  })

  test("defaults to one bounded local page when the page size is omitted", async () => {
    const { local, registry, subscriptions, calls } = await shellHarness()
    await executeRemoteOperation({
      request: request("session.shell.output", { shellID: "sh_1" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(calls.at(-1)).toEqual({ method: "shellOutput", args: ["sh_1", { directory: "/work" }, { limit: 65_536 }] })
  })

  test("rejects page inputs and unknown fields before any local call", async () => {
    const { local, registry, subscriptions, calls } = await shellHarness()
    const cases = [
      {},
      { shellID: "sh" },
      { shellID: "../etc/passwd" },
      { shellID: "sh_1/../../etc/passwd" },
      { shellID: 4 },
      { shellID: "sh_1", cursor: -1 },
      { shellID: "sh_1", cursor: 1.5 },
      { shellID: "sh_1", limit: 0 },
      { shellID: "sh_1", limit: 1.5 },
      { shellID: "sh_1", limit: 65_537 },
      { shellID: "sh_1", path: "/tmp/shell.out" },
      { shellID: "sh_1", file: "/tmp/shell.out" },
    ]
    for (const input of cases) {
      calls.length = 0
      const outcome = await executeRemoteOperation({
        request: request("session.shell.output", input),
        sessions: registry,
        subscriptions,
        local,
      })
      expect({ input, code: errorOf(outcome).code }).toMatchObject({ input, code: "invalid_message" })
      expect(calls).toEqual([])
    }
  })

  test("maps a shell that is gone to a closed error without reading output", async () => {
    const { local, registry, subscriptions, calls } = await shellHarness({
      shellGet: () => Promise.reject(new LocalFailureClass("not_found", "gone")),
    })
    const outcome = await executeRemoteOperation({
      request: request("session.shell.output", { shellID: "sh_missing" }),
      sessions: registry,
      subscriptions,
      local,
    })
    expect(errorOf(outcome).code).toBe("invalid_message")
    expect(calls.some((call) => call.method === "shellOutput")).toBe(false)
  })

  test("refuses an unadvertised Session before any local call", async () => {
    const { local, registry, subscriptions, calls } = await shellHarness()
    const outcome = await executeRemoteOperation({
      request: { ...request("session.shell.output", { shellID: "sh_1" }), sessionID: "ses_other" },
      sessions: registry,
      subscriptions,
      local,
    })
    expect(errorOf(outcome).code).toBe("session_not_allowed")
    expect(calls).toEqual([])
  })
})

describe("strict validation and error mapping", () => {
  test("rejects unknown fields, malformed values, and unknown operations before any local call", async () => {
    const { local, registry, subscriptions, calls } = await harness({})
    const cases: Array<[RemoteRequest, string]> = [
      [request("session.prompt", { text: "hi", metadata: {} }), "invalid_message"],
      [request("session.prompt", {}), "invalid_message"],
      [request("session.prompt", { text: "hi", id: "per_1" }), "invalid_message"],
      [request("session.prompt", { text: "hi", delivery: "now" }), "invalid_message"],
      [request("session.prompt", { text: "hi", files: [{ uri: 4 }] }), "invalid_message"],
      [request("session.log", { after: -1 }), "invalid_message"],
      [request("session.permission.reply", { requestID: "grq_1", reply: "once" }), "invalid_message"],
      [request("session.permission.reply", { requestID: "per_1", reply: "maybe" }), "invalid_message"],
      [request("session.question.reply", { requestID: "que_1", answers: "yes" }), "invalid_message"],
      [request("session.autonomy.set", { yolo: 9 }), "invalid_message"],
      [request("session.autonomy.set", {}), "invalid_message"],
      [request("session.goal.set", { goal: "" }), "invalid_message"],
      [request("session.goal.stop", { goal: "stop" }), "invalid_message"],
      [request("session.list", { limit: 0 }), "invalid_message"],
      [request("session.list", { order: "sideways" }), "invalid_message"],
      [request("session.get", { directory: "/etc" }), "invalid_message"],
      [request("session.active", { limit: 1 }), "invalid_message"],
      // A frame outside the shared contract; the relay parser rejects it before this layer.
      [{ ...request("session.get"), operation: "session.unknown" as RemoteRequest["operation"] }, "unknown_operation"],
    ]
    for (const [frame, code] of cases) {
      calls.length = 0
      const outcome = await executeRemoteOperation({ request: frame, sessions: registry, subscriptions, local })
      expect(errorOf(outcome).code).toBe(code)
      expect(calls).toEqual([])
    }
  })

  test("maps local failures onto the relay error vocabulary without replaying mutations", async () => {
    const cases: Array<[keyof LocalServer, unknown, string, readonly string[]]> = [
      ["messages", new LocalFailureClass("not_found", "gone"), "session_not_allowed", ["session.messages"]],
      ["permissionReply", new LocalFailureClass("not_found", "gone"), "invalid_message", ["session.permission.reply"]],
      ["prompt", new LocalFailureClass("transport", "no answer"), "outcome_unknown", ["session.prompt"]],
      ["messages", new LocalFailureClass("transport", "no answer"), "internal_error", ["session.messages"]],
      ["prompt", new LocalFailureClass("conflict", "conflict"), "invalid_message", ["session.prompt"]],
      ["messages", new LocalFailureClass("too_large", "big"), "message_too_large", ["session.messages"]],
      ["getSession", new LocalFailureClass("server", "boom"), "internal_error", ["session.get"]],
    ]
    for (const [method, failure, code, operations] of cases) {
      const results: Partial<Record<keyof LocalServer, unknown>> = {}
      const { local, registry, subscriptions, calls } = await harness({ results })
      results[method] = () => Promise.reject(failure)
      for (const operation of operations) {
        const input =
          operation === "session.prompt"
            ? { text: "hi" }
            : operation === "session.permission.reply"
              ? { requestID: "per_1", reply: "once" }
              : undefined
        const outcome = await executeRemoteOperation({
          request: request(operation as never, input),
          sessions: registry,
          subscriptions,
          local,
        })
        expect(errorOf(outcome).code).toBe(code)
        // One attempt per request: an indeterminate mutation is never replayed.
        expect(calls.filter((call) => call.method === method)).toHaveLength(1)
      }
    }
  })
})

describe("bounded response chunking", () => {
  test("keeps a small response in one frame and reassembles a large one in order", () => {
    const small = successFrames("req_1", { data: [1, 2, 3] })
    expect(small).toHaveLength(1)

    const large = { data: Array.from({ length: 20_000 }, (_, index) => ({ index, text: `line ${index} "quoted"` })) }
    const text = JSON.stringify(large)
    expect(text.length).toBeGreaterThan(RemoteLimits.maxAgentMessageChars)
    const frames = successFrames("req_1", large)
    expect(frames.length).toBeGreaterThan(1)
    expect(frames.length).toBeLessThanOrEqual(RemoteLimits.maxChunksPerResponse)
    const parts: string[] = []
    frames.forEach((frame, index) => {
      expect(JSON.stringify(frame).length).toBeLessThanOrEqual(RemoteLimits.maxAgentMessageChars)
      const chunked = frame as { ok: true; value: string; chunk: { index: number; last: boolean } }
      expect(chunked.chunk.index).toBe(index)
      expect(chunked.chunk.last).toBe(index === frames.length - 1)
      parts.push(chunked.value)
    })
    const reassembled = parseChunkedValue(parts)
    expect(reassembled.ok).toBe(true)
    if (reassembled.ok) expect(reassembled.value).toEqual(large)
  })

  test("fails explicitly instead of truncating a value beyond the chunk bound", () => {
    const huge = { data: "x".repeat(RemoteLimits.maxAgentMessageChars * RemoteLimits.maxChunksPerResponse + 1) }
    const frames = successFrames("req_1", huge)
    expect(frames).toHaveLength(1)
    expect(frames[0].ok).toBe(false)
    if (!frames[0].ok) expect(frames[0].error.code).toBe("message_too_large")
  })
})

describe("local endpoint scope", () => {
  test("accepts loopback only and refuses LAN or public endpoints", () => {
    for (const url of ["http://127.0.0.1:4096", "http://localhost:4096", "http://[::1]:4096", "http://0.0.0.0:4096"]) {
      expect(() => assertPrivateEndpoint({ url })).not.toThrow()
    }
    for (const url of [
      "http://192.168.1.20:4096",
      "http://10.0.0.5:4096",
      "http://172.16.4.4:4096",
      "http://workstation.local:4096",
      "https://ycoding.example:4096",
    ]) {
      expect(() => assertPrivateEndpoint({ url })).toThrow(/loopback/)
    }
  })
})

describe("session list paging", () => {
  test("orders, searches, limits, and pages the advertised set without leaking unlisted sessions", () => {
    const sessions = [
      sessionInfo("ses_a", { updated: 1, title: "Alpha" }),
      sessionInfo("ses_b", { updated: 2, title: "Beta" }),
      sessionInfo("ses_c", { updated: 3, title: "Gamma" }),
    ]
    const first = listPage(sessions, parseListQuery({ limit: 2 })) as { data: SessionInfo[]; cursor: { next?: string } }
    expect(first.data.map((session) => session.id)).toEqual(["ses_c", "ses_b"])
    expect(first.cursor.next).toBeDefined()

    const second = listPage(sessions, parseListQuery({ limit: 2, cursor: first.cursor.next })) as {
      data: SessionInfo[]
      cursor: { next?: string }
    }
    expect(second.data.map((session) => session.id)).toEqual(["ses_a"])
    expect(second.cursor.next).toBeUndefined()

    const ascending = listPage(sessions, parseListQuery({ order: "asc", limit: 10 })) as { data: SessionInfo[] }
    expect(ascending.data.map((session) => session.id)).toEqual(["ses_a", "ses_b", "ses_c"])

    const searched = listPage(sessions, parseListQuery({ search: "amm", limit: 10 })) as { data: SessionInfo[] }
    expect(searched.data.map((session) => session.id)).toEqual(["ses_c"])

    const roots = listPage(
      [...sessions, sessionInfo("ses_child", { updated: 4, parentID: "ses_a" })],
      parseListQuery({ parentID: null, limit: 10 }),
    ) as { data: SessionInfo[] }
    expect(roots.data.map((session) => session.id)).toEqual(["ses_c", "ses_b", "ses_a"])
  })
})
