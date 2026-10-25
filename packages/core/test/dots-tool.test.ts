import { describe, expect, test } from "bun:test"
import { pathToFileURL } from "node:url"
import { Agent } from "@ycoding-ai/core/agent"
import { DotsRuntime } from "@ycoding-ai/core/dots"
import { DotsHttp } from "@ycoding-ai/core/dots/http"
import { DotsTool } from "@ycoding-ai/core/dots/tool"
import { DotsTransport } from "@ycoding-ai/core/dots/transport"
import { Permission } from "@ycoding-ai/core/permission"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { Tool } from "@ycoding-ai/core/tool/tool"
import type { Dots } from "@ycoding-ai/schema/dots"
import { DotsPubSub } from "@ycoding-ai/core/dots/pubsub"
import { OpenAICodex } from "@ycoding-ai/core/plugin/provider/openai-codex"
import { Cause, Effect, Exit, Fiber, Scope, Stream } from "effect"

const target: Dots.Target = {
  profile: "fixture-a",
  dotID: "dot_a",
  threadID: "thread_a1",
  generation: "1",
  label: "Dot A",
}
const context = {
  sessionID: SessionSchema.ID.make("ses_dots_tool"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_assistant"),
  callID: "call_dots",
  progress: () => Effect.void,
}

function harness(options: { status?: Dots.Status; capture?: boolean; deny?: boolean; denyRead?: boolean; onPermission?: (action: string) => void; onGuardrail?: () => void } = {}) {
  const order: string[] = []
  const sends: Array<{ sessionID: string } & Dots.Send> = []
  const controls: Array<{ sessionID: string; expectedTarget: Dots.Target; action: string }> = []
  const permissions: Permission.AssertInput[] = []
  const guardrails: Array<{ action: string; resources: ReadonlyArray<string> }> = []
  const dots: DotsRuntime.Interface = {
    attachment: () => Effect.die("Unexpected exchange attachment lookup"),
    targets: () => Effect.succeed([]),
    bind: () => Effect.die("agents never bind"),
    status: () => Effect.succeed(options.status ?? { enabled: true, target, state: "connected" }),
    send: (input) =>
      Effect.sync(() => {
        order.push("send")
        sends.push(input)
        return { messageID: input.id, status: "accepted" as const, turnID: "turn_1" }
      }),
    pause: (input) => Effect.sync(() => { controls.push({ ...input, action: "pause" }); return { enabled: true, target, state: "connected" as const, runtimeState: "paused" as const } }),
    resume: (input) => Effect.sync(() => { controls.push({ ...input, action: "resume" }); return { enabled: true, target, state: "connected" as const, runtimeState: "unpaused" as const } }),
  }
  const tools = DotsTool.make({
    dots,
    state: options.status?.state,
    runtimeState: options.status?.runtimeState,
    target: options.capture === false ? undefined : options.status ? options.status.target : target,
    directory: "/synthetic/project",
    permission: {
      assert: (input) =>
        Effect.suspend(() => {
          order.push("permission")
          permissions.push(input)
          options.onPermission?.(input.action)
          return options.deny || (options.denyRead && input.action === "read")
            ? Effect.fail(
                new Permission.BlockedError({ rules: [], permission: "dots_send", resources: input.resources }),
              )
            : Effect.void
        }),
    },
    guardrail: {
      assert: (input) =>
        Effect.suspend(() => {
          order.push("guardrail")
          guardrails.push({ action: input.action, resources: input.resources })
          options.onGuardrail?.()
          return Effect.succeed({ release: Effect.sync(() => order.push("release")) })
        }),
    },
  })
  return { tools, order, sends, controls, permissions, guardrails, setStatus: (status: Dots.Status) => { options.status = status } }
}

const run = (tool: Tool.AnyTool, input: unknown) =>
  Tool.settle(tool, { id: context.callID, name: "dots", input }, context).pipe(Effect.exit, Effect.runPromise)

describe("Dots agent tools", () => {
  test("rejects a captured control after same-ID profile or generation rebinding before permission", async () => {
    for (const changed of [{ profile: "other-profile" }, { generation: "2" }, { dotID: "other-dot" }]) {
      const value = harness({ status: { enabled: true, target, state: "connected", runtimeState: "unpaused" } })
      value.setStatus({ enabled: true, target: { ...target, ...changed }, state: "connected", runtimeState: "unpaused" })
      const exit = await run(value.tools.dots_pause!, {})
      expect(Exit.isFailure(exit)).toBe(true)
      expect(value.permissions).toEqual([])
      expect(value.controls).toEqual([])
    }
  })

  test("rechecks the captured target after approval and releases its guardrail reservation", async () => {
    for (const gate of ["onPermission", "onGuardrail"] as const) {
      const value = harness({ status: { enabled: true, target, state: "connected", runtimeState: "unpaused" },
        [gate]: () => value.setStatus({ enabled: true, target: { ...target, profile: "other-profile" }, state: "connected", runtimeState: "unpaused" }),
      })
      const exit = await run(value.tools.dots_pause!, {})
      expect(Exit.isFailure(exit)).toBe(true)
      expect(value.controls).toEqual([])
      expect(value.order.at(-1)).toBe("release")
    }
  })

  test("rejects a captured send after same-ID profile, Dot, thread or generation rebinding before permission", async () => {
    for (const changed of [{ profile: "other-profile" }, { dotID: "other-dot" }, { threadID: "other-thread" }, { generation: "2" }]) {
      const value = harness()
      value.setStatus({ enabled: true, target: { ...target, ...changed }, state: "connected" })
      const exit = await run(value.tools.dots_send!, { text: "Intended for the first Dot" })
      expect(Exit.isFailure(exit)).toBe(true)
      expect(value.permissions).toEqual([])
      expect(value.guardrails).toEqual([])
      expect(value.sends).toEqual([])
    }
  })

  test("never falls back to the fresh target when no destination was captured", async () => {
    const value = harness({ capture: false })
    const exit = await run(value.tools.dots_send!, { text: "No captured destination" })
    expect(Exit.isFailure(exit)).toBe(true)
    expect(value.permissions).toEqual([])
    expect(value.sends).toEqual([])
  })

  test("rechecks the captured send target after each settlement and releases an acquired reservation once", async () => {
    for (const gate of ["permission", "read", "guardrail"] as const) {
      const rebind = () => value.setStatus({ enabled: true, target: { ...target, generation: "2" }, state: "connected" })
      const value = harness({
        onPermission: (action) => { if (action === (gate === "permission" ? "dots_send" : "read") && gate !== "guardrail") rebind() },
        onGuardrail: () => { if (gate === "guardrail") rebind() },
      })
      const exit = await run(value.tools.dots_send!, { text: "Hold", files: ["notes/report.md"] })
      expect(Exit.isFailure(exit)).toBe(true)
      expect(value.sends).toEqual([])
      expect(value.order.filter((step) => step === "release")).toHaveLength(gate === "guardrail" ? 1 : 0)
      expect(value.guardrails).toHaveLength(gate === "guardrail" ? 1 : 0)
    }
  })

  test("a label-only update keeps the captured destination and the message identity", async () => {
    const value = harness()
    value.setStatus({ enabled: true, target: { ...target, label: "Renamed Dot" }, state: "connected" })
    const exit = await run(value.tools.dots_send!, { text: "Still the same Dot" })
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(value.sends).toHaveLength(1)
    expect(value.sends[0]).toMatchObject({ expectedTarget: target, causalMessageID: context.messageID })
    expect(value.sends[0]?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(value.order.filter((step) => step === "release")).toHaveLength(1)
  })

  test("a read denial cannot be bypassed by attaching a file to a Dots message", async () => {
    const value = harness({ denyRead: true })
    const exit = await run(value.tools.dots_send!, { text: "selected file", files: ["private.txt"] })
    expect(Exit.isFailure(exit)).toBe(true)
    expect(value.sends).toEqual([])
    expect(
      value.permissions.some(
        (request) => request.action === "read" && request.resources.includes("/synthetic/project/private.txt"),
      ),
    ).toBe(true)
  })
  test("a denied control executes no external mutation", async () => {
    const value = harness({ deny: true, status: { enabled: true, target, state: "connected", runtimeState: "unpaused" } })
    const exit = await run(value.tools.dots_pause!, {})
    expect(Exit.isFailure(exit)).toBe(true)
    expect(value.controls).toEqual([])
    expect(value.permissions[0]?.action).toBe("dots_pause")
  })
  test("asks permission for the bound destination, reviews files, and sends with the caller's causal message", async () => {
    const value = harness()
    const exit = await run(value.tools.dots_send!, { text: "Status update", files: ["notes/report.md"] })
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(value.order).toEqual(["permission", "permission", "guardrail", "send", "release"])
    expect(value.permissions[1]).toMatchObject({ action: "read", resources: ["/synthetic/project/notes/report.md"] })
    expect(value.permissions[0]).toMatchObject({
      action: "dots_send",
      resources: ["dot_a/thread_a1"],
      sessionID: context.sessionID,
      source: { type: "tool", messageID: context.messageID, callID: context.callID },
    })
    expect(value.guardrails).toEqual([{ action: "dots_send", resources: ["/synthetic/project/notes/report.md"] }])
    expect(value.sends).toHaveLength(1)
    expect(value.sends[0]).toMatchObject({
      sessionID: context.sessionID,
      text: "Status update",
      files: [{ uri: pathToFileURL("/synthetic/project/notes/report.md").href, name: "report.md" }],
      causalMessageID: context.messageID,
      expectedTarget: target,
    })
  })

  test("derives one message identity per tool call", async () => {
    const first = harness()
    const second = harness()
    await run(first.tools.dots_send!, { text: "Hello" })
    await run(second.tools.dots_send!, { text: "Hello" })
    expect(first.sends[0]?.id).toBe(second.sends[0]?.id)
    expect(first.sends[0]?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  test("never sends after a permission denial", async () => {
    const value = harness({ deny: true })
    const exit = await run(value.tools.dots_send!, { text: "Hello" })
    expect(Exit.isFailure(exit)).toBe(true)
    expect(value.sends).toEqual([])
    expect(value.guardrails).toEqual([])
  })

  test("refuses to send without a confirmed destination", async () => {
    const value = harness({ status: { enabled: true, state: "disconnected" } })
    const exit = await run(value.tools.dots_send!, { text: "Hello" })
    expect(Exit.isFailure(exit)).toBe(true)
    expect(value.permissions).toEqual([])
    expect(value.sends).toEqual([])
  })

  test("exposes only the matching empty-input control and preserves its permission and guardrail gates", async () => {
    for (const action of ["pause", "resume"] as const) {
      const value = harness({ status: { enabled: true, target, state: "connected", runtimeState: action === "pause" ? "unpaused" : "paused" } })
      expect(value.tools[action === "pause" ? "dots_resume" : "dots_pause"]).toBeUndefined()
      const exit = await run(value.tools[action === "pause" ? "dots_pause" : "dots_resume"]!, {})
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(value.controls).toEqual([{ sessionID: context.sessionID, expectedTarget: target, action }])
      expect(value.permissions[0]).toMatchObject({ action: `dots_${action}`, resources: ["dot_a/thread_a1"] })
      expect(value.guardrails).toEqual([{ action: `dots_${action}`, resources: [] }])
      expect(value.order.at(-1)).toBe("release")
    }
    for (const runtimeState of ["unknown", undefined] as const) {
      const value = harness({ status: { enabled: true, target, state: "connected", runtimeState } })
      expect(value.tools.dots_pause).toBeUndefined()
      expect(value.tools.dots_resume).toBeUndefined()
    }
    for (const state of ["disconnected", "connecting", "failed"] as const) {
      const value = harness({ status: { enabled: true, target, state, runtimeState: "unpaused" } })
      expect(value.tools.dots_pause).toBeUndefined()
      expect(value.tools.dots_resume).toBeUndefined()
    }
  })

  test("rejects a changed runtime state after approval without a control call", async () => {
    const value = harness({ status: { enabled: true, target, state: "connected", runtimeState: "unpaused" },
      onGuardrail: () => value.setStatus({ enabled: true, target, state: "connected", runtimeState: "paused" }),
    })
    expect(Exit.isFailure(await run(value.tools.dots_pause!, {}))).toBe(true)
    expect(value.controls).toEqual([])
    expect(value.order.at(-1)).toBe("release")
    const disconnected = harness({ status: { enabled: true, target, state: "connected", runtimeState: "unpaused" },
      onPermission: () => disconnected.setStatus({ enabled: true, target, state: "connecting", runtimeState: "unpaused" }),
    })
    expect(Exit.isFailure(await run(disconnected.tools.dots_pause!, {}))).toBe(true)
    expect(disconnected.controls).toEqual([])
  })
})

describe("Dots HTTP", () => {
  const credentials: DotsTransport.Credentials = { access: "synthetic-access-token", accountID: "synthetic-account-id" }
  const origin = "https://chatgpt.com/backend-api"

  const harness = (respond: (call: number, init: RequestInit) => Response | Promise<Response>) => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetch: DotsHttp.Fetch = async (url, init) => {
      calls.push({ url, init })
      return respond(calls.length, init)
    }
    return { calls, http: DotsHttp.make({ fetch }) }
  }
  const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 })
  const fail = async (effect: Effect.Effect<unknown, DotsTransport.Error>) => {
    const exit = await Effect.runPromiseExit(effect)
    if (Exit.isSuccess(exit)) throw new Error("expected failure")
    const error = Cause.squash(exit.cause)
    if (!(error instanceof DotsTransport.Error)) throw error
    return error
  }

  test("calls the fixed origin with its own identity and auth headers", async () => {
    const { calls, http } = harness(ok)
    const result = await Effect.runPromise(
      http.json(credentials, { method: "GET", path: "/tbo/by-thread/thread%2Fa?limit=5" }),
    )
    expect(result).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    const [request] = calls
    if (!request) throw new Error("The HTTP request was not captured")
    expect(request.url).toBe(`${origin}/tbo/by-thread/thread%2Fa?limit=5`)
    expect(request.init.method).toBe("GET")
    expect(request.init.redirect).toBe("error")
    const headers = new Headers(request.init.headers)
    expect(headers.get("authorization")).toBe("Bearer synthetic-access-token")
    expect(headers.get("chatgpt-account-id")).toBe("synthetic-account-id")
    expect(headers.get("x-openai-expected-account-id")).toBe("synthetic-account-id")
    expect(headers.get("originator")).toBe(OpenAICodex.headers().originator)
    expect(headers.get("user-agent")).toBe(OpenAICodex.headers()["User-Agent"])
    expect(headers.get("accept")).toBe("application/json")
    expect(headers.get("content-type")).toBeNull()
  })

  test("allows only the documented routes and never fetches an invalid path", async () => {
    const { calls, http } = harness(ok)
    for (const path of ["/tbo/primary", "/messaging/rooms/room_1/messages", "/celsius/ws/user"]) {
      await Effect.runPromise(http.json(credentials, { method: "GET", path }))
    }
    expect(calls.map((call) => call.url)).toEqual([
      `${origin}/tbo/primary`,
      `${origin}/messaging/rooms/room_1/messages`,
      `${origin}/celsius/ws/user`,
    ])
    const before = calls.length
    for (const path of [
      "https://evil.example/tbo/primary",
      "//evil.example/tbo/primary",
      "/tbo/primary\\x",
      "/tbo/primary#frag",
      "/tbo/../account/settings",
      "/tbo/%2e%2e/account",
      "/messaging/rooms/../../x",
      "/account/settings",
      "tbo/primary",
      "",
    ]) {
      const error = await fail(http.json(credentials, { method: "GET", path }))
      expect(error.reason).toBe("rejected")
    }
    expect(calls).toHaveLength(before)
  })

  test("serializes JSON bodies and leaves multipart framing to fetch", async () => {
    const { calls, http } = harness(ok)
    await Effect.runPromise(
      http.json(credentials, { method: "POST", path: "/messaging/rooms/r1/messages", body: { text: "hi" } }),
    )
    const form = new FormData()
    form.set("file", new Blob(["x"]), "a.txt")
    await Effect.runPromise(http.json(credentials, { method: "POST", path: "/messaging/rooms/r1/files", body: form }))
    await Effect.runPromise(http.json(credentials, { method: "POST", path: "/messaging/rooms/r1/read" }))
    const [json, multipart, bodyless] = calls
    if (!json || !multipart || !bodyless) throw new Error("The body encoding requests were not captured")
    expect(new Headers(json.init.headers).get("content-type")).toBe("application/json")
    expect(json.init.body).toBe(JSON.stringify({ text: "hi" }))
    expect(new Headers(multipart.init.headers).get("content-type")).toBeNull()
    expect(multipart.init.body).toBe(form)
    expect(new Headers(bodyless.init.headers).get("content-type")).toBeNull()
    expect(bodyless.init.body).toBeUndefined()
  })

  test("classifies HTTP statuses without retrying", async () => {
    const cases: Array<[number, "GET" | "POST", DotsTransport.Error["reason"]]> = [
      [401, "GET", "unauthorized"],
      [401, "POST", "unauthorized"],
      [403, "GET", "rejected"],
      [403, "POST", "rejected"],
      [404, "POST", "rejected"],
      [408, "GET", "unavailable"],
      [408, "POST", "disconnected"],
      [500, "GET", "unavailable"],
      [503, "POST", "disconnected"],
    ]
    for (const [status, method, reason] of cases) {
      const { calls, http } = harness(() => new Response("upstream secret body", { status }))
      const error = await fail(http.json(credentials, { method, path: "/tbo/primary" }))
      expect(error.reason).toBe(reason)
      expect(calls).toHaveLength(1)
    }
  })

  test("distinguishes ambiguous network and malformed-body failures by method", async () => {
    const network = harness(() => Promise.reject(new TypeError("connect ECONNRESET synthetic-access-token")))
    expect((await fail(network.http.json(credentials, { method: "GET", path: "/tbo/primary" }))).reason).toBe(
      "unavailable",
    )
    expect((await fail(network.http.json(credentials, { method: "POST", path: "/tbo/primary" }))).reason).toBe(
      "disconnected",
    )
    expect(network.calls).toHaveLength(2)
    const malformed = harness(() => new Response("{not json", { status: 200 }))
    expect((await fail(malformed.http.json(credentials, { method: "GET", path: "/tbo/primary" }))).reason).toBe(
      "invalid-response",
    )
    expect((await fail(malformed.http.json(credentials, { method: "POST", path: "/tbo/primary" }))).reason).toBe(
      "disconnected",
    )
    const empty = harness(() => new Response(null, { status: 204 }))
    expect(
      await Effect.runPromise(empty.http.json(credentials, { method: "POST", path: "/tbo/primary" })),
    ).toBeUndefined()
  })

  test("never exposes credentials, account ids, or response bodies in errors", async () => {
    const responses = [
      () => new Response("body synthetic-access-token synthetic-account-id", { status: 401 }),
      () => new Response("body synthetic-access-token synthetic-account-id", { status: 400 }),
      () => new Response("synthetic-access-token", { status: 502 }),
      () => Promise.reject(new Error("synthetic-access-token synthetic-account-id")),
    ]
    for (const respond of responses) {
      for (const method of ["GET", "POST"] as const) {
        const { http } = harness(respond)
        const error = await fail(http.json(credentials, { method, path: "/tbo/primary" }))
        const text = JSON.stringify(error) + error.message
        expect(text).not.toContain("synthetic-access-token")
        expect(text).not.toContain("synthetic-account-id")
        expect(text).not.toContain("body")
        expect(error.message.length).toBeGreaterThan(0)
      }
    }
  })

  test("forwards Effect cancellation through the fetch signal", async () => {
    let signal: AbortSignal | undefined
    const started = Promise.withResolvers<void>()
    const { http } = harness((_call, init) => {
      signal = init.signal ?? undefined
      started.resolve()
      return new Promise<Response>(() => {})
    })
    const fiber = Effect.runFork(http.json(credentials, { method: "POST", path: "/tbo/primary" }))
    await started.promise
    expect(signal?.aborted).toBe(false)
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(signal?.aborted).toBe(true)
  })
})

describe("Dots pubsub", () => {
  const credentials: DotsTransport.Credentials = { access: "synthetic-access-token", accountID: "synthetic-account-id" }
  const secretURL = "wss://pubsub.example.invalid/socket?ticket=synthetic-ticket-secret"
  const connectCommand = { type: "connect", presence: { type: "presence", state: "foreground" } }
  const subscribeCommand = (topic: string) => ({ type: "subscribe", topic_id: topic })

  class FakeSocket {
    readyState = 0
    sent: string[] = []
    closed = 0
    listeners = new Map<string, Set<(event: { readonly data?: unknown }) => void>>()
    constructor(readonly url: string) {}
    addEventListener(type: string, listener: (event: { readonly data?: unknown }) => void) {
      const set = this.listeners.get(type) ?? new Set()
      set.add(listener)
      this.listeners.set(type, set)
    }
    removeEventListener(type: string, listener: (event: { readonly data?: unknown }) => void) {
      this.listeners.get(type)?.delete(listener)
    }
    send(data: string) {
      this.sent.push(data)
    }
    close() {
      this.closed++
      this.readyState = 3
    }
    emit(type: string, data?: unknown) {
      for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ data })
    }
    open() {
      this.readyState = 1
      this.emit("open")
    }
    receive(value: unknown) {
      this.emit("message", typeof value === "string" ? value : JSON.stringify(value))
    }
    listenerCount() {
      return [...this.listeners.values()].reduce((total, set) => total + set.size, 0)
    }
    frames() {
      return this.sent.map((frame) => JSON.parse(frame) as unknown)
    }
  }

  const setup = (response: unknown = { websocket_url: secretURL }) => {
    const requests: DotsHttp.Request[] = []
    const sockets: FakeSocket[] = []
    const created = Promise.withResolvers<FakeSocket>()
    const http: Pick<DotsHttp.Interface, "json"> = {
      json: (_credentials, input) =>
        Effect.sync(() => {
          requests.push(input)
          return response
        }),
    }
    const pubsub = DotsPubSub.make({
      http,
      open: (url) => {
        const socket = new FakeSocket(url)
        sockets.push(socket)
        created.resolve(socket)
        return socket
      },
    })
    return { pubsub, requests, sockets, created: created.promise }
  }

  const failure = async <A>(effect: Effect.Effect<A, DotsTransport.Error>) => {
    const exit = await Effect.runPromiseExit(effect)
    if (Exit.isSuccess(exit)) throw new Error("expected failure")
    const error = Cause.squash(exit.cause)
    if (!(error instanceof DotsTransport.Error)) throw error
    return error
  }

  const collect = (connection: DotsPubSub.Connection) => Effect.runPromise(Stream.runCollect(connection.events))
  const collectExit = (connection: DotsPubSub.Connection) => Effect.runPromiseExit(Stream.runCollect(connection.events))

  const open = async (setupResult = setup()) => {
    const scope = await Effect.runPromise(Scope.make())
    const connection = await Effect.runPromise(
      setupResult.pubsub.connect(credentials).pipe(Effect.provideService(Scope.Scope, scope)),
    )
    const socket = setupResult.sockets[0]
    if (!socket) throw new Error("the socket was not opened")
    return { ...setupResult, scope, connection, socket }
  }
  const close = (scope: Scope.Closeable) => Effect.runPromise(Scope.close(scope, Exit.void))

  test("opens the websocket URL from the user route and batches connect with initial subscribes", async () => {
    const { pubsub, requests, sockets } = setup()
    const scope = await Effect.runPromise(Scope.make())
    const connection = await Effect.runPromise(
      pubsub.connect(credentials).pipe(Effect.provideService(Scope.Scope, scope)),
    )
    expect(requests).toEqual([{ method: "GET", path: "/celsius/ws/user" }])
    expect(sockets).toHaveLength(1)
    const socket = sockets[0]!
    expect(socket.url).toBe(secretURL)
    const done: string[] = []
    const subscribed = Effect.runPromise(
      Effect.all(
        [
          connection.subscribe("topic_a").pipe(Effect.tap(() => Effect.sync(() => done.push("a")))),
          connection.subscribe("topic_b").pipe(Effect.tap(() => Effect.sync(() => done.push("b")))),
          Effect.gen(function* () {
            yield* Effect.yieldNow
            expect(socket.sent).toHaveLength(0)
            socket.open()
            expect(socket.frames()).toEqual([
              [
                { id: 1, command: connectCommand },
                { id: 2, command: subscribeCommand("topic_a") },
                { id: 3, command: subscribeCommand("topic_b") },
              ],
            ])
            expect(done).toEqual([])
            socket.receive([{ id: 1, reply: { type: "connect" } }])
            expect(done).toEqual([])
            socket.receive([{ id: 3, reply: { type: "subscribe", topic_id: "topic_b", recovered: false } }])
            socket.receive([{ id: 2, reply: { type: "subscribe", topic_id: "topic_a", recovered: false } }])
          }),
        ],
        { concurrency: "unbounded" },
      ),
    )
    await subscribed
    expect(done.sort()).toEqual(["a", "b"])
    await close(scope)
    expect(Array.from(await collect(connection))).toEqual([
      { type: "resync", topicID: "topic_b" },
      { type: "resync", topicID: "topic_a" },
    ])
  })

  test("resyncs on the initial subscription and replays catchups before live messages", async () => {
    const { connection, socket, scope } = await open()
    socket.open()
    const subscribed = Effect.runPromise(connection.subscribe("topic_a"))
    expect(socket.frames().at(-1)).toEqual([{ id: 2, command: subscribeCommand("topic_a") }])
    socket.receive([
      {
        id: 2,
        reply: {
          type: "subscribe",
          topic_id: "topic_a",
          recovered: true,
          last_offset: "3",
          catchups: [
            { type: "message", topic_id: "topic_a", payload: { n: 1 }, offset: "2" },
            { type: "message", topic_id: "topic_a", payload: { n: 2 }, offset: "3" },
          ],
        },
      },
    ])
    await subscribed
    socket.receive([
      { type: "message", topic_id: "topic_other", payload: { n: 9 } },
      { type: "message", topic_id: "topic_a", payload: { n: 3 }, offset: "4" },
    ])
    await close(scope)
    expect(Array.from(await collect(connection))).toEqual([
      { type: "resync", topicID: "topic_a" },
      { type: "message", topicID: "topic_a", payload: { n: 1 } },
      { type: "message", topicID: "topic_a", payload: { n: 2 } },
      { type: "message", topicID: "topic_a", payload: { n: 3 } },
    ])
  })

  test("emits a resync without catchups when the subscription was not recovered", async () => {
    const { connection, socket, scope } = await open()
    socket.open()
    const subscribed = Effect.runPromise(connection.subscribe("topic_a"))
    socket.receive([
      {
        id: 2,
        reply: {
          type: "subscribe",
          topic_id: "topic_a",
          recovered: false,
          catchups: [{ type: "message", topic_id: "topic_a", payload: "stale" }],
        },
      },
    ])
    await subscribed
    await close(scope)
    expect(Array.from(await collect(connection))).toEqual([{ type: "resync", topicID: "topic_a" }])
  })

  test("deduplicates repeated and concurrent subscriptions to one topic", async () => {
    const { connection, socket, scope } = await open()
    socket.open()
    const first = Effect.runPromise(connection.subscribe("topic_a"))
    const second = Effect.runPromise(connection.subscribe("topic_a"))
    socket.receive([{ id: 2, reply: { type: "subscribe", topic_id: "topic_a", recovered: false } }])
    await Promise.all([first, second])
    await Effect.runPromise(connection.subscribe("topic_a"))
    expect(socket.frames()).toEqual([
      [{ id: 1, command: connectCommand }],
      [{ id: 2, command: subscribeCommand("topic_a") }],
    ])
    await close(scope)
    expect(Array.from(await collect(connection))).toEqual([{ type: "resync", topicID: "topic_a" }])
  })

  test("ignores unsupported control envelopes", async () => {
    const { connection, socket, scope } = await open()
    socket.open()
    const subscribed = Effect.runPromise(connection.subscribe("topic_a"))
    socket.receive({ type: "heartbeat", extra: true })
    socket.receive([{ id: 2, reply: { type: "subscribe", topic_id: "topic_a", recovered: false } }])
    await subscribed
    await close(scope)
    expect(Array.from(await collect(connection))).toEqual([{ type: "resync", topicID: "topic_a" }])
  })

  test("fails a mismatched subscribe reply without exposing payloads", async () => {
    const { connection, socket } = await open()
    socket.open()
    const subscribed = failure(connection.subscribe("topic_a"))
    socket.receive([{ id: 2, reply: { type: "subscribe", topic_id: "synthetic-wrong-topic", recovered: true } }])
    const error = await subscribed
    expect(error.reason).toBe("invalid-response")
    expect(JSON.stringify(error) + error.message).not.toContain("synthetic-wrong-topic")
    const exit = await collectExit(connection)
    expect(Exit.isFailure(exit)).toBe(true)
  })

  test("fails the connection on malformed frames with redacted errors", async () => {
    for (const frame of [
      "{synthetic-secret-payload",
      JSON.stringify("synthetic-secret-payload"),
      JSON.stringify([{ nope: "synthetic-secret-payload" }]),
      JSON.stringify({ synthetic: "secret-payload" }),
    ]) {
      const { connection, socket } = await open()
      socket.open()
      const subscribed = failure(connection.subscribe("topic_a"))
      socket.receive(frame)
      const error = await subscribed
      expect(error.reason).toBe("invalid-response")
      const exit = await collectExit(connection)
      if (Exit.isSuccess(exit)) throw new Error("expected failure")
      const streamed = Cause.squash(exit.cause)
      expect(streamed).toBeInstanceOf(DotsTransport.Error)
      const text =
        JSON.stringify(error) + error.message + JSON.stringify(streamed) + String((streamed as Error).message)
      expect(text).not.toContain("synthetic-secret")
      expect(text).not.toContain("ticket")
    }
  })

  test("a socket close releases pending subscriptions and fails the stream", async () => {
    const { connection, socket } = await open()
    socket.open()
    const subscribed = failure(connection.subscribe("topic_a"))
    socket.emit("close")
    expect((await subscribed).reason).toBe("disconnected")
    const exit = await collectExit(connection)
    if (Exit.isSuccess(exit)) throw new Error("expected failure")
    expect((Cause.squash(exit.cause) as DotsTransport.Error).reason).toBe("disconnected")
    expect((await failure(connection.subscribe("topic_b"))).reason).toBe("disconnected")
  })

  test("a socket error before open fails pending subscriptions", async () => {
    const { connection, socket } = await open()
    const subscribed = failure(connection.subscribe("topic_a"))
    socket.emit("error")
    expect((await subscribed).reason).toBe("disconnected")
    expect(socket.sent).toEqual([])
  })

  test("closing the scope unsubscribes owned topics, closes the socket, and removes listeners", async () => {
    const { connection, socket, scope } = await open()
    socket.open()
    const subscribed = Effect.runPromise(connection.subscribe("topic_a"))
    socket.receive([{ id: 2, reply: { type: "subscribe", topic_id: "topic_a", recovered: false } }])
    await subscribed
    const pending = failure(connection.subscribe("topic_b"))
    await close(scope)
    expect(socket.frames().at(-1)).toEqual([
      { id: 4, command: { type: "unsubscribe", topic_id: "topic_a" } },
      { id: 5, command: { type: "unsubscribe", topic_id: "topic_b" } },
    ])
    expect(socket.closed).toBe(1)
    expect(socket.listenerCount()).toBe(0)
    expect((await pending).reason).toBe("disconnected")
    expect(Array.from(await collect(connection))).toEqual([{ type: "resync", topicID: "topic_a" }])
  })

  test("closing the scope before the socket opens closes without sending commands", async () => {
    const { connection, socket, scope } = await open()
    const pending = failure(connection.subscribe("topic_a"))
    await close(scope)
    expect(socket.sent).toEqual([])
    expect(socket.closed).toBe(1)
    expect(socket.listenerCount()).toBe(0)
    expect((await pending).reason).toBe("disconnected")
  })

  test("interrupting a fiber waiting on a subscription closes the socket", async () => {
    const { pubsub, created } = setup()
    const fiber = Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* pubsub.connect(credentials)
          yield* connection.subscribe("topic_a")
        }),
      ),
    )
    const socket = await created
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(socket.closed).toBe(1)
    expect(socket.listenerCount()).toBe(0)
  })

  test("rejects unsafe websocket URLs before opening a socket", async () => {
    const responses: unknown[] = [
      null,
      {},
      { websocket_url: 1 },
      { websocket_url: "ws://pubsub.example.invalid/socket" },
      { websocket_url: "https://pubsub.example.invalid/socket" },
      { websocket_url: "wss://synthetic-user:synthetic-pass@pubsub.example.invalid/socket" },
      { websocket_url: "wss://pubsub.example.invalid/socket#synthetic-fragment" },
      { websocket_url: "not a url synthetic-ticket-secret" },
    ]
    for (const response of responses) {
      const { pubsub, sockets } = setup(response)
      const error = await failure(Effect.scoped(pubsub.connect(credentials)))
      expect(error.reason).toBe("invalid-response")
      expect(sockets).toHaveLength(0)
      const text = JSON.stringify(error) + error.message
      expect(text).not.toContain("synthetic")
    }
  })
})
