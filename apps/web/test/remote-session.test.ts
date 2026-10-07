import { describe, expect, test } from "bun:test"
import { isRemoteLatencySample, type RemoteNoticeFrame } from "@ycoding-ai/remote"
import { canReplyToRequest, sessionStatusLabel, visibleTranscriptMessages } from "../src/remote/projection"
import { createRemoteHttp } from "../src/remote/http"
import { createRemoteStore, readSessionInfo, type RemoteStore } from "../src/remote/store"
import { createRemoteTransport, type RemoteRequestTiming, type RemoteTransport, type RemoteTransportStatus } from "../src/remote/transport"
import { startRelayDouble, waitFor, type RelayDouble, type RelayHandlerOutcome, type RelayHandlerResult } from "./relay-double"

type Harness = {
  readonly store: RemoteStore
  readonly relay: RelayDouble
  readonly flush: () => Promise<void>
  readonly runUntil: (predicate: () => boolean, attempts?: number) => Promise<void>
  readonly stop: () => Promise<void>
}

async function harness(options: {
  fetch?: (input: string, init?: RequestInit) => Promise<Response>
  handler?: (request: { operation: string; input?: Readonly<Record<string, unknown>>; sessionID?: string }) => RelayHandlerResult
  messages?: Record<string, readonly unknown[]>
  watermark?: number
  autonomy?: unknown
  permissions?: readonly unknown[]
  guardrailRequests?: readonly unknown[]
  forms?: readonly unknown[]
  now?: () => number
  paceLongTimers?: boolean
  requestTimeoutMs?: number
  latencyUploadIntervalMs?: number
} = {}): Promise<Harness> {
  const relay = await startRelayDouble({
    handler: options.handler,
    messages: options.messages,
    watermark: options.watermark,
    autonomy: options.autonomy,
    permissions: options.permissions,
    guardrailRequests: options.guardrailRequests,
    forms: options.forms,
    advertisedSessions: ["ses_a", "ses_b"],
  })
  const timers: (() => void)[] = []
  const longTimers = new Set<ReturnType<typeof setTimeout>>()
  const schedule = (callback: () => void, ms = 0) => {
    if (ms >= 1_000) {
      if (!options.paceLongTimers || ms > 10_000) return () => {}
      const timer = setTimeout(() => { longTimers.delete(timer); callback() }, ms)
      longTimers.add(timer)
      return () => { clearTimeout(timer); longTimers.delete(timer) }
    }
    timers.push(callback)
    return () => {
      const index = timers.indexOf(callback)
      if (index >= 0) timers.splice(index, 1)
    }
  }
  const flush = async () => {
    await Bun.sleep(15)
    const pending = timers.splice(0)
    for (const callback of pending) callback()
  }
  const store = createRemoteStore({
    http: createRemoteHttp({ baseURL: relay.httpURL }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    createTransport: (deviceID, handlers) =>
      createRemoteTransport({ url: relay.wsURL(deviceID), handlers, resetDelayMs: 10, maxDelayMs: 20, schedule, createSocket: relay.createSocket,
        ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }) }),
    schedule,
    batchMs: 20,
    now: options.now ?? (() => 1_000),
    createMessageID: () => "msg_local_1",
    ...(options.latencyUploadIntervalMs === undefined ? {} : { latencyUploadIntervalMs: options.latencyUploadIntervalMs }),
  })
  const runUntil = async (predicate: () => boolean, attempts = 100) => {
    for (let index = 0; index < attempts && !predicate(); index += 1) {
      await flush()
      await Bun.sleep(5)
    }
    if (!predicate()) throw new Error("runUntil did not settle")
  }
  return {
    store,
    relay,
    flush,
    runUntil,
    stop: async () => {
      store.dispose()
      longTimers.forEach(clearTimeout)
      await relay.stop()
    },
  }
}

type FakeSocket = {
  readonly publish: (status: RemoteTransportStatus) => void
  readonly sessions: (sessionIDs: readonly string[]) => void
  readonly event: (sessionID: string, event: unknown) => void
  readonly statusFrame: (running: readonly string[], attention: readonly string[]) => void
  readonly notices: (frame: RemoteNoticeFrame) => void
  readonly reconnect: () => void
  readonly timing: (sample: RemoteRequestTiming) => void
  readonly unsubscribes: string[]
  readonly requests: string[]
}

/**
 * Drives the store through injected transports so a replaced socket's callbacks are
 * delivered by hand, in any order. A real socket cannot be asked to publish a frame
 * after the connection that replaced it is already live.
 */
async function fakeConnectionHarness(options: { readonly latencyUploadIntervalMs?: number } = {}) {
  const relay = await startRelayDouble({ advertisedSessions: ["ses_a", "ses_b"] })
  const sockets: FakeSocket[] = []
  const timers: (() => void)[] = []
  const schedule = (callback: () => void, ms = 0) => {
    if (ms >= 1_000) return () => {}
    timers.push(callback)
    return () => {
      const index = timers.indexOf(callback)
      if (index >= 0) timers.splice(index, 1)
    }
  }
  const flush = async () => {
    await Bun.sleep(15)
    const pending = timers.splice(0)
    for (const callback of pending) callback()
  }
  const store = createRemoteStore({
    http: createRemoteHttp({ baseURL: relay.httpURL }),
    createTransport: (_deviceID, handlers) => {
      const socket: FakeSocket = {
        publish: (status) => handlers.onStatus?.(status),
        sessions: (_sessionIDs) => handlers.onSessions?.(),
        event: (sessionID, event) => handlers.onEvents?.(sessionID, [event]),
        statusFrame: (running, attention) => handlers.onSessionStatus?.({ running, attention }),
        notices: (frame) => handlers.onNotices?.(frame),
        reconnect: () => handlers.onReconnect?.(),
        timing: (sample) => handlers.onRequestTiming?.(sample),
        unsubscribes: [],
        requests: [],
      }
      sockets.push(socket)
      const transport: RemoteTransport = {
        connect: () => {
          handlers.onStatus?.({ kind: "open" })
          handlers.onSessionStatus?.({ running: [], attention: [] })
        },
        // The replaced socket reports nothing; these cases publish its late frames by hand.
        close: () => {},
        setPriority: () => {},
        status: () => ({ kind: "open" }),
        request: async (operation, input) => {
          socket.requests.push(operation)
          if (operation === "session.unsubscribe") socket.unsubscribes.push(String(input?.sessionID))
          if (operation === "session.snapshot") {
            return {
              status: "ok",
              value: {
                session: { title: "t" },
                messages: [],
                watermark: { type: "log.synced", aggregateID: input?.sessionID, seq: 0 },
              },
            }
          }
          if (operation === "notice.subscribe") return { status: "ok", value: { notices: [], total: 0, unavailable: false } }
          if (operation === "session.list") return { status: "ok", value: { data: [] } }
          if (operation === "session.active") return { status: "ok", value: { data: {} } }
          return { status: "ok", value: { data: {} } }
        },
      }
      return transport
    },
    schedule,
    batchMs: 20,
    ...(options.latencyUploadIntervalMs === undefined ? {} : { latencyUploadIntervalMs: options.latencyUploadIntervalMs }),
    now: () => 1_000,
  })
  return {
    relay,
    store,
    sockets,
    flush,
    stop: async () => {
      store.dispose()
      await relay.stop()
    },
  }
}

describe("remote store integration", () => {
  test("reports an old machine as unsupported without repeatedly uploading the same samples", async () => {
    const test = await harness({ latencyUploadIntervalMs: 20, handler: (request) => request.operation === "machine.latency.append"
      ? { ok: false, code: "unknown_operation", message: "Update YCoding" } : "default" })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().latencySync === "unsupported")
      const attempts = test.relay.requests.filter((request) => request.operation === "machine.latency.append").length
      expect(attempts).toBe(1)
      await test.flush()
      await test.flush()
      expect(test.relay.requests.filter((request) => request.operation === "machine.latency.append")).toHaveLength(attempts)
    } finally { await test.stop() }
  })

  test("clearing the tab drops queued unsent machine telemetry", async () => {
    const test = await fakeConnectionHarness({ latencyUploadIntervalMs: 20 })
    try {
      await test.store.load()
      await waitFor(() => test.sockets.length > 0)
      const socket = test.sockets[0]!
      socket.timing({ operation: "session.list", outcome: "ok", queueMs: 0, settlementMs: 8, totalMs: 8 })
      test.store.latency.clear()
      await test.flush()
      expect(socket.requests.filter((operation) => operation === "machine.latency.append")).toEqual([])
      expect(test.store.latency.snapshot().samples).toEqual([])
    } finally { await test.stop() }
  })

  test("reads only bounded machine-stored samples and fences a replaced device", async () => {
    const sample = { kind: "request", at: "2026-10-04T12:00:00.000Z", operation: "session.list", outcome: "ok", queueMs: 0, settlementMs: 8, totalMs: 8 } as const
    const row = { receivedAt: Date.UTC(2026, 9, 4, 12), sample }
    let release = (_value: unknown) => {}
    const gate = new Promise<unknown>((resolve) => { release = resolve })
    let lists = 0
    const test = await harness({ handler: (request) => {
      if (request.operation !== "machine.latency.list") return "default"
      lists += 1
      return lists === 1 ? { ok: true, value: { data: [row], cursor: { next: "opaque_1" } } } : gate.then((value) => ({ ok: true, value }))
    } })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().sessions.some((session) => session.id === "ses_a"))
      expect(await test.store.readStoredLatency()).toEqual({ status: "ok", data: [row], next: "opaque_1" })
      const pending = test.store.readStoredLatency("opaque_1")
      await test.runUntil(() => lists === 2)
      test.store.connect("dev_2")
      release({ data: [row], cursor: {} })
      expect((await pending).status).toBe("unavailable")
      expect(test.relay.requests.filter((request) => request.operation === "machine.latency.list").map((request) => request.input)).toEqual([undefined, { before: "opaque_1" }])
    } finally { await test.stop() }
  })

  test("automatically batches only sanitized selected-machine timings and never records its own upload", async () => {
    const test = await harness({ latencyUploadIntervalMs: 20, handler: (request) =>
      request.operation === "machine.latency.append" ? { ok: true, value: { accepted: Array.isArray(request.input?.samples) ? request.input.samples.length : 0 } } : "default" })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().sessions.some((session) => session.id === "ses_a"))
      await test.runUntil(() => test.relay.requests.some((request) => request.operation === "machine.latency.append"))
      const uploads = test.relay.requests.filter((request) => request.operation === "machine.latency.append")
      const samples = uploads.flatMap((request) => Array.isArray(request.input?.samples) ? request.input.samples : [])
      expect(samples.length).toBeGreaterThan(0)
      expect(samples.length).toBeLessThanOrEqual(20)
      expect(samples.every(isRemoteLatencySample)).toBe(true)
      expect(samples.some((sample) => typeof sample === "object" && sample !== null && "operation" in sample && sample.operation === "account.read")).toBe(false)
      expect(samples.some((sample) => typeof sample === "object" && sample !== null && "operation" in sample && sample.operation === "machine.latency.append")).toBe(false)
      expect(JSON.stringify(samples)).not.toMatch(/ses_a|dev_1|user_1|"(?:text|input|value|url)":/)
      await test.flush()
      expect(test.relay.requests.filter((request) => request.operation === "machine.latency.append")).toHaveLength(uploads.length)
    } finally { await test.stop() }
  })

  test("records real relay list and account timings without recording request or response contents", async () => {
    const test = await harness()
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().sessions.some((session) => session.id === "ses_a"))
      const report = test.store.latency.snapshot()
      expect(report.samples).toContainEqual(expect.objectContaining({ kind: "request", operation: "account.read", outcome: "ok" }))
      expect(report.samples).toContainEqual(expect.objectContaining({ kind: "request", operation: "session.list", outcome: "ok" }))
      const list = report.samples.find((sample) => sample.kind === "request" && sample.operation === "session.list")
      expect(list).toMatchObject({ queueMs: expect.any(Number), settlementMs: expect.any(Number), totalMs: expect.any(Number) })
      expect(JSON.stringify(report)).not.toMatch(/ses_a|dev_1|user_1|Studio Mac|"(?:message|input|value)":/)
    } finally { await test.stop() }
  })

  test("keeps only recent anonymous latency samples from the active machine and clears them on replacement and disconnect", async () => {
    const test = await fakeConnectionHarness()
    try {
      await test.store.load()
      await waitFor(() => test.sockets.length > 0)
      const first = test.sockets[0]!
      for (let index = 0; index < 65; index += 1) first.timing({ operation: "session.list", outcome: "ok", queueMs: 0, settlementMs: index, totalMs: index })
      const report = test.store.latency.snapshot()
      expect(report.samples).toHaveLength(60)
      expect(report.samples[0]).toMatchObject({ kind: "request", operation: "session.list", settlementMs: 5 })
      expect(report.samples.at(-1)).toMatchObject({ operation: "session.list", settlementMs: 64 })
      expect(JSON.stringify(report)).not.toMatch(/ses_a|dev_1|user_1|private/)
      test.store.connect("dev_2")
      expect(test.store.latency.snapshot().samples).toEqual([])
      first.timing({ operation: "session.list", outcome: "failed", queueMs: 1, settlementMs: 10, totalMs: 11 })
      expect(test.store.latency.snapshot().samples).toEqual([])
      test.sockets.at(-1)!.timing({ operation: "session.list", outcome: "unknown", queueMs: 1, settlementMs: 10, totalMs: 11 })
      expect(test.store.latency.snapshot().samples).toHaveLength(1)
      test.store.disconnect()
      expect(test.store.latency.snapshot().samples).toEqual([])
    } finally { await test.stop() }
  })

  test("compacts the selected Session without sending a prompt or clearing another Session's draft", async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const test = await harness({ handler: async (request) => {
      if (request.operation !== "session.compact") return "default" as const
      await gate
      return { ok: true as const, value: { data: { id: request.input?.id, sessionID: request.sessionID, trigger: "manual", status: "ended", requestedThrough: { messageID: "msg_1", seq: 1 }, timeCreated: 100 } } }
    } })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().sessions.some((session) => session.id === "ses_a"))
      await test.store.selectSession("ses_a")
      const pending = test.store.compactSession()
      await test.runUntil(() => test.relay.requests.some((request) => request.operation === "session.compact"))
      const request = test.relay.requests.find((request) => request.operation === "session.compact")!
      expect(request.sessionID).toBe("ses_a")
      expect(request.input?.id).toMatch(/^cmp_[A-Za-z0-9_-]+$/)
      expect(test.store.state().mutations.find((mutation) => mutation.operation === "session.compact")?.state).toBe("sending")
      await test.store.selectSession("ses_b")
      test.store.setDraft("ses_b", "Keep this draft")
      release()
      expect(await pending).toBe(true)
      expect(test.store.state().activeSessionID).toBe("ses_b")
      expect(test.store.state().drafts.ses_b).toBe("Keep this draft")
      expect(test.store.state().mutations.some((mutation) => mutation.operation === "session.compact")).toBe(false)
      expect(test.store.state().mutationToasts ?? []).toEqual([])
      expect(test.relay.requests.filter((request) => request.operation === "session.prompt" || request.operation === "session.command")).toEqual([])
    } finally { release(); await test.stop() }
  })

  test("settles a long compaction from its durable job instead of the request timeout", async () => {
    const test = await harness({ requestTimeoutMs: 40, handler: (request) => request.operation === "session.compact"
      ? new Promise<RelayHandlerOutcome>(() => {})
      : "default" })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().sessions.some((session) => session.id === "ses_a"))
      await test.store.selectSession("ses_a")
      const pending = test.store.compactSession()
      await test.runUntil(() => test.relay.requests.some((request) => request.operation === "session.compact"))
      const jobID = test.relay.requests.find((request) => request.operation === "session.compact")!.input!.id as string
      test.relay.pushEvent("ses_a", { type: "session.compaction.started", data: { sessionID: "ses_a", jobID }, created: 10 })
      await test.runUntil(() => test.store.state().view?.messages.some((message) => message.kind === "compaction" && message.jobID === jobID) ?? false)
      await test.runUntil(() => test.relay.requests.length > 0 && test.store.state().mutations.find((mutation) => mutation.operation === "session.compact")?.state === "sending", 30)
      expect(test.store.state().mutations.find((mutation) => mutation.operation === "session.compact")?.state).toBe("sending")
      expect(test.store.state().mutationToasts ?? []).toEqual([])
      test.relay.pushEvent("ses_a", { type: "session.compaction.ended", data: { sessionID: "ses_a", jobID, boundary: { messageID: "msg_1", seq: 1 } }, created: 20 })
      await test.runUntil(() => !test.store.state().mutations.some((mutation) => mutation.operation === "session.compact"))
      expect(await pending).toBe(true)
      expect(test.store.state().mutationToasts ?? []).toEqual([])
    } finally { await test.stop() }
  })

  test("reports a compaction whose durable job fails after the request lost its outcome", async () => {
    const test = await harness({ requestTimeoutMs: 40, handler: (request) => request.operation === "session.compact"
      ? new Promise<RelayHandlerOutcome>(() => {})
      : "default" })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().sessions.some((session) => session.id === "ses_a"))
      await test.store.selectSession("ses_a")
      const pending = test.store.compactSession()
      await test.runUntil(() => test.relay.requests.some((request) => request.operation === "session.compact"))
      const jobID = test.relay.requests.find((request) => request.operation === "session.compact")!.input!.id as string
      test.relay.pushEvent("ses_a", { type: "session.compaction.started", data: { sessionID: "ses_a", jobID }, created: 10 })
      await test.runUntil(() => test.store.state().view?.messages.some((message) => message.kind === "compaction" && message.jobID === jobID) ?? false)
      test.relay.pushEvent("ses_a", { type: "session.compaction.failed", data: { sessionID: "ses_a", jobID, code: "provider_failed", error: { code: "provider_failed", message: "Compaction failed: provider_failed" } }, created: 20 })
      await test.runUntil(() => test.store.state().mutations.find((mutation) => mutation.operation === "session.compact")?.state === "failed")
      expect(await pending).toBe(false)
      expect(test.store.state().mutationToasts).toMatchObject([{ state: "failed", detail: "Compaction failed: provider_failed" }])
    } finally { await test.stop() }
  })

  test("keeps a failed compaction visible and retries only explicitly with its same ID", async () => {
    const test = await harness({ handler: (request) => request.operation === "session.compact"
      ? { ok: false, code: "internal_error", message: "Compaction failed: provider_failed" }
      : "default" })
    try {
      expect(await test.store.compactSession()).toBe(false)
      await test.store.load()
      await test.runUntil(() => test.store.state().sessions.some((session) => session.id === "ses_a"))
      await test.store.selectSession("ses_a")
      expect(await test.store.compactSession()).toBe(false)
      const mutation = test.store.state().mutations.find((entry) => entry.operation === "session.compact")!
      expect(mutation.state).toBe("failed")
      expect(test.store.state().mutationToasts).toMatchObject([{ state: "failed", detail: "Compaction failed: provider_failed" }])
      expect(test.relay.requests.filter((request) => request.operation === "session.compact")).toHaveLength(1)
      await test.store.retryMutation(mutation.id)
      expect(test.relay.requests.filter((request) => request.operation === "session.compact").map((request) => request.input?.id)).toEqual([mutation.input.id, mutation.input.id])
    } finally { await test.stop() }
  })

  test("loads exactly through the completed checkpoint and never requests the cursor before it", async () => {
    const metrics = { excludedMessages: 5, excludedParts: 0, inputTokens: 1_000, retainedTokens: 400 }
    const pages: Record<string, { readonly before?: string; readonly messages: readonly unknown[] }> = {
      newest: { before: "middle", messages: [{ id: "msg_after", type: "user", text: "after", time: { created: 9 } }] },
      middle: { before: "checkpoint", messages: [{ id: "msg_middle", type: "user", text: "middle", time: { created: 8 } }] },
      checkpoint: { before: "covered", messages: [
        { id: "msg_complete", type: "compaction", jobID: "cmp_done", trigger: "manual", status: "completed", revision: 1, boundary: { messageID: "msg_covered", seq: 2 }, metrics, time: { created: 3 } },
        { id: "msg_retained", type: "user", text: "retained", time: { created: 4 } },
      ] },
    }
    const test = await harness({ handler: (request) => request.operation === "session.snapshot"
      ? { ok: true, value: { session: { id: request.sessionID }, watermark: { seq: 10 }, ...pages[typeof request.input?.before === "string" ? request.input.before : "newest"] } }
      : "default" })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().sessions.some((session) => session.id === "ses_a"))
      await test.store.selectSession("ses_a")
      await test.store.loadOlderMessages()
      await test.store.loadOlderMessages()
      expect(test.store.state().history?.before).toBeUndefined()
      expect(visibleTranscriptMessages(test.store.state().view?.messages ?? []).map((message) => message.id)).toEqual(["msg_complete", "msg_retained", "msg_middle", "msg_after"])
      await test.store.loadOlderMessages()
      expect(test.relay.requests.filter((request) => request.operation === "session.snapshot").map((request) => request.input?.before)).toEqual([undefined, "middle", "checkpoint"])
    } finally { await test.stop() }
  })

  test("does not page beyond an initial checkpoint, including when a newer compaction is running", async () => {
    const test = await harness({ handler: (request) => request.operation === "session.snapshot"
      ? { ok: true, value: { session: { id: request.sessionID }, watermark: { seq: 10 }, before: "covered", messages: [
        { id: "msg_complete", type: "compaction", jobID: "cmp_done", trigger: "manual", status: "completed", revision: 1, boundary: { messageID: "msg_covered", seq: 2 }, metrics: { excludedMessages: 2, excludedParts: 0, inputTokens: 100, retainedTokens: 40 }, time: { created: 3 } },
        { id: "msg_running", type: "compaction", jobID: "cmp_new", trigger: "manual", status: "running", time: { created: 4 } },
      ] } }
      : "default" })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().sessions.some((session) => session.id === "ses_a"))
      await test.store.selectSession("ses_a")
      await test.store.loadOlderMessages()
      expect(test.store.state().history?.before).toBeUndefined()
      expect(visibleTranscriptMessages(test.store.state().view?.messages ?? []).map((message) => message.id)).toEqual(["msg_running"])
      expect(test.relay.requests.filter((request) => request.operation === "session.snapshot")).toHaveLength(1)
    } finally { await test.stop() }
  })

  test("continues paging without a completed checkpoint for pending, running and failed compactions", async () => {
    const statuses = ["pending", "running", "failed"] as const
    for (const status of statuses) {
      const test = await harness({ handler: (request) => request.operation === "session.snapshot"
        ? { ok: true, value: { session: { id: request.sessionID }, watermark: { seq: 10 },
          ...(request.input?.before ? {} : { before: "older" }), messages: request.input?.before ? [
            { id: "msg_old", type: "user", text: "old", time: { created: 1 } },
          ] : [{ id: "msg_compact", type: "compaction", jobID: "cmp_new", trigger: "manual", status,
            ...(status === "failed" ? { code: "provider_failed", error: { type: "compaction.failed", message: "Failed" } } : {}), time: { created: 2 } }] } }
        : "default" })
      try {
        await test.store.load()
        await test.runUntil(() => test.store.state().sessions.some((session) => session.id === "ses_a"))
        await test.store.selectSession("ses_a")
        await test.store.loadOlderMessages()
        expect(test.store.state().history?.before).toBeUndefined()
        expect(test.store.state().view?.messages.some((message) => message.id === "msg_old")).toBe(true)
        expect(test.relay.requests.filter((request) => request.operation === "session.snapshot").map((request) => request.input?.before)).toEqual([undefined, "older"])
      } finally { await test.stop() }
    }
  })

  test("exposes an unresolved first carousel read and releases it after an authoritative empty result", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const test = await harness({ handler: async (request) => {
      if (request.operation !== "session.list" || request.input?.workspace !== undefined) return "default" as const
      if (request.input?.status === "running") await gate
      return { ok: true as const, value: { data: [] } }
    } })
    try {
      await test.store.load()
      await test.runUntil(() => test.relay.requests.some((request) => request.operation === "session.list" && request.input?.status === "running"))
      expect(test.store.state().carouselStatus).toBe("loading")
      expect(test.store.state().carouselSessions).toEqual([])
      release()
      await test.runUntil(() => test.store.state().carouselStatus === "ready")
      expect(test.store.state().carouselSessions).toEqual([])
    } finally { release(); await test.stop() }
  })

  test("keeps resident Sessions stable through a delayed filter until the keyed result settles", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const test = await harness({ handler: async (request) => {
      if (request.operation !== "session.list" || request.input?.search !== "Alpha") return "default" as const
      await gate
      return { ok: true as const, value: { data: [{ id: "ses_a", title: "Alpha session", agent: "god", model: { providerID: "openai", id: "gpt-5" }, time: { created: 1, updated: 2 } }] } }
    } })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().sessions.length === 2)
      const first = test.store.state().sessions.find((session) => session.id === "ses_a")
      test.store.searchSessions("Alpha")
      expect(test.store.state().sessionListStatus).toBe("loading")
      expect(test.store.state().sessionRowsStale).toBe(true)
      expect(test.store.state().sessions).toHaveLength(2)
      await test.runUntil(() => test.relay.requests.some((request) => request.operation === "session.list" && request.input?.search === "Alpha"))
      expect(test.store.state().sessions).toHaveLength(2)
      release()
      await test.runUntil(() => test.store.state().sessionListStatus === "ready" && test.store.state().sessions.length === 1)
      expect(test.store.state().sessionRowsStale).toBe(false)
      expect(test.store.state().sessions[0]).toBe(first)
    } finally { release(); await test.stop() }
  })

  test("selects a resident Session from another surface while a delayed search is pending", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const test = await harness({ handler: async (request) => {
      if (request.operation !== "session.list" || request.input?.search !== "Alpha") return "default" as const
      await gate
      return { ok: true as const, value: { data: [] } }
    } })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().sessions.length === 2)
      test.store.searchSessions("Alpha")
      await test.runUntil(() => test.relay.requests.some((request) => request.operation === "session.list" && request.input?.search === "Alpha"))
      await test.store.selectSession("ses_a")
      expect(test.store.state().activeSessionID).toBe("ses_a")
      expect(test.store.state().sessionQuery).toBe("")
      expect(test.store.state().sessionRowsStale).toBe(false)
    } finally { release(); await test.stop() }
  })

  test("status-driven first-page refresh of an unchanged query never marks resident rows stale", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    let workspaceReads = 0
    const test = await harness({ handler: async (request) => {
      if (request.operation !== "session.list" || request.input?.workspace === undefined) return "default" as const
      workspaceReads += 1
      if (workspaceReads > 1) await gate
      return "default" as const
    } })
    try {
      await test.store.load()
      await test.runUntil(() => workspaceReads === 1 && test.store.state().sessions.length === 2 && test.store.state().sessionStatus !== undefined)
      expect(test.store.state().sessionRowsStale).toBe(false)
      test.relay.pushStatus(["ses_unlisted"], [])
      await test.runUntil(() => workspaceReads >= 2)
      expect(test.store.state().sessionListStatus).toBe("loading")
      expect(test.store.state().sessionRowsStale).toBe(false)
      expect(test.store.state().sessions).toHaveLength(2)
      release()
      await test.runUntil(() => test.store.state().sessionListStatus === "ready")
      expect(test.store.state().sessionRowsStale).toBe(false)
    } finally { release(); await test.stop() }
  })

  test("reads complete compaction totals only for a selected Session with a compaction row", async () => {
    const metrics = { excludedMessages: 4, excludedParts: 0, inputTokens: 1_000, retainedTokens: 400 }
    const test = await harness({
      messages: { ses_a: [
        { id: "msg_before", type: "user", text: "Work", time: { created: 1 } },
        { id: "msg_compact", type: "compaction", jobID: "cmp_latest", trigger: "manual", status: "completed", revision: 1, boundary: { messageID: "msg_before", seq: 1 }, metrics, time: { created: 2 } },
      ] },
      handler: (request) => request.operation === "session.compaction.list"
        ? { ok: true, value: { data: [
          { jobID: "cmp_old", trigger: "auto", status: "completed", metrics: { ...metrics, inputTokens: 500, retainedTokens: 200 }, created: 0 },
          { jobID: "cmp_latest", trigger: "manual", status: "completed", metrics, created: 2 },
        ], truncated: false, completedBefore: 0, completedCount: 2, totalSavedTokens: 900 } }
        : "default",
    })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().sessions.some((session) => session.id === "ses_b"))
      await test.store.selectSession("ses_b")
      expect(test.relay.requests.filter((request) => request.operation === "session.compaction.list")).toHaveLength(0)
      await test.store.selectSession("ses_a")
      await test.runUntil(() => test.store.state().view?.compactionHistory?.totalSavedTokens === 900)
      expect(test.store.state().view?.compactionHistory?.completedCount).toBe(2)
      expect(test.relay.requests.filter((request) => request.operation === "session.compaction.list").map((request) => request.sessionID)).toEqual(["ses_a"])
    } finally { await test.stop() }
  })

  test("shows a live compaction and falls back silently when an older connector cannot list history", async () => {
    const test = await harness({ handler: (request) => request.operation === "session.compaction.list"
      ? { ok: false, code: "unknown_operation", message: "Update device" } : "default" })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().sessions.some((session) => session.id === "ses_a"))
      await test.store.selectSession("ses_a")
      expect(test.relay.requests.filter((request) => request.operation === "session.compaction.list")).toHaveLength(0)
      test.relay.pushEvent("ses_a", { type: "session.compaction.started", data: { sessionID: "ses_a", jobID: "cmp_live" }, created: 10 })
      await test.runUntil(() => test.store.state().view?.messages.some((message) => message.kind === "compaction" && message.status === "running") ?? false)
      await test.runUntil(() => test.relay.requests.some((request) => request.operation === "session.compaction.list"))
      expect(test.store.state().view?.compactionHistory).toBeUndefined()
      expect(test.store.state().view?.messages.find((message) => message.kind === "compaction")).toMatchObject({ jobID: "cmp_live", status: "running" })
      expect(test.store.state().notice).toBeUndefined()
    } finally { await test.stop() }
  })

  test("updates a loaded compaction total once from a live completion without another history read", async () => {
    const metrics = { excludedMessages: 4, excludedParts: 0, inputTokens: 1_000, retainedTokens: 400 }
    const test = await harness({ messages: { ses_a: [{ id: "msg_compact", type: "compaction", jobID: "cmp_live", trigger: "auto", status: "running", time: { created: 2 } }] },
      handler: (request) => request.operation === "session.compaction.list" ? { ok: true, value: { data: [{ jobID: "cmp_live", trigger: "auto", status: "running", created: 2 }], truncated: false, completedBefore: 0, completedCount: 0, totalSavedTokens: 0 } } : "default" })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().sessions.some((session) => session.id === "ses_a"))
      await test.store.selectSession("ses_a")
      await test.runUntil(() => test.store.state().view?.compactionHistory?.data.length === 1)
      for (let index = 0; index < 2; index++) test.relay.pushEvent("ses_a", { type: "session.compaction.ended", data: { sessionID: "ses_a", jobID: "cmp_live", metrics, boundary: { messageID: "msg_before", seq: 1 } }, created: 3 })
      await test.runUntil(() => test.store.state().view?.compactionHistory?.completedCount === 1)
      expect(test.store.state().view?.compactionHistory?.totalSavedTokens).toBe(600)
      expect(test.relay.requests.filter((request) => request.operation === "session.compaction.list")).toHaveLength(1)
    } finally { await test.stop() }
  })

  test("does not publish a compaction history after selecting another Session", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const test = await harness({ messages: { ses_a: [{ id: "msg_compact", type: "compaction", jobID: "cmp_old", trigger: "manual", status: "running", time: { created: 2 } }] },
      handler: async (request) => {
        if (request.operation !== "session.compaction.list") return "default" as const
        await gate
        return { ok: true as const, value: { data: [{ jobID: "cmp_old", trigger: "manual", status: "running", created: 2 }], truncated: false, completedBefore: 0, completedCount: 0, totalSavedTokens: 0 } }
      } })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().sessions.some((session) => session.id === "ses_a"))
      await test.store.selectSession("ses_a")
      await test.runUntil(() => test.relay.requests.some((request) => request.operation === "session.compaction.list"))
      await test.store.selectSession("ses_b")
      release()
      await test.flush()
      expect(test.store.state().view?.id).toBe("ses_b")
      expect(test.store.state().view?.compactionHistory).toBeUndefined()
    } finally { release(); await test.stop() }
  })

  test("parses explicit workspace identity from the backend Session Location", () => {
    expect(readSessionInfo({ id: "ses_a", projectID: "prj_a", title: "A", time: { updated: 2 }, location: { directory: "/work", workspaceID: "wsp_explicit" } }))
      .toMatchObject({ id: "ses_a", projectID: "prj_a", directory: "/work", workspaceID: "wsp_explicit" })
  })

  test("filters the sidebar to matching rows and resets search and status when a Session opens", async () => {
    const test = await harness({ paceLongTimers: true, handler: (request) => {
      if (request.operation === "workspace.list") return { ok: true, value: { data: [
        { id: "wsp_work", projectID: "prj_work", directory: "/work" },
        { id: "wsp_other", projectID: "prj_other", directory: "/other" },
      ] } }
      if (request.operation === "session.get" && request.sessionID === "ses_b") return { ok: true, value: { data: {
        id: "ses_b", title: "Beta session", projectID: "prj_other", location: { directory: "/other" }, time: { created: 1, updated: 2 },
      } } }
      if (request.operation === "session.list") return { ok: true, value: { data: request.input?.search || request.input?.status === "idle" ? [] : [
        request.input?.workspace === "wsp_other"
          ? { id: "ses_b", title: "Beta session", projectID: "prj_other", location: { directory: "/other" }, time: { created: 1, updated: 2 } }
          : { id: "ses_a", title: "Alpha session", projectID: "prj_work", location: { directory: "/work" }, time: { created: 1, updated: 2 } },
      ] } }
      return "default"
    } })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().sessions.some((session) => session.id === "ses_a"))
      await test.store.selectSession("ses_a")
      test.store.searchSessions("no match")
      await test.runUntil(() => test.store.state().sessionListStatus === "ready" && test.store.state().sessionQuery === "no match")
      expect(test.store.state().sessions).toEqual([])
      expect(test.store.state().activeSessionID).toBe("ses_a")
      test.store.searchSessions("", "idle")
      await test.runUntil(() => test.store.state().sessionListStatus === "ready" && test.store.state().sessionFilter === "idle")
      expect(test.store.state().sessions).toEqual([])
      await test.store.selectSession("ses_a")
      await test.runUntil(() => test.store.state().sessionListStatus === "ready" && test.store.state().sessions.some((session) => session.id === "ses_a"))
      expect(test.store.state().sessionQuery).toBe("")
      expect(test.store.state().sessionFilter).toBe("all")
      expect(test.store.state().sessions.map((session) => session.id)).toEqual(["ses_a"])
      test.store.searchSessions("no match", "idle")
      await test.runUntil(() => test.store.state().sessionListStatus === "ready" && test.store.state().sessionQuery === "no match", 700)
      void test.store.selectSession("ses_b")
      await test.runUntil(() => test.store.state().selectedWorkspaceID === "wsp_other" && test.store.state().sessionListStatus === "ready", 500)
      expect(test.store.state().sessionQuery).toBe("")
      expect(test.store.state().sessionFilter).toBe("all")
      expect(test.store.state().sessions.map((session) => session.id)).toEqual(["ses_b"])
    } finally { await test.stop() }
  }, 15_000)
  test("loads the owner, connects the only device, and lists advertised sessions", async () => {
    const test = await harness()
    try {
      await test.store.load()
      expect(test.store.state().owner?.id).toBe("user_1")
      expect(test.store.state().devices.map((device) => device.id)).toEqual(["dev_1"])
      await waitFor(() => test.store.state().connection.kind === "connected")
      await waitFor(() => test.store.state().sessions.length > 0)
      expect(test.store.state().advertised).toEqual(["ses_a", "ses_b"])
      const sessions = test.store.state().sessions
      expect(sessions.map((session) => session.id)).toEqual(["ses_a", "ses_b"])
      expect(sessions[0]).toMatchObject({
        title: "Alpha session",
        agent: "god",
        model: { id: "gpt-5", providerID: "openai" },
        modelLabel: "openai/gpt-5",
      })
    } finally {
      await test.stop()
    }
  })

  test("an authoritative status read stops an already selected Session's stale elapsed clock", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const test = await harness({ handler: async (request) => {
      if (request.operation === "session.status") { await gate; return { ok: true, value: { running: [], attention: [] } } }
      return "default" as const
    } })
    try {
      await test.store.load()
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.status"))
      await test.store.selectSession("ses_a")
      test.relay.pushEvent("ses_a", { type: "session.execution.started", data: { sessionID: "ses_a" } })
      await test.flush()
      expect(test.store.state().view).toMatchObject({ status: "running", executionStarted: 1_000 })
      release()
      await waitFor(() => test.store.state().sessionStatus !== undefined)
      expect(test.store.state().view?.status).toBe("idle")
      expect(test.store.state().view?.executionStarted).toBeUndefined()
      expect(sessionStatusLabel(test.store.state().view!, 2_000)).toBe("ready")
    } finally { release(); await test.stop() }
  })

  test("live status frames end an idle Session's timer without fabricating a new execution", async () => {
    const test = await harness()
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessionStatus !== undefined)
      await test.store.selectSession("ses_a")
      test.relay.pushEvent("ses_a", { type: "session.execution.started", data: { sessionID: "ses_a" } })
      await test.flush()
      expect(test.store.state().view?.status).toBe("running")
      test.relay.pushStatus([], [])
      await waitFor(() => test.store.state().view?.status === "idle")
      expect(test.store.state().view?.executionStarted).toBeUndefined()
      test.relay.pushStatus(["ses_a"], [])
      await waitFor(() => test.store.state().sessionStatus?.running.has("ses_a") === true)
      expect(test.store.state().view?.status).toBe("running")
      expect(test.store.state().view?.executionStarted).toBeUndefined()
      test.relay.pushEvent("ses_a", { type: "session.execution.failed", data: { sessionID: "ses_a", error: { code: "provider_error", message: "Provider failed" } } })
      await test.flush()
      test.relay.pushStatus([], [])
      await waitFor(() => test.store.state().sessionStatus?.running.size === 0)
      expect(test.store.state().view?.status).toBe("failed")
      expect(test.store.state().view?.executionStarted).toBeUndefined()
    } finally { await test.stop() }
  })

  test("snapshot publication cannot revive a stale running timer against an idle owner status", async () => {
    const test = await harness()
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessionStatus !== undefined)
      await test.store.selectSession("ses_a")
      test.relay.pushEvent("ses_a", { type: "session.execution.started", data: { sessionID: "ses_a" } })
      await test.flush()
      expect(test.store.state().view).toMatchObject({ status: "running", executionStarted: 1_000 })
      await test.store.reloadMessages()
      expect(test.store.state().view?.status).toBe("idle")
      expect(test.store.state().view?.executionStarted).toBeUndefined()
    } finally { await test.stop() }
  })

  test("reconciles a missed terminal event after reconnect and starts a fresh clock on the next execution", async () => {
    let running: readonly string[] = ["ses_a"]
    let watermark = 1
    let now = 1_000
    const test = await harness({ now: () => now, handler: (request) => {
      if (request.operation === "session.status") return { ok: true, value: { running, attention: [] } }
      if (request.operation === "session.snapshot") return { ok: true, value: {
        sourceEpoch: "epoch_1", session: { id: request.sessionID }, messages: [], watermark: { type: "log.synced", aggregateID: request.sessionID, seq: watermark },
      } }
      return "default"
    } })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessionStatus !== undefined)
      await test.store.selectSession("ses_a")
      test.relay.pushEvent("ses_a", { type: "session.execution.started", durable: { aggregateID: "ses_a", seq: 2, version: 1 }, data: { sessionID: "ses_a" } })
      await test.flush()
      expect(test.store.state().view).toMatchObject({ status: "running", executionStarted: 1_000 })
      running = []
      watermark = 3
      now = 11_000
      test.relay.dropConnections(1006, "")
      await test.runUntil(() => test.store.state().transport.kind === "open" && test.store.state().view?.watermark === 3 &&
        test.store.state().sessionStatus?.running.size === 0)
      expect(test.store.state().view?.status).toBe("idle")
      expect(test.store.state().view?.executionStarted).toBeUndefined()
      expect(sessionStatusLabel(test.store.state().view!, now)).toBe("ready")
      test.relay.pushEvent("ses_a", { type: "session.execution.started", durable: { aggregateID: "ses_a", seq: 4, version: 1 }, data: { sessionID: "ses_a" } })
      await test.flush()
      expect(test.store.state().view?.executionStarted).toBe(11_000)
      expect(sessionStatusLabel(test.store.state().view!, 12_000)).toBe("cooking · 1.0s")
    } finally { await test.stop() }
  })

  test("keeps a child execution running while its recorded root family is in the status set", async () => {
    const child = { id: "ses_child", parentID: "ses_a", title: "Child task", projectID: "prj_default", location: { directory: "/work" }, time: { created: 1, updated: 2 } }
    const test = await harness({ handler: (request) => {
      if (request.operation === "session.status") return { ok: true, value: { running: ["ses_a"], attention: [] } }
      if (request.operation === "session.get" && request.sessionID === "ses_child") return { ok: true, value: { data: child } }
      if (request.operation === "session.snapshot" && request.sessionID === "ses_child") return { ok: true, value: {
        sourceEpoch: "epoch_1", session: child, messages: [], watermark: { type: "log.synced", aggregateID: "ses_child", seq: 0 },
      } }
      return "default"
    } })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessionStatus !== undefined)
      await test.store.selectSession("ses_child")
      test.relay.pushEvent("ses_child", { type: "session.execution.started", data: { sessionID: "ses_child" } })
      await test.flush()
      test.relay.pushStatus(["ses_a"], [])
      await test.flush()
      expect(test.store.state().selectedSessionInfo?.parentID).toBe("ses_a")
      expect(test.store.state().view).toMatchObject({ id: "ses_child", status: "running", executionStarted: 1_000 })
      await test.store.reloadMessages()
      expect(test.store.state().view).toMatchObject({ id: "ses_child", status: "running", executionStarted: 1_000 })
    } finally { await test.stop() }
  })

  test("keeps a nested child's timer when its direct parent is not a known root", async () => {
    const nested = { id: "ses_nested", parentID: "ses_middle", title: "Nested task", projectID: "prj_default", location: { directory: "/work" }, time: { created: 1, updated: 2 } }
    const test = await harness({ handler: (request) => {
      if (request.operation === "session.status") return { ok: true, value: { running: ["ses_a"], attention: [] } }
      if (request.operation === "session.get" && request.sessionID === "ses_nested") return { ok: true, value: { data: nested } }
      if (request.operation === "session.snapshot" && request.sessionID === "ses_nested") return { ok: true, value: {
        sourceEpoch: "epoch_1", session: nested, messages: [], watermark: { type: "log.synced", aggregateID: "ses_nested", seq: 0 },
      } }
      return "default"
    } })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessionStatus !== undefined && test.store.state().sessions.some((row) => row.id === "ses_a"))
      await test.store.selectSession("ses_nested")
      expect(test.store.state().selectedSessionInfo?.parentID).toBe("ses_middle")
      expect(test.store.state().sessions.some((row) => row.id === "ses_middle")).toBe(false)
      test.relay.pushEvent("ses_nested", { type: "session.execution.started", data: { sessionID: "ses_nested" } })
      await test.flush()
      test.relay.pushStatus(["ses_a"], [])
      await test.flush()
      expect(test.store.state().view).toMatchObject({ id: "ses_nested", status: "running", executionStarted: 1_000 })
      await test.store.reloadMessages()
      expect(test.store.state().view).toMatchObject({ id: "ses_nested", status: "running", executionStarted: 1_000 })
    } finally { await test.stop() }
  })

  test("reconciles a direct child of a loaded root when that family is idle", async () => {
    const child = { id: "ses_child", parentID: "ses_a", title: "Child task", projectID: "prj_default", location: { directory: "/work" }, time: { created: 1, updated: 2 } }
    const test = await harness({ handler: (request) => {
      if (request.operation === "session.get" && request.sessionID === "ses_child") return { ok: true, value: { data: child } }
      if (request.operation === "session.snapshot" && request.sessionID === "ses_child") return { ok: true, value: {
        sourceEpoch: "epoch_1", session: child, messages: [], watermark: { type: "log.synced", aggregateID: "ses_child", seq: 0 },
      } }
      return "default"
    } })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessionStatus !== undefined && test.store.state().sessions.some((row) => row.id === "ses_a"))
      await test.store.selectSession("ses_child")
      test.relay.pushEvent("ses_child", { type: "session.execution.started", data: { sessionID: "ses_child" } })
      await test.flush()
      test.relay.pushStatus([], [])
      await test.flush()
      expect(test.store.state().view).toMatchObject({ id: "ses_child", status: "idle", executionStarted: undefined })
      test.relay.pushEvent("ses_child", { type: "session.execution.started", data: { sessionID: "ses_child" } })
      await test.flush()
      await test.store.reloadMessages()
      expect(test.store.state().view).toMatchObject({ id: "ses_child", status: "idle", executionStarted: undefined })
    } finally { await test.stop() }
  })

  test("reconciles a child whose root is known only to the running-and-recent carousel", async () => {
    const root = { id: "ses_carousel", title: "Carousel root", projectID: "prj_default", location: { directory: "/work" }, time: { created: 1, updated: 2 } }
    const child = { id: "ses_child", parentID: root.id, title: "Child task", projectID: "prj_default", location: { directory: "/work" }, time: { created: 1, updated: 2 } }
    const test = await harness({ handler: (request) => {
      if (request.operation === "session.list") return { ok: true, value: { data: request.input?.workspace === undefined && request.input?.status === "idle" ? [root] : [] } }
      if (request.operation === "session.get" && request.sessionID === child.id) return { ok: true, value: { data: child } }
      if (request.operation === "session.snapshot" && request.sessionID === child.id) return { ok: true, value: {
        sourceEpoch: "epoch_1", session: child, messages: [], watermark: { type: "log.synced", aggregateID: child.id, seq: 0 },
      } }
      return "default"
    } })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().carouselSessions?.some((row) => row.id === root.id) === true)
      expect(test.store.state().sessions.some((row) => row.id === root.id)).toBe(false)
      await test.store.selectSession(child.id)
      test.relay.pushEvent(child.id, { type: "session.execution.started", data: { sessionID: child.id } })
      await test.flush()
      test.relay.pushStatus([], [])
      await test.flush()
      expect(test.store.state().view).toMatchObject({ id: child.id, status: "idle", executionStarted: undefined })
    } finally { await test.stop() }
  })

  test("canonical root running has no invented execution timing and never overwrites failure", async () => {
    const test = await harness()
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessionStatus !== undefined)
      await test.store.selectSession("ses_a")
      test.relay.pushStatus(["ses_a"], [])
      await waitFor(() => test.store.state().sessionStatus?.running.has("ses_a") === true)
      expect(test.store.state().view?.status).toBe("running")
      expect(test.store.state().view?.executionStarted).toBeUndefined()
      test.relay.pushEvent("ses_a", { type: "session.execution.failed", data: { sessionID: "ses_a", error: { code: "provider_error", message: "Provider failed" } } })
      await test.flush()
      test.relay.pushStatus(["ses_a"], [])
      await test.flush()
      expect(test.store.state().view?.status).toBe("failed")
      expect(test.store.state().view?.lastError).toMatchObject({ code: "provider_error", message: "Provider failed" })
      test.relay.pushEvent("ses_a", { type: "session.execution.interrupted", data: { sessionID: "ses_a" } })
      await test.flush()
      test.relay.pushStatus([], [])
      await test.flush()
      expect(test.store.state().view?.status).toBe("interrupted")
    } finally { await test.stop() }
  })

  test("publishes a bounded first workspace page and loads older Sessions only on demand", async () => {
    const count = 1_205
    const relay = await startRelayDouble({
      handler: (request) => {
        if (request.operation === "workspace.list") return { ok: true, value: { data: [
          { id: "wsp_api", projectID: "prj_api", directory: "/work/api" },
          { id: "wsp_web", projectID: "prj_web", directory: "/work/web" },
        ] } }
        if (request.operation !== "session.list") return "default"
        const offset = typeof request.input?.cursor === "string" ? Number(request.input.cursor) : 0
        const limit = typeof request.input?.limit === "number" ? request.input.limit : 200
        const data = Array.from({ length: Math.min(limit, count / 2 - offset) }, (_, index) => {
          const value = (offset + index) * 2 + (request.input?.workspace === "wsp_web" ? 1 : 0)
          return {
            id: `ses_${value}`,
            title: `Session ${value}`,
            projectID: value % 2 === 0 ? "prj_api" : "prj_web",
            location: { directory: value % 2 === 0 ? "/work/api" : "/work/web" },
            time: { created: value, updated: value },
          }
        })
        const next = offset + data.length < count / 2 ? String(offset + data.length) : undefined
        return { ok: true, value: { data, cursor: { next } } }
      },
    })
    const store = createRemoteStore({
      http: createRemoteHttp({ baseURL: relay.httpURL }),
      createTransport: (deviceID, handlers) =>
        createRemoteTransport({ url: relay.wsURL(deviceID), handlers, resetDelayMs: 10 }),
    })
    try {
      await store.load()
      await waitFor(() => store.state().sessions.length === 25)
      expect(store.state().sessions[0]?.id).toBe("ses_48")
      expect(store.state().sessions.at(-1)?.id).toBe("ses_0")
      expect(relay.requests.filter((request) => request.operation === "session.list" && request.input?.workspace !== undefined)).toHaveLength(1)
      expect(relay.requests.find((request) => request.operation === "session.list" && request.input?.workspace !== undefined)?.input).toMatchObject({ order: "active", parentID: null, limit: 25 })
      await store.nextSessionsPage()
      expect(store.state().sessions[0]?.id).toBe("ses_98")
      expect(store.state().sessions).toHaveLength(50)
      store.selectWorkspace("wsp_web")
      await waitFor(() => store.state().sessions[0]?.id === "ses_49")
      expect(store.state().sessions.every((session) => session.projectID === "prj_web")).toBe(true)
    } finally {
      store.dispose()
      await relay.stop()
    }
  })

  test("refuses a repeated cursor instead of appending the same Session page indefinitely", async () => {
    const test = await harness({ handler: (request) => request.operation === "session.list"
      ? { ok: true, value: { data: [{ id: "ses_a", title: "Alpha", time: { created: 1, updated: 1 } }], cursor: { next: "same" } } }
      : "default" })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().sessionHasNext)
      await test.store.nextSessionsPage()
      expect(test.store.state().sessionListStatus).toBe("error")
      expect(test.store.state().sessions.map((session) => session.id)).toEqual(["ses_a"])
    } finally {
      await test.stop()
    }
  })

  test("create and delete invalidations supersede in-flight bounded Session pages", async () => {
    const oldPage = Promise.withResolvers<void>()
    let phase = "initial"
    let settledPages = 0
    const row = (id: string) => ({ id, title: id, time: { created: 1, updated: 1 } })
    const relay = await startRelayDouble({
      handler: async (request) => {
        if (request.operation !== "session.list" || request.input?.workspace === undefined) return "default"
        if (phase === "initial") {
          await oldPage.promise
          return { ok: true, value: { data: [row("ses_deleted")] } }
        }
        return { ok: true, value: { data: [row("ses_created"), row("ses_stable")] } }
      },
    })
    const store = createRemoteStore({
      http: createRemoteHttp({ baseURL: relay.httpURL }),
      createTransport: (deviceID, handlers) => {
        const transport = createRemoteTransport({ url: relay.wsURL(deviceID), handlers })
        return { ...transport, request: async (operation, input) => {
          const outcome = await transport.request(operation, input)
          if (operation === "session.list" && input?.input?.workspace !== undefined) settledPages++
          return outcome
        } }
      },
    })
    const published: string[][] = []
    const unsubscribe = store.subscribe(() => published.push(store.state().sessions.map((session) => session.id)))
    try {
      await store.load()
      await waitFor(() => relay.requests.filter((request) => request.operation === "session.list" && request.input?.workspace !== undefined).length === 1)
      phase = "created"
      relay.pushSessions([])
      phase = "deleted"
      relay.pushSessions([])
      oldPage.resolve()
      await waitFor(() => settledPages >= 2 && store.state().sessions.length === 2)
      await Bun.sleep(20)
      expect(relay.requests.filter((request) => request.operation === "session.list" && request.input?.workspace !== undefined)).toHaveLength(2)
      expect(store.state().sessions.map((session) => session.id)).toEqual(["ses_created", "ses_stable"])
      expect(published.filter((ids) => ids.length > 0).every((ids) => ids.join(",") === "ses_created,ses_stable")).toBe(true)
    } finally {
      oldPage.resolve()
      unsubscribe()
      store.dispose()
      await relay.stop()
    }
  })

  test("reports an authenticated device offline when its open relay rejects the session list as agent unavailable", async () => {
    const test = await harness({
      handler: (request) =>
        request.operation === "session.list"
          ? { ok: false, code: "agent_unavailable", message: "No local agent is connected" }
          : "default",
    })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().connection.kind === "offline")

      expect(test.store.state().connection).toEqual({ kind: "offline", deviceName: "dev_1" })
      expect(test.store.state().owner?.id).toBe("user_1")
      expect(test.store.state().devices.map((device) => device.id)).toEqual(["dev_1"])
      expect(test.store.state().transport.kind).toBe("open")
      expect(test.store.state().sessions).toEqual([])
    } finally {
      await test.stop()
    }
  })

  test("does not call a browser relay drop a machine disconnect and retains its latest close reason", async () => {
    const test = await harness()
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().sessions.length === 2)
      test.relay.dropConnections(1012, "Relay restarted")
      await test.runUntil(() => test.store.state().transport.kind === "open" && test.relay.connections >= 2)
      expect(test.store.state().notifications.filter((entry) => entry.category === "machine-offline")).toEqual([])
      expect(test.store.state().lastRelayDrop).toEqual({ code: 1012, reason: "Relay restarted" })
      expect(test.store.state().connection.kind).toBe("connected")
      test.relay.dropConnections(1001, "Phone relay link slept")
      await test.runUntil(() => test.store.state().transport.kind === "open" && test.relay.connections >= 3)
      expect(test.store.state().notifications.filter((entry) => entry.category === "machine-offline")).toEqual([])
      expect(test.store.state().lastRelayDrop).toEqual({ code: 1001, reason: "Phone relay link slept" })
      test.store.connect("dev_1")
      await test.runUntil(() => test.store.state().transport.kind === "open" && test.relay.connections >= 4)
      expect(test.store.state().lastRelayDrop).toEqual({ code: 1001, reason: "Phone relay link slept" })
      test.store.disconnect()
      expect(test.store.state().lastRelayDrop).toBeUndefined()
    } finally { await test.stop() }
  })

  test("a read that finds no agent shows the machine offline silently; each relay-confirmed outage alerts once", async () => {
    let agent = "present"
    const test = await harness({ handler: () =>
      agent === "gone" ? { ok: false, code: "agent_unavailable", message: "No local agent is connected" } : "default" })
    const notices = () => test.store.state().notifications.filter((entry) => entry.category === "machine-offline")
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().sessions.length === 2)
      agent = "gone"
      test.relay.pushSessions([])
      await test.runUntil(() => test.store.state().connection.kind === "offline")
      expect(notices()).toEqual([])
      test.relay.pushNotices({ type: "notice.offline", at: 5_000 })
      await test.runUntil(() => notices().length === 1)
      expect(notices()).toMatchObject([{ id: "offline_dev_1_5000", at: 5_000, synced: false, live: true }])
      test.relay.pushNotices({ type: "notice.offline", at: 5_000 })
      test.relay.pushSessions([])
      await test.runUntil(() => test.store.state().sessionListStatus === "error")
      expect(notices().map((entry) => entry.id)).toEqual(["offline_dev_1_5000"])
      test.relay.dropConnections(1012, "Relay restarted")
      await test.runUntil(() => test.relay.connections >= 2 && test.store.state().connection.kind === "offline")
      expect(notices().map((entry) => entry.id)).toEqual(["offline_dev_1_5000"])
      agent = "present"
      test.relay.pushSessions([])
      await test.runUntil(() => test.store.state().connection.kind === "connected")
      agent = "gone"
      test.relay.pushSessions([])
      await test.runUntil(() => test.store.state().connection.kind === "offline")
      expect(notices()).toHaveLength(1)
      test.relay.pushNotices({ type: "notice.offline", at: 9_000 })
      await test.runUntil(() => notices().length === 2)
      expect(notices().map((entry) => entry.id)).toEqual(["offline_dev_1_9000", "offline_dev_1_5000"])
    } finally { await test.stop() }
  })

  test("keeps one machine-offline notice when a later account refresh confirms the same outage", async () => {
    let agent = "present"
    const test = await harness({ handler: () =>
      agent === "gone" ? { ok: false, code: "agent_unavailable", message: "No local agent is connected" } : "default" })
    const notices = () => test.store.state().notifications.filter((entry) => entry.category === "machine-offline")
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().sessions.length === 2)
      agent = "gone"
      test.relay.pushSessions([])
      await test.runUntil(() => test.store.state().connection.kind === "offline")
      test.relay.pushNotices({ type: "notice.offline", at: 5_000 })
      await test.runUntil(() => notices().length === 1)
      const id = notices()[0]!.id
      test.relay.setMe({ user: { id: "user_1" }, session: { expiresAt: 4_102_444_800_000 },
        devices: [{ id: "dev_1", name: "Studio Mac", createdAt: 1, status: "active", online: false }] })
      await test.store.load()
      expect(notices().map((entry) => entry.id)).toEqual([id])
      await test.store.readNotification(id)
      expect(notices()).toEqual([])
    } finally { await test.stop() }
  })

  test("restores an offline device after a later advertised session list succeeds", async () => {
    let lists = 0
    const test = await harness({
      handler: (request) => {
        if (request.operation !== "session.list" || request.input?.workspace === undefined) return "default"
        lists += 1
        return lists === 1
          ? { ok: false, code: "agent_unavailable", message: "No local agent is connected" }
          : "default"
      },
    })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().connection.kind === "offline")

      test.relay.pushSessions(["ses_a", "ses_b"])
      await test.runUntil(() => test.store.state().sessions.length === 2)

      expect(test.store.state().connection).toEqual({ kind: "connected", deviceName: "dev_1" })
      expect(test.store.state().owner?.id).toBe("user_1")
    } finally {
      await test.stop()
    }
  })

  test("reports the device offline when its relay has no local agent for any request", async () => {
    const test = await harness({ handler: () => ({ ok: false, code: "agent_unavailable", message: "No local agent is connected" }) })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().sessionListStatus === "error")

      expect(test.store.state().connection).toEqual({ kind: "offline", deviceName: "dev_1" })
      expect(test.store.state().transport.kind).toBe("open")
      expect(test.store.state().sessions).toEqual([])
    } finally {
      await test.stop()
    }
  })

  test("keeps the last list while the agent is gone and reconnects when it returns without Sessions", async () => {
    let agent: "present" | "gone" | "empty" = "present"
    const test = await harness({
      handler: (request) => {
        if (agent === "gone") return { ok: false, code: "agent_unavailable", message: "No local agent is connected" }
        if (agent === "empty" && (request.operation === "workspace.list" || request.operation === "session.list")) return { ok: true, value: { data: [] } }
        return "default"
      },
    })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().sessions.length === 2)

      agent = "gone"
      test.relay.pushSessions([])
      await test.runUntil(() => test.store.state().connection.kind === "offline")
      expect(test.store.state().connection).toEqual({ kind: "offline", deviceName: "dev_1" })
      expect(test.store.state().sessions.map((session) => session.id)).toEqual(["ses_a", "ses_b"])

      agent = "empty"
      test.relay.pushSessions([])
      await test.runUntil(() => test.store.state().connection.kind === "connected")

      expect(test.store.state().connection).toEqual({ kind: "connected", deviceName: "dev_1" })
      expect(test.store.state().sessionListStatus).toBe("ready")
      expect(test.store.state().sessionGroups).toEqual([])
      expect(test.store.state().sessions).toEqual([])
    } finally {
      await test.stop()
    }
  })

  test("keeps the last session list when a connected device's agent becomes unavailable", async () => {
    let lists = 0
    const test = await harness({
      handler: (request) => {
        if (request.operation !== "session.list" || request.input?.workspace === undefined) return "default"
        lists += 1
        return lists === 1 ? "default" : { ok: false, code: "agent_unavailable", message: "No local agent is connected" }
      },
    })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().sessions.length === 2)

      test.relay.pushSessions(["ses_a", "ses_b"])
      await test.runUntil(() => test.store.state().connection.kind === "offline")

      expect(test.store.state().sessions.map((session) => session.id)).toEqual(["ses_a", "ses_b"])
    } finally {
      await test.stop()
    }
  })

  test("keeps the selected device's last session list when an account refresh reports it offline", async () => {
    const test = await harness()
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().sessions.length === 2)

      test.relay.setMe({
        user: { id: "user_1" },
        session: { expiresAt: 4_102_444_800_000 },
        devices: [{ id: "dev_1", name: "Studio Mac", createdAt: 1, status: "active", online: false }],
      })
      await test.store.load()

      expect(test.store.state().connection).toEqual({ kind: "offline", deviceName: "Studio Mac" })
      expect(test.store.state().activeDeviceID).toBe("dev_1")
      expect(test.store.state().sessions.map((session) => session.id)).toEqual(["ses_a", "ses_b"])
      expect(test.store.state().notifications.filter((entry) => entry.category === "machine-offline")).toEqual([])
      await test.store.load()
      expect(test.store.state().notifications.filter((entry) => entry.category === "machine-offline")).toEqual([])
      test.store.searchSessions("no match")
      expect(test.store.state().sessions.map((session) => session.id)).toEqual(["ses_a", "ses_b"])
    } finally {
      await test.stop()
    }
  })

  test("reports a failed session list instead of presenting a connected empty backend", async () => {
    let lists = 0
    const test = await harness({
      handler: (request) => {
        if (request.operation !== "session.list" || request.input?.workspace === undefined) return "default"
        lists += 1
        return lists === 1 ? { ok: false, code: "internal_error", message: "the agent rejected this read" } : "default"
      },
    })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().transport.kind === "open")
      await Bun.sleep(30)

      expect(test.store.state().connection).toEqual({
        kind: "error",
        message: "Session list: the agent rejected this read",
      })
      expect(test.store.state().sessions).toEqual([])

      test.store.connect("dev_1")
      await test.runUntil(() => test.store.state().sessions.length === 2)
      expect(test.store.state().connection).toEqual({ kind: "connected", deviceName: "dev_1" })
    } finally {
      await test.stop()
    }
  })

  test("keeps a generic closed relay distinct from an unavailable local agent", async () => {
    const test = await fakeConnectionHarness()
    try {
      test.store.connect("dev_1")
      test.sockets[0]?.publish({ kind: "closed", code: 1006, reason: "The relay connection closed unexpectedly", retryable: true })

      expect(test.store.state().connection).toEqual({ kind: "error", message: "The relay connection closed unexpectedly" })
    } finally {
      await test.stop()
    }
  })

  test("keeps the current device connected when a replaced list carried agent unavailable", async () => {
    let lists = 0
    const test = await harness({
      handler: async (request) => {
        if (request.operation === "session.list" && request.input?.workspace !== undefined) {
          lists += 1
          return lists === 1
            ? { ok: false, code: "agent_unavailable", message: "No local agent is connected" }
            : "default"
        }
        return "default" as const
      },
    })
    try {
      await test.store.load()
      await test.runUntil(() => lists === 1 && test.store.state().connection.kind === "offline")
      test.store.connect("dev_2")
      await test.runUntil(() => test.store.state().activeDeviceID === "dev_2" && test.store.state().sessions.length === 2)

      expect(test.store.state().connection).toEqual({ kind: "connected", deviceName: "dev_2" })
      expect(test.store.state().owner?.id).toBe("user_1")
    } finally {
      await test.stop()
    }
  })

  test("reports a signed-out browser session without fabricating devices", async () => {
    const relay = await startRelayDouble({
      meStatus: 401,
      me: { error: { code: "unauthorized", message: "Sign in required" } },
    })
    const store = createRemoteStore({
      http: createRemoteHttp({ baseURL: relay.httpURL }),
      createTransport: (deviceID, handlers) => createRemoteTransport({ url: relay.wsURL(deviceID), handlers }),
    })
    try {
      await store.load()
      expect(store.state().connection).toEqual({ kind: "signed-out" })
      expect(store.state().devices).toHaveLength(0)
      expect(store.state().sessions).toHaveLength(0)
      expect(store.state().mutations).toHaveLength(0)
    } finally {
      store.dispose()
      await relay.stop()
    }
  })

  test("keeps a signed-in account with no enrolled device out of the signed-out state", async () => {
    const relay = await startRelayDouble({
      me: { user: { id: "user_1" }, session: { expiresAt: 4_102_444_800_000 }, devices: [] },
    })
    const store = createRemoteStore({
      http: createRemoteHttp({ baseURL: relay.httpURL }),
      createTransport: (deviceID, handlers) => createRemoteTransport({ url: relay.wsURL(deviceID), handlers }),
    })
    try {
      await store.load()
      expect(store.state().owner?.id).toBe("user_1")
      expect(store.state().devices).toHaveLength(0)
      expect(store.state().connection).toEqual({ kind: "no-device-enrolled" })
      expect(store.state().notice).toBeUndefined()
      // No relay connection is opened without a device, so nothing is fabricated.
      expect(relay.connections).toBe(0)
    } finally {
      store.dispose()
      await relay.stop()
    }
  })

  test("asks for a machine instead of signing out when the account has several devices", async () => {
    const relay = await startRelayDouble({
      me: {
        user: { id: "user_1" },
        session: { expiresAt: 4_102_444_800_000 },
        devices: [
          { id: "dev_1", name: "Studio Mac", createdAt: 1, status: "active", online: true },
          { id: "dev_2", name: "Laptop", createdAt: 2, status: "active", online: true },
        ],
      },
    })
    const store = createRemoteStore({
      http: createRemoteHttp({ baseURL: relay.httpURL }),
      createTransport: (deviceID, handlers) => createRemoteTransport({ url: relay.wsURL(deviceID), handlers }),
    })
    try {
      await store.load()
      expect(store.state().activeDeviceID).toBeUndefined()
      expect(store.state().connection).toEqual({ kind: "no-device-selected" })
      expect(relay.connections).toBe(0)
    } finally {
      store.dispose()
      await relay.stop()
    }
  })

  test("auto-connects the one active device while retaining revoked device history", async () => {
    const relay = await startRelayDouble({
      me: {
        user: { id: "user_1" },
        session: { expiresAt: 4_102_444_800_000 },
        devices: [
          { id: "dev_revoked", name: "Old laptop", createdAt: 1, status: "revoked", online: false },
          { id: "dev_active", name: "Studio Mac", createdAt: 2, status: "active", online: true },
        ],
      },
    })
    const store = createRemoteStore({
      http: createRemoteHttp({ baseURL: relay.httpURL }),
      createTransport: (deviceID, handlers) => createRemoteTransport({ url: relay.wsURL(deviceID), handlers }),
    })
    try {
      await store.load()
      await waitFor(() => store.state().connection.kind === "connected")
      expect(store.state().activeDeviceID).toBe("dev_active")
      expect(store.state().devices.map((device) => device.status)).toEqual(["revoked", "active"])
    } finally {
      store.dispose()
      await relay.stop()
    }
  })

  test("does not auto-connect a revoked device", async () => {
    const relay = await startRelayDouble({
      me: {
        user: { id: "user_1" },
        session: { expiresAt: 4_102_444_800_000 },
        devices: [{ id: "dev_revoked", name: "Old laptop", createdAt: 1, status: "revoked", online: false }],
      },
    })
    const store = createRemoteStore({
      http: createRemoteHttp({ baseURL: relay.httpURL }),
      createTransport: (deviceID, handlers) => createRemoteTransport({ url: relay.wsURL(deviceID), handlers }),
    })
    try {
      await store.load()
      expect(store.state().connection).toEqual({ kind: "no-device-enrolled" })
      expect(store.state().devices.map((device) => device.status)).toEqual(["revoked"])
      expect(relay.connections).toBe(0)
    } finally {
      store.dispose()
      await relay.stop()
    }
  })

  test("retains an offline active device without offering a relay connection", async () => {
    const relay = await startRelayDouble({
      me: {
        user: { id: "user_1" },
        session: { expiresAt: 4_102_444_800_000 },
        devices: [{ id: "dev_offline", name: "Sleeping Mac", createdAt: 1, status: "active", online: false }],
      },
    })
    const store = createRemoteStore({
      http: createRemoteHttp({ baseURL: relay.httpURL }),
      createTransport: (deviceID, handlers) => createRemoteTransport({ url: relay.wsURL(deviceID), handlers }),
    })
    try {
      await store.load()
      expect(store.state().devices).toHaveLength(1)
      expect(store.state().devices[0]).toMatchObject({ id: "dev_offline", online: false })
      expect(store.state().activeDeviceID).toBeUndefined()
      expect(relay.connections).toBe(0)
    } finally {
      store.dispose()
      await relay.stop()
    }
  })

  test("returns to a device-less state on disconnect while the account stays signed in", async () => {
    const test = await harness()
    try {
      await test.store.load()
      await waitFor(() => test.store.state().connection.kind === "connected")
      test.store.disconnect()
      expect(test.store.state().connection).toEqual({ kind: "no-device-selected" })
      expect(test.store.state().owner?.id).toBe("user_1")
      expect(test.store.state().activeDeviceID).toBeUndefined()
    } finally {
      await test.stop()
    }
  })

  test("signs the browser out on logout even though the account still owns a device", async () => {
    const test = await harness()
    try {
      await test.store.load()
      await waitFor(() => test.store.state().connection.kind === "connected")
      await test.store.logout()
      expect(test.store.state().connection).toEqual({ kind: "signed-out" })
      expect(test.store.state().owner).toBeUndefined()
      expect(test.store.state().devices).toHaveLength(0)
      expect(test.store.state().activeDeviceID).toBeUndefined()
    } finally {
      await test.stop()
    }
  })

  test("reports remote access as not configured when the deployment has no API", async () => {
    // A static deployment answers /api/me with the single-page fallback document.
    const relay = await startRelayDouble({ me: "<!doctype html><html><body>app shell</body></html>", meStatus: 200 })
    const store = createRemoteStore({
      http: createRemoteHttp({ baseURL: relay.httpURL }),
      createTransport: (deviceID, handlers) => createRemoteTransport({ url: relay.wsURL(deviceID), handlers }),
    })
    try {
      await store.load()
      expect(store.state().connection).toEqual({ kind: "unavailable", reason: "not-configured" })
      // The connection state already explains itself in the status strip and empty state.
      expect(store.state().notice).toBeUndefined()
      expect(store.state().devices).toHaveLength(0)
      expect(store.state().sessions).toHaveLength(0)
    } finally {
      store.dispose()
      await relay.stop()
    }
  })

  test("resumes a session with subscribe plus a canonical snapshot", async () => {
    const test = await harness({
      messages: {
        ses_a: [
          { id: "msg_1", type: "user", text: "Old prompt", time: { created: 1 } },
          { id: "msg_2", type: "assistant", agent: "god", content: [{ type: "text", text: "Old answer" }], time: { created: 2, completed: 3 } },
        ],
      },
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      const operations = test.relay.requests.map((request) => request.operation)
      expect(operations).toContain("session.subscribe")
      expect(operations).toContain("session.snapshot")
      expect(operations.indexOf("session.snapshot")).toBeGreaterThan(operations.indexOf("session.subscribe"))
      const view = test.store.state().view
      expect(view?.messages.map((message) => message.id)).toEqual(["msg_1", "msg_2"])
      expect(view?.title).toBe("Alpha session")
      expect(view?.watermark).toBe(0)
      expect(view?.sourceEpoch).toBe("epoch_1")
    } finally {
      await test.stop()
    }
  })

  test("unsubscribes the previous session when the selection moves on", async () => {
    const test = await harness()
    const unsubscribes = () => test.relay.requests.filter((request) => request.operation === "session.unsubscribe")
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      expect(unsubscribes()).toHaveLength(0)

      await test.store.selectSession("ses_b")
      await waitFor(() => unsubscribes().length === 1)
      expect(unsubscribes().map((request) => request.sessionID)).toEqual(["ses_a"])
      expect(test.store.state().activeSessionID).toBe("ses_b")
    } finally {
      await test.stop()
    }
  })

  test("ends the previous stream when the next session is not available", async () => {
    const test = await harness({
      handler: (request) =>
        request.operation === "session.subscribe" && request.sessionID === "ses_b"
          ? { ok: false, code: "session_not_allowed", message: "Session is not served by the connected agent" }
          : "default",
    })
    const unsubscribes = () => test.relay.requests.filter((request) => request.operation === "session.unsubscribe")
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")

      await test.store.selectSession("ses_b")
      await waitFor(() => unsubscribes().length === 1)
      expect(unsubscribes().map((request) => request.sessionID)).toEqual(["ses_a"])
      expect(test.store.state().notice).toBe("This session is not available from the connected device.")
      expect(test.store.state().activeSessionID).toBe("ses_b")
    } finally {
      await test.stop()
    }
  })

  test("a superseded selection releases its own stream and keeps the winner's", async () => {
    const gates = new Map<string, Promise<void>>()
    const releases = new Map<string, () => void>()
    const gateFor = (sessionID: string) => {
      const open = gates.get(sessionID)
      if (open !== undefined) return open
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      gates.set(sessionID, gate)
      releases.set(sessionID, release)
      return gate
    }
    const test = await harness({
      handler: async (request) => {
        if (request.operation === "session.subscribe") await gateFor(request.sessionID ?? "")
        return "default" as const
      },
    })
    const unsubscribes = () => test.relay.requests.filter((request) => request.operation === "session.unsubscribe")
    const release = (sessionID: string) => {
      const open = releases.get(sessionID)
      if (open === undefined) throw new Error(`no gated subscribe for ${sessionID}`)
      open()
    }
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)

      const first = test.store.selectSession("ses_a")
      await waitFor(() => releases.has("ses_a"))
      const second = test.store.selectSession("ses_b")
      await waitFor(() => releases.has("ses_b"))

      // The winner settles first, then the superseded selection resolves.
      release("ses_b")
      await second
      expect(test.store.state().activeSessionID).toBe("ses_b")

      release("ses_a")
      await first
      await waitFor(() => unsubscribes().length === 1)
      expect(unsubscribes().map((request) => request.sessionID)).toEqual(["ses_a"])
      expect(test.store.state().activeSessionID).toBe("ses_b")

      // The winner still owns its registration, so the next move releases it.
      await test.store.selectSession("ses_a")
      await waitFor(() => unsubscribes().length === 2)
      expect(unsubscribes().map((request) => request.sessionID)).toEqual(["ses_a", "ses_b"])
    } finally {
      await test.stop()
    }
  })

  test("keeps the selection's replay window when a reload settles during it", async () => {
    const gates = new Map<string, Promise<void>>()
    const releases = new Map<string, () => void>()
    const gateFor = (sessionID: string) => {
      const open = gates.get(sessionID)
      if (open !== undefined) return open
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      gates.set(sessionID, gate)
      releases.set(sessionID, release)
      return gate
    }
    let gateSnapshots = false
    const test = await harness({
      watermark: 10,
      messages: { ses_b: [{ id: "msg_1", type: "user", text: "before", time: { created: 1 } }] },
      handler: async (request) => {
        if (request.operation === "session.snapshot" && gateSnapshots) await gateFor(request.sessionID ?? "")
        return "default" as const
      },
    })
    const release = (sessionID: string) => {
      const open = releases.get(sessionID)
      if (open === undefined) throw new Error(`no gated snapshot for ${sessionID}`)
      open()
    }
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")

      gateSnapshots = true
      const reload = test.store.reloadMessages()
      await waitFor(() => releases.has("ses_a"))
      const selection = test.store.selectSession("ses_b")
      await waitFor(() => releases.has("ses_b"))

      // The reload settles while the selection's own snapshot is still open.
      release("ses_a")
      await reload
      test.relay.pushEvent("ses_b", {
        id: "evt_live",
        type: "session.text.delta",
        data: { assistantMessageID: "msg_a1", ordinal: 0, delta: "STREAMED" },
      })
      await test.flush()
      release("ses_b")
      await selection
      await test.flush()

      expect(test.store.state().activeSessionID).toBe("ses_b")
      const messages = test.store.state().view?.messages ?? []
      expect(messages.map((message) => message.id)).toEqual(["msg_1", "msg_a1"])
      const streamed = messages.flatMap((message) =>
        message.kind === "assistant" ? message.parts.filter((part) => part.kind === "text").map((part) => part.text) : [],
      )
      expect(streamed).toEqual(["STREAMED"])
    } finally {
      await test.stop()
    }
  })

  test("releases only what the current connection registered", async () => {
    const test = await harness()
    const unsubscribes = () => test.relay.requests.filter((request) => request.operation === "session.unsubscribe")
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")

      // Reconnecting replaces the socket, and the relay tracks subscriptions per socket.
      test.store.connect("dev_1")
      await test.runUntil(() => test.store.state().transport.kind === "open" && test.store.state().sessions.length > 0)
      // The replaced socket publishes its close after the new one is live.
      await test.flush()

      await test.store.selectSession("ses_b")
      expect(unsubscribes()).toHaveLength(0)

      // The live connection still owns the session it registered.
      await test.store.selectSession("ses_a")
      await waitFor(() => unsubscribes().length === 1)
      expect(unsubscribes().map((request) => request.sessionID)).toEqual(["ses_b"])
    } finally {
      await test.stop()
    }
  })

  test("keeps the winner's snapshot when a superseded selection settles later", async () => {
    const gates = new Map<string, Promise<void>>()
    const releases = new Map<string, () => void>()
    const gateFor = (sessionID: string) => {
      const open = gates.get(sessionID)
      if (open !== undefined) return open
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      gates.set(sessionID, gate)
      releases.set(sessionID, release)
      return gate
    }
    const test = await harness({
      watermark: 10,
      messages: { ses_b: [{ id: "msg_1", type: "user", text: "before", time: { created: 1 } }] },
      handler: async (request) => {
        if (request.operation === "session.snapshot") await gateFor(request.sessionID ?? "")
        return "default" as const
      },
    })
    const release = (sessionID: string) => {
      const open = releases.get(sessionID)
      if (open === undefined) throw new Error(`no gated snapshot for ${sessionID}`)
      open()
    }
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)

      const first = test.store.selectSession("ses_a")
      await waitFor(() => releases.has("ses_a"))
      const second = test.store.selectSession("ses_b")
      await waitFor(() => releases.has("ses_b"))

      // The superseded selection settles while the winner's snapshot is still open.
      release("ses_a")
      await first
      test.relay.pushEvent("ses_b", {
        id: "evt_live",
        type: "session.text.delta",
        data: { assistantMessageID: "msg_a1", ordinal: 0, delta: "STREAMED" },
      })
      await test.flush()
      release("ses_b")
      await second
      await test.flush()

      expect(test.store.state().activeSessionID).toBe("ses_b")
      const messages = test.store.state().view?.messages ?? []
      expect(messages.map((message) => message.id)).toEqual(["msg_1", "msg_a1"])
      const streamed = messages.flatMap((message) =>
        message.kind === "assistant" ? message.parts.filter((part) => part.kind === "text").map((part) => part.text) : [],
      )
      expect(streamed).toEqual(["STREAMED"])
    } finally {
      await test.stop()
    }
  })

  test("scopes subscriptions to the connection that registered them", async () => {
    // The relay tracks a client's subscriptions per socket, so a replaced socket's
    // close says nothing about the connection that replaced it. This double holds
    // that close back to publish it after the replacement has registered, an
    // ordering a real socket cannot be asked to produce.
    const sockets: { readonly publish: (status: RemoteTransportStatus) => void; readonly unsubscribes: string[] }[] = []
    const store = createRemoteStore({
      http: createRemoteHttp({ baseURL: "http://127.0.0.1:1" }),
      createTransport: (_deviceID, handlers) => {
        const socket = { publish: handlers.onStatus ?? (() => {}), unsubscribes: [] as string[] }
        sockets.push(socket)
        const transport: RemoteTransport = {
          connect: () => handlers.onStatus?.({ kind: "open" }),
          // The replaced socket reports nothing here; the case publishes it by hand.
          close: () => {},
          setPriority: () => {},
          status: () => ({ kind: "open" }),
          request: async (operation, input) => {
            if (operation === "session.unsubscribe") socket.unsubscribes.push(String(input?.sessionID))
            if (operation === "session.snapshot") {
              return {
                status: "ok",
                value: {
                  session: { title: "t" },
                  messages: [],
                  watermark: { type: "log.synced", aggregateID: input?.sessionID, seq: 0 },
                },
              }
            }
            return { status: "ok", value: { data: {} } }
          },
        }
        return transport
      },
    })
    try {
      store.connect("dev_1")
      await store.selectSession("ses_a")
      expect(sockets).toHaveLength(1)
      expect(sockets[0]?.unsubscribes).toEqual([])

      store.connect("dev_1")
      await store.selectSession("ses_b")
      // The replacement never registered ses_a, so it must not release it.
      expect(sockets[1]?.unsubscribes).toEqual([])

      // The replaced socket's late close must not end the live connection's stream.
      sockets[0]?.publish({ kind: "closed", code: 1000, reason: "switching device", retryable: false })
      expect(store.state().connection).toEqual({ kind: "connected", deviceName: "dev_1" })
      await store.selectSession("ses_a")
      expect(sockets[1]?.unsubscribes).toEqual(["ses_b"])
    } finally {
      store.dispose()
    }
  })

  test("a replaced connection's late rejection cannot tear down the live connection", async () => {
    const test = await fakeConnectionHarness()
    const alertCategories = () => test.store.state().notifications.map((entry) => entry.category)
    try {
      await test.store.load()
      expect(test.sockets).toHaveLength(1)
      expect(test.store.state().connection).toEqual({ kind: "connected", deviceName: "dev_1" })
      await test.store.selectSession("ses_a")
      test.sockets[0]?.statusFrame(["ses_a"], [])
      test.sockets[0]?.event("ses_a", { id: "evt_done", type: "session.execution.succeeded", data: {} })
      await test.flush()
      expect(alertCategories()).toEqual([])
      test.sockets[0]?.statusFrame([], [])
      expect(alertCategories()).toEqual([])
      test.sockets[0]?.notices({ type: "notice.added", notices: [{ id: "ntc_1", category: "agent-completed", sessionID: "ses_a", createdAt: 1 }], total: 1 })
      expect(alertCategories()).toEqual(["agent-completed"])

      // The device switch replaces the socket, so the alerts it raised end with it.
      test.store.connect("dev_1")
      expect(test.sockets).toHaveLength(2)
      expect(test.store.state().connection).toEqual({ kind: "connected", deviceName: "dev_1" })
      await test.store.selectSession("ses_a")
      test.sockets[1]?.statusFrame(["ses_a"], [])
      test.sockets[1]?.event("ses_a", { id: "evt_done_again", type: "session.execution.succeeded", data: {} })
      await test.flush()
      expect(alertCategories()).toEqual([])
      test.sockets[1]?.statusFrame([], [])
      expect(alertCategories()).toEqual([])
      test.sockets[1]?.notices({ type: "notice.added", notices: [{ id: "ntc_2", category: "agent-completed", sessionID: "ses_a", createdAt: 2 }], total: 1 })
      expect(alertCategories()).toEqual(["agent-completed"])

      // A late 4401 from the replaced socket must not sign the browser out or end
      // the alerts of the connection that replaced it.
      test.sockets[0]?.publish({ kind: "closed", code: 4401, reason: "Your session expired.", retryable: false })
      test.sockets[0]?.statusFrame(["ses_a"], ["ses_a"])

      expect(test.store.state().connection).toEqual({ kind: "connected", deviceName: "dev_1" })
      expect(test.store.state().owner?.id).toBe("user_1")
      expect(test.store.state().devices.map((device) => device.id)).toEqual(["dev_1"])
      expect(test.store.state().activeDeviceID).toBe("dev_1")
      expect(alertCategories()).toEqual(["agent-completed"])
      expect(test.store.state().view?.status).toBe("idle")
      expect(test.store.state().view?.executionStarted).toBeUndefined()
    } finally {
      await test.stop()
    }
  })

  test("a live device rejection tears down that device and refreshes the still-signed-in account", async () => {
    const test = await harness()
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().connection.kind === "connected")

      test.relay.setMe({
        user: { id: "user_1" },
        session: { expiresAt: 4_102_444_800_000 },
        devices: [{ id: "dev_1", name: "Studio Mac", createdAt: 1, status: "revoked", online: false }],
      })
      test.relay.dropConnections(4403, "device revoked")
      await test.runUntil(() => test.store.state().connection.kind === "no-device-enrolled")

      expect(test.store.state().owner?.id).toBe("user_1")
      expect(test.store.state().devices.map((device) => device.status)).toEqual(["revoked"])
      expect(test.store.state().activeDeviceID).toBeUndefined()
      expect(test.store.state().sessions).toHaveLength(0)
      expect(test.store.state().advertised).toHaveLength(0)
    } finally {
      await test.stop()
    }
  })

  test("a revoked device aborts an in-flight attachment image read", async () => {
    let aborted = false
    const test = await harness({ fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { aborted = true; reject(new DOMException("Aborted", "AbortError")) })
    }) })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().connection.kind === "connected")
      const read = test.store.loadImageSource({ deviceID: "dev_1", sessionID: "ses_a", digest: "a".repeat(64), mime: "image/png" })
      const settled = read.then(() => false, (error: unknown) => error instanceof DOMException && error.name === "AbortError")
      test.relay.dropConnections(4403, "device revoked")
      await test.runUntil(() => aborted)
      expect(aborted).toBe(true)
      expect(await settled).toBe(true)
    } finally { await test.stop() }
  })

  test("ignores frames and reconnects from the connection that was replaced", async () => {
    const test = await fakeConnectionHarness()
    const streamed = () =>
      (test.store.state().view?.messages ?? []).flatMap((message) =>
        message.kind === "assistant" ? message.parts.filter((part) => part.kind === "text").map((part) => part.text) : [],
      )
    try {
      await test.store.load()
      await test.store.selectSession("ses_a")
      test.store.connect("dev_1")
      await test.store.selectSession("ses_a")

      // The replacement advertises and streams its own state.
      test.sockets[1]?.sessions(["ses_b"])
      expect(test.store.state().advertised).toEqual([])
      test.sockets[1]?.event("ses_a", {
        id: "evt_live",
        type: "session.text.delta",
        data: { assistantMessageID: "msg_live", ordinal: 0, delta: "LIVE" },
      })
      await test.flush()
      expect(streamed()).toEqual(["LIVE"])

      // Frames and a reconnect from the replaced socket must not reach the store.
      test.sockets[0]?.sessions(["ses_stale"])
      test.sockets[0]?.event("ses_a", {
        id: "evt_stale",
        type: "session.text.delta",
        data: { assistantMessageID: "msg_stale", ordinal: 0, delta: "STALE" },
      })
      test.sockets[0]?.reconnect()
      await test.flush()

      expect(test.store.state().advertised).toEqual([])
      expect(streamed()).toEqual(["LIVE"])
      expect(test.store.state().notice).toBeUndefined()
    } finally {
      await test.stop()
    }
  })

  test("keeps a superseded selection's snapshot failure out of the winner's context", async () => {
    let releaseFirst: (() => void) | undefined
    const firstSnapshot = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const test = await harness({
      handler: async (request) => {
        if (request.operation === "session.snapshot" && request.sessionID === "ses_a") {
          await firstSnapshot
          return { ok: false, code: "internal_error", message: "snapshot read failed" }
        }
        return "default" as const
      },
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)

      const first = test.store.selectSession("ses_a")
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.snapshot" && request.sessionID === "ses_a"))
      const second = test.store.selectSession("ses_b")
      await second
      await waitFor(() => test.store.state().view?.id === "ses_b")
      expect(test.store.state().notice).toBeUndefined()

      releaseFirst?.()
      await first

      // The failed read belonged to a selection the winner already replaced.
      expect(test.store.state().activeSessionID).toBe("ses_b")
      expect(test.store.state().view?.id).toBe("ses_b")
      expect(test.store.state().notice).toBeUndefined()
    } finally {
      await test.stop()
    }
  })

  test("settles a selection with a newer streamed event without announcing its older snapshot", async () => {
    const gate = Promise.withResolvers<void>()
    let reads = 0
    const test = await harness({ handler: async (request) => {
      if (request.operation !== "session.snapshot") return "default" as const
      reads += 1
      if (reads === 1) await gate.promise
      return { ok: true, value: {
        sourceEpoch: "epoch_1", session: { id: "ses_a" },
        messages: [{ id: reads === 1 ? "msg_old" : "msg_fresh", type: "assistant", agent: "god",
          content: [{ type: "text", text: reads === 1 ? "OLD" : "FRESH" }], time: { created: 1 } }],
        watermark: { type: "log.synced", aggregateID: "ses_a", seq: reads === 1 ? 1 : 3 },
      } }
    } })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().sessions.length > 0)
      const selection = test.store.selectSession("ses_a")
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.snapshot"))
      test.relay.pushEvent("ses_a", { type: "session.text.delta", data: { assistantMessageID: "msg_live", ordinal: 0, delta: "LATEST" },
        durable: { aggregateID: "ses_a", seq: 2, version: 1 }, sourceEpoch: "epoch_1" })
      await test.runUntil(() => test.store.state().view?.watermark === 2)
      gate.resolve()
      await selection
      expect(test.store.state().activeSessionID).toBe("ses_a")
      expect(test.store.state().view?.watermark).toBe(2)
      expect(test.store.state().view?.messages.map((message) => message.id)).toEqual(["msg_live"])
      expect(test.store.state().history).toEqual({ status: "stale" })
      expect(test.store.state().notice).toBeUndefined()
      expect(test.relay.requests.some((request) => request.operation === "session.pending.list")).toBe(true)

      await test.store.reloadMessages()
      expect(reads).toBe(2)
      expect(test.store.state().view?.watermark).toBe(3)
      expect(test.store.state().view?.messages.map((message) => message.id)).toEqual(["msg_fresh"])
      expect(test.store.state().history).toEqual({ status: "idle" })
      expect(test.store.state().notice).toBeUndefined()
    } finally { gate.resolve(); await test.stop() }
  })

  test("reports an actual initial snapshot read failure", async () => {
    const test = await harness({ handler: (request) => request.operation === "session.snapshot"
      ? { ok: false, code: "internal_error", message: "snapshot read failed" } : "default" })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      expect(test.store.state().notice).toContain("snapshot read failed")
      expect(test.store.state().history).toBeUndefined()
    } finally { await test.stop() }
  })

  test("keeps a replaced connection's snapshot failure out of the new connection", async () => {
    const test = await harness({
      handler: async (request) => {
        // The old connection's read never settles on the relay; the device switch
        // closes the socket, which is what settles it in the transport.
        if (request.operation === "session.snapshot" && request.sessionID === "ses_a") await new Promise<void>(() => {})
        return "default" as const
      },
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      const selection = test.store.selectSession("ses_a")
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.snapshot" && request.sessionID === "ses_a"))

      test.store.connect("dev_2")
      await test.runUntil(() => test.store.state().transport.kind === "open" && test.store.state().sessions.length > 0)
      await selection
      await test.flush()

      expect(test.store.state().activeDeviceID).toBe("dev_2")
      expect(test.store.state().activeSessionID).toBeUndefined()
      expect(test.store.state().notice).toBeUndefined()
    } finally {
      await test.stop()
    }
  })

  test("does not let a replaced connection's session list repopulate the new connection", async () => {
    let lists = 0
    const test = await harness({
      handler: async (request) => {
        if (request.operation === "session.list" && request.input?.workspace !== undefined) {
          lists += 1
          if (lists === 1) {
            return { ok: true, value: { data: [{ id: "ses_a", title: "Old device session", time: { created: 1, updated: 1 } }] } }
          }
          return { ok: false, code: "internal_error", message: "the new device is not ready" }
        }
        return "default" as const
      },
    })
    try {
      await test.store.load()
      await test.runUntil(() => lists === 1 && test.store.state().sessions[0]?.title === "Old device session")

      test.store.connect("dev_2")
      await test.runUntil(() => test.store.state().transport.kind === "open" && lists === 2)
      await test.flush()

      // The new connection has no list of its own yet; the replaced device's
      // sessions must not stand in for it.
      expect(test.store.state().activeDeviceID).toBe("dev_2")
      expect(test.store.state().sessions).toEqual([])
    } finally {
      await test.stop()
    }
  })

  test("keeps the newest advertisement's list when an earlier read settles later", async () => {
    let lists = 0
    let releaseOlder: (() => void) | undefined
    const olderRead = new Promise<void>((resolve) => {
      releaseOlder = resolve
    })
    const test = await harness({
      handler: async (request) => {
        if (request.operation === "session.list" && request.input?.workspace !== undefined) {
          lists += 1
          if (lists === 1) {
            await olderRead
            return { ok: true, value: { data: [{ id: "ses_a", title: "Older list", time: { created: 1, updated: 1 } }] } }
          }
          return { ok: true, value: { data: [{ id: "ses_b", title: "Newer list", time: { created: 1, updated: 2 } }] } }
        }
        return "default" as const
      },
    })
    try {
      await test.store.load()
      await test.runUntil(() => lists === 1)
      test.relay.pushSessions(["ses_b"])
      releaseOlder?.()
      await test.runUntil(() => lists === 2)
      await test.runUntil(() => test.store.state().sessions.length === 1)
      expect(test.store.state().sessions[0]?.title).toBe("Newer list")
      await Bun.sleep(50)

      expect(test.store.state().sessions.map((session) => session.title)).toEqual(["Newer list"])
    } finally {
      await test.stop()
    }
  })

  test("does not apply a superseded session's autonomy response to the current view", async () => {
    let releaseYolo: (() => void) | undefined
    const yolo = new Promise<void>((resolve) => {
      releaseYolo = resolve
    })
    const test = await harness({
      handler: async (request) => {
        if (request.operation === "session.autonomy.set") {
          await yolo
          return "default" as const
        }
        return "default" as const
      },
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")

      const pending = test.store.setYolo(3)
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.autonomy.set"))

      // The user moves to another session while the reply is still in flight.
      await test.store.selectSession("ses_b")
      await waitFor(() => test.store.state().view?.id === "ses_b" && test.store.state().view?.autonomy?.yolo === 0)

      releaseYolo?.()
      await pending

      expect(test.store.state().view?.id).toBe("ses_b")
      expect(test.store.state().view?.autonomy).toMatchObject({ yolo: 0 })
    } finally {
      await test.stop()
    }
  })

  test("keeps a reconnect reload out of the connection that replaced it", async () => {
    let holdLists = false
    let held = 0
    const heldLists = new Promise<void>(() => {})
    const test = await harness({
      handler: async (request) => {
        if (request.operation === "session.list" && request.input?.workspace !== undefined && holdLists) {
          held += 1
          await heldLists
        }
        return "default" as const
      },
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")

      // The reconnect's own list read stays open across the device switch.
      holdLists = true
      test.relay.dropConnections(1006, "")
      await test.runUntil(() => held >= 1)

      holdLists = false
      test.store.connect("dev_2")
      await test.runUntil(() => test.store.state().transport.kind === "open" && test.store.state().sessions.length > 0)
      await test.flush()

      expect(test.store.state().activeDeviceID).toBe("dev_2")
      expect(test.store.state().notice).toBeUndefined()
    } finally {
      await test.stop()
    }
  })

  test("releases the reconnect's own stream when the selection moved on", async () => {
    let subscribes = 0
    let releaseReconnect: (() => void) | undefined
    const reconnectSubscribe = new Promise<void>((resolve) => {
      releaseReconnect = resolve
    })
    const test = await harness({
      handler: async (request) => {
        if (request.operation === "session.subscribe") {
          subscribes += 1
          // The reconnect re-registers the session on the live socket, and the user
          // moves on before that response settles.
          if (subscribes === 2) await reconnectSubscribe
        }
        return "default" as const
      },
    })
    const unsubscribes = () => test.relay.requests.filter((request) => request.operation === "session.unsubscribe")
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")

      test.relay.dropConnections(1006, "")
      await test.runUntil(() => subscribes === 2)

      await test.store.selectSession("ses_b")
      expect(test.store.state().activeSessionID).toBe("ses_b")

      releaseReconnect?.()
      await waitFor(() => unsubscribes().some((request) => request.sessionID === "ses_a"))
      expect(unsubscribes().map((request) => request.sessionID)).toEqual(["ses_a"])
      expect(test.store.state().activeSessionID).toBe("ses_b")
      expect(test.store.state().notice).toBeUndefined()
    } finally {
      await test.stop()
    }
  })

  test("a deliberate disconnect keeps the device-less state after the socket's late close", async () => {
    const test = await harness()
    try {
      await test.store.load()
      await waitFor(() => test.store.state().connection.kind === "connected")
      test.store.disconnect()
      expect(test.store.state().connection).toEqual({ kind: "no-device-selected" })

      // The real socket publishes its close after the synchronous close() call.
      await waitFor(() => test.relay.closeEvents.length > 0)
      await test.flush()

      expect(test.store.state().connection).toEqual({ kind: "no-device-selected" })
      expect(test.store.state().activeDeviceID).toBeUndefined()
      expect(test.store.state().owner?.id).toBe("user_1")
    } finally {
      await test.stop()
    }
  })

  test("batches streamed deltas into one state notification and keeps tool output bounded", async () => {
    const test = await harness()
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      let notifications = 0
      const unsubscribe = test.store.subscribe(() => (notifications += 1))

      for (const delta of ["Hel", "lo ", "world"]) {
        test.relay.pushEvent("ses_a", { id: "evt_1", type: "session.text.delta", data: { assistantMessageID: "msg_a1", ordinal: 0, delta } })
      }
      test.relay.pushEvent("ses_a", {
        id: "evt_2",
        type: "session.tool.success",
        data: {
          assistantMessageID: "msg_a1",
          callID: "call_1",
          content: [{ type: "text", text: "x".repeat(9_000) }],
        },
      })
      expect(notifications).toBe(0)
      await test.flush()
      expect(notifications).toBe(1)

      const assistant = test.store.state().view?.messages.find((message) => message.id === "msg_a1")
      expect(assistant?.kind).toBe("assistant")
      if (assistant?.kind !== "assistant") return
      expect(assistant.parts[0]).toMatchObject({ kind: "text", text: "Hello world" })
      const tool = assistant.parts.find((part) => part.kind === "tool")
      expect(tool?.kind).toBe("tool")
      if (tool?.kind !== "tool") return
      expect(tool.content[0]?.kind).toBe("text")
      expect(tool.content[0]?.kind === "text" ? tool.content[0].text.length : 0).toBe(9_000)
      unsubscribe()
    } finally {
      await test.stop()
    }
  })

  test("sends a prompt with a durable message id and clears the mutation on success", async () => {
    const test = await harness()
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      await test.store.sendPrompt({ text: "Run the tests", delivery: "queue" })
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.prompt"))
      const prompt = test.relay.requests.find((request) => request.operation === "session.prompt")
      expect(prompt?.input).toEqual({ id: "msg_local_1", text: "Run the tests", delivery: "queue" })
      expect(prompt?.sessionID).toBe("ses_a")
      expect(test.store.state().mutations).toHaveLength(0)
      expect(test.store.state().view?.messages.at(-1)).toMatchObject({ kind: "user", id: "msg_local_1", text: "Run the tests", delivery: "queue" })
      expect(test.store.state().mutationToasts).toEqual([])
    } finally {
      await test.stop()
    }
  })

  test("keeps an uncertain mutation visible and retries it with the same message id on demand", async () => {
    let closeOnPrompt = true
    const test = await harness({
      handler: (request) => {
        if (request.operation === "session.prompt" && closeOnPrompt) {
          closeOnPrompt = false
          return "close"
        }
        return "default"
      },
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      await test.store.sendPrompt({ text: "Deploy", delivery: "steer" })
      await waitFor(() => test.store.state().mutations[0]?.state === "unknown")
      const mutation = test.store.state().mutations[0]
      expect(mutation?.state).toBe("unknown")
      expect(mutation?.detail).toContain("Outcome unknown")
      expect(test.store.state().mutationToasts?.at(-1)).toMatchObject({ id: mutation?.id, state: "unknown" })
      if (!mutation) throw new Error("expected an unsettled mutation")

      await test.runUntil(() => test.store.state().transport.kind === "open")
      await test.store.retryMutation(mutation.id)
      await waitFor(() => test.relay.requests.filter((request) => request.operation === "session.prompt").length === 2)
      const prompts = test.relay.requests.filter((request) => request.operation === "session.prompt")
      expect(prompts).toHaveLength(2)
      expect(prompts[0]?.input?.id).toBe(prompts[1]?.input?.id)
      expect(test.store.state().mutations).toHaveLength(0)
    } finally {
      await test.stop()
    }
  })

  test("an admitted pending read resolves an uncertain prompt without replaying it", async () => {
    const test = await harness({ handler: (request) => {
      if (request.operation === "session.prompt") return "close"
      if (request.operation === "session.pending.list") return { ok: true, value: { data: [{ id: "msg_local_1", sessionID: "ses_a", admittedSeq: 2, timeCreated: 2,
        type: "user", data: { text: "Continue safely" }, delivery: "steer" }] } }
      return "default"
    } })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      await test.store.sendPrompt({ text: "Continue safely", delivery: "steer" })
      await test.runUntil(() => test.store.state().transport.kind === "open")
      await test.runUntil(() => test.store.state().mutations.every((mutation) => mutation.id !== "msg_local_1"))
      expect(test.store.state().view?.messages.filter((message) => message.id === "msg_local_1")).toHaveLength(1)
      expect(test.store.state().mutationToasts?.find((toast) => toast.id === "msg_local_1")).toBeUndefined()
      expect(test.relay.requests.filter((request) => request.operation === "session.prompt")).toHaveLength(1)
    } finally { await test.stop() }
  })

  test("replies to permission, guardrail, and native form requests with protocol payloads", async () => {
    const test = await harness()
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      test.relay.pushEvent("ses_a", { id: "evt_p", type: "permission.asked", data: { id: "per_1", action: "edit", resources: ["src/**"] } })
      test.relay.pushEvent("ses_a", {
        id: "evt_g",
        type: "guardrail.asked",
        data: { id: "grq_1", action: "rm -rf build", resources: ["build"], reason: "Deletion", hardReview: true },
      })
      test.relay.pushEvent("ses_a", {
        id: "evt_q",
        type: "form.created",
        data: {
          form: {
            id: "frm_1",
            sessionID: "ses_a",
            title: "Question",
            metadata: { kind: "question" },
            fields: [{ key: "q0", type: "string", title: "Which?", options: [{ value: "a", label: "A" }], custom: true }],
          },
        },
      })
      await test.flush()
      expect(test.store.state().view?.requests.map((request) => request.kind)).toEqual(["permission", "guardrail", "form"])

      await test.store.replyPermission("per_1", "once")
      await test.store.replyGuardrail("grq_1", "reject")
      await test.store.replyForm("frm_1", { q0: "a" })
      await waitFor(() => test.relay.requests.filter((request) => request.operation.endsWith(".reply")).length === 3)
      const replies = test.relay.requests.filter((request) => request.operation.endsWith(".reply"))
      expect(replies.map((request) => request.operation)).toEqual([
        "session.permission.reply",
        "session.guardrail.reply",
        "session.form.reply",
      ])
      expect(replies[0]?.input).toEqual({ requestID: "per_1", reply: "once" })
      expect(replies[1]?.input).toEqual({ requestID: "grq_1", reply: "reject" })
      expect(replies[2]?.input).toEqual({ formID: "frm_1", answer: { q0: "a" } })
    } finally {
      await test.stop()
    }
  })

  test("hydrates native forms, applies live settlement, and cancels with the form payload", async () => {
    const form = {
      id: "frm_seed",
      sessionID: "ses_a",
      title: "Question",
      metadata: { kind: "question" },
      fields: [{ key: "q0", type: "string", title: "Which module?", options: [{ value: "core", label: "Core" }], custom: true }],
    }
    const test = await harness({ forms: [form] })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0).catch(async (cause: unknown) => {
        console.error(JSON.stringify({ diagnostic: "form-inventory", transport: test.store.state().transport, connection: test.store.state().connection,
          sessionListStatus: test.store.state().sessionListStatus, notice: test.store.state().notice, ...await test.relay.diagnostics() }))
        throw cause
      })
      await test.store.selectSession("ses_a")
      expect(test.store.state().view?.requests).toMatchObject([{ kind: "form", id: "frm_seed", form }])

      test.relay.pushEvent("ses_a", { id: "evt_form_live", type: "form.created", data: { form: { ...form, id: "frm_live" } } })
      await test.flush()
      expect(test.store.state().view?.requests.map((request) => request.id)).toEqual(["frm_seed", "frm_live"])

      test.relay.pushEvent("ses_a", { id: "evt_form_replied", type: "form.replied", data: { id: "frm_live", sessionID: "ses_a", answer: { q0: "core" } } })
      await test.flush()
      expect(test.store.state().view?.requests.map((request) => request.id)).toEqual(["frm_seed"])

      test.relay.pushEvent("ses_a", { id: "evt_form_cancelled_created", type: "form.created", data: { form: { ...form, id: "frm_cancelled" } } })
      test.relay.pushEvent("ses_a", { id: "evt_form_cancelled", type: "form.cancelled", data: { id: "frm_cancelled", sessionID: "ses_a" } })
      await test.flush()
      expect(test.store.state().view?.requests.map((request) => request.id)).toEqual(["frm_seed"])

      await test.store.cancelForm("frm_seed")
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.form.cancel"))
      expect(test.relay.requests.find((request) => request.operation === "session.form.cancel")?.input).toEqual({ formID: "frm_seed" })
      expect(test.store.state().view?.requests).toHaveLength(0)
    } finally {
      await test.stop()
    }
  })

  test("reconciles live permission, hard-review, and Form changes over pending list reads", async () => {
    const form = {
      id: "frm_live",
      sessionID: "ses_a",
      title: "Question",
      fields: [{ key: "q0", type: "string", title: "Which?" }],
    }
    const permission = { id: "per_live", action: "edit", resources: ["src/**"] }
    const guardrail = {
      id: "grq_live", sessionID: "ses_a", rootSessionID: "ses_a",
      action: "rm -rf build", resources: ["build"], reason: "Human decision", hardReview: true,
    }
    for (const settling of [false, true]) {
      let release: (() => void) | undefined
      const gate = new Promise<void>((resolve) => { release = resolve })
      const test = await harness({
        ...(settling ? { permissions: [permission], guardrailRequests: [guardrail], forms: [form] } : {}),
        handler: async (request) => {
          if (request.operation !== "session.form.list") return "default" as const
          await gate
          return "default" as const
        },
      })
      try {
        await test.store.load()
        await waitFor(() => test.store.state().sessions.length > 0)
        const selected = test.store.selectSession("ses_a")
        await waitFor(() => test.relay.requests.some((request) => request.operation === "session.form.list"))
        if (settling) {
          test.relay.pushEvent("ses_a", { type: "permission.replied", data: { requestID: permission.id, reply: "reject" } })
          test.relay.pushEvent("ses_a", { type: "guardrail.replied", data: { requestID: guardrail.id, sessionID: "ses_a", rootSessionID: "ses_a", reply: "reject" } })
          test.relay.pushEvent("ses_a", { type: "form.cancelled", data: { id: form.id, sessionID: "ses_a" } })
        } else {
          test.relay.pushEvent("ses_a", { type: "permission.asked", data: permission })
          test.relay.pushEvent("ses_a", { type: "guardrail.asked", data: guardrail })
          test.relay.pushEvent("ses_a", { type: "form.created", data: { form } })
        }
        await test.flush()
        const expected = settling ? [] : [permission.id, guardrail.id, form.id]
        expect(test.store.state().view?.requests.map((request) => request.id)).toEqual(expected)
        release?.()
        await selected
        expect(test.store.state().view?.requests.map((request) => request.id)).toEqual(expected)
        if (!settling) {
          expect(test.store.state().view?.requests.find((request) => request.id === guardrail.id)).toMatchObject({ hardReview: true })
        }
      } finally {
        release?.()
        await test.stop()
      }
    }
  })

  test("refuses foreign forms and does not let a stale form reply alter a newly selected session", async () => {
    const form = (id: string, sessionID: string) => ({
      id,
      sessionID,
      title: "Question",
      metadata: { kind: "question" },
      fields: [{ key: "q0", type: "string", title: "Which module?", options: [{ value: "core", label: "Core" }] }],
    })
    let releaseReply: (() => void) | undefined
    const replyGate = new Promise<void>((resolve) => {
      releaseReply = resolve
    })
    const test = await harness({
      forms: [form("frm_a", "ses_a"), form("frm_b", "ses_b")],
      handler: async (request) => {
        if (request.operation !== "session.form.reply") return "default" as const
        await replyGate
        return "default" as const
      },
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      expect(test.store.state().view?.requests.map((request) => request.id)).toEqual(["frm_a"])

      test.relay.pushEvent("ses_a", { id: "evt_form_foreign", type: "form.created", data: { form: form("frm_foreign", "ses_b") } })
      await test.flush()
      expect(test.store.state().view?.requests.map((request) => request.id)).toEqual(["frm_a"])

      const reply = test.store.replyForm("frm_a", { q0: "core" })
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.form.reply"))
      await test.store.selectSession("ses_b")
      expect(test.store.state().view?.requests.map((request) => request.id)).toEqual(["frm_b"])
      if (releaseReply === undefined) throw new Error("Reply gate was not initialized")
      releaseReply()
      await reply
      expect(test.store.state().view?.requests.map((request) => request.id)).toEqual(["frm_b"])

      await test.store.replyForm("frm_foreign", { q0: "core" })
      expect(test.relay.requests.filter((request) => request.operation === "session.form.reply")).toHaveLength(1)
      expect(test.store.state().notice).toContain("another session")
    } finally {
      await test.stop()
    }
  })

  test("removes a request locally after a successful reply and keeps it on failure", async () => {
    let failReply = false
    const test = await harness({
      permissions: [{ id: "per_1", action: "edit", resources: ["src/**"] }],
      guardrailRequests: [
        { id: "grq_1", sessionID: "ses_a", rootSessionID: "ses_a", action: "rm -rf build", resources: ["build"], reason: "Deletion", hardReview: false },
      ],
      handler: (request) =>
        failReply && request.operation === "session.permission.reply"
          ? { ok: false, code: "internal_error", message: "reply failed" }
          : "default",
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      expect(test.store.state().view?.requests.map((request) => request.id)).toEqual(["per_1", "grq_1"])

      await test.store.replyGuardrail("grq_1", "reject")
      await waitFor(() => test.store.state().view?.requests.length === 1)
      expect(test.store.state().view?.requests.map((request) => request.id)).toEqual(["per_1"])

      failReply = true
      await test.store.replyPermission("per_1", "once")
      expect(test.store.state().view?.requests.map((request) => request.id)).toEqual(["per_1"])
      expect(test.store.state().mutations.some((mutation) => mutation.state === "failed")).toBe(true)
      const failed = test.store.state().mutationToasts?.at(-1)
      expect(failed).toMatchObject({ state: "failed", label: expect.any(String) })
      test.store.dismissMutationToast(failed?.id ?? "")
      expect(test.store.state().mutationToasts).toEqual([])
      expect(test.store.state().mutations.some((mutation) => mutation.state === "failed")).toBe(true)
    } finally {
      await test.stop()
    }
  })

  test("sets YOLO, sets a goal, and stops it through the autonomy operations", async () => {
    const test = await harness()
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      await test.store.setYolo(3)
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.autonomy.set"))
      expect(test.relay.requests.find((request) => request.operation === "session.autonomy.set")?.input).toEqual({ yolo: 3 })
      expect(test.store.state().view?.autonomy).toMatchObject({ yolo: 3 })

      expect(await test.store.setGoal("Ship the remote workspace")).toBe(true)
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.goal.set"))
      expect(test.relay.requests.filter((request) => request.operation === "session.goal.set").at(-1)?.input).toEqual({
        goal: "Ship the remote workspace",
      })
      await waitFor(() => test.store.state().view?.autonomy?.goal?.text === "Ship the remote workspace")
      expect(test.store.state().view?.autonomy).toMatchObject({ mode: "goal", goal: { text: "Ship the remote workspace" } })

      await test.store.stopGoal()
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.goal.stop"))
      expect(test.relay.requests.find((request) => request.operation === "session.goal.stop")?.input).toEqual({ goal: null })
    } finally {
      await test.stop()
    }
  })

  test("shows the goal an unknown outcome left active without claiming the request succeeded", async () => {
    let goal = false
    const test = await harness({ handler: (request) => {
      if (request.operation === "session.goal.set") { goal = true; return { ok: false, code: "outcome_unknown", message: "Request timed out" } }
      if (request.operation === "session.autonomy.get") return { ok: true, value: { data: { mode: "normal", yolo: 0,
        ...(goal ? { goal: { text: "Ship the workspace", status: "active", iteration: 0, noProgress: 0, maxNoProgress: 3 } } : {}) } } }
      return "default"
    } })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      expect(await test.store.setGoal("Ship the workspace")).toBe(true)
      await waitFor(() => test.store.state().view?.autonomy?.goal?.status === "active")
      await waitFor(() => test.store.state().drafts.ses_a === "/goal Ship the workspace")
      expect(test.relay.requests.filter((request) => request.operation === "session.goal.set")).toHaveLength(1)
      expect(test.relay.requests.filter((request) => request.operation === "session.autonomy.get").length).toBeGreaterThanOrEqual(2)
      expect(test.store.state().mutations.find((mutation) => mutation.kind === "goal")).toMatchObject({ state: "unknown" })
      expect(test.store.state().mutationToasts?.find((toast) => toast.label === "Set goal")).toMatchObject({ state: "unknown" })
    } finally { await test.stop() }
  })

  test("a goal synthesis exceeding the ordinary request deadline still activates the goal", async () => {
    const test = await harness({ requestTimeoutMs: 30, handler: async (request) => {
      if (request.operation !== "session.goal.set") return "default"
      await Bun.sleep(65)
      return { ok: true, value: { data: { mode: "goal", yolo: 0,
        goal: { text: "Ship the workspace", status: "active", iteration: 0, noProgress: 0, maxNoProgress: 3 } } } }
    } })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      expect(await test.store.setGoal("Ship the workspace")).toBe(true)
      await test.runUntil(() => test.store.state().view?.autonomy?.goal?.status === "active")
      expect(test.store.state().mutations).toEqual([])
      expect(test.relay.requests.filter((request) => request.operation === "session.goal.set")).toHaveLength(1)
    } finally { await test.stop() }
  })

  test("keeps an unconfirmed goal outcome retryable after an autonomy read", async () => {
    const test = await harness({ handler: (request) => request.operation === "session.goal.set"
      ? { ok: false, code: "outcome_unknown", message: "Request timed out" } : "default" })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      expect(await test.store.setGoal("Inspect the migration")).toBe(true)
      await waitFor(() => test.store.state().drafts.ses_a === "/goal Inspect the migration")
      expect(test.store.state().view?.autonomy?.goal).toBeUndefined()
      expect(test.store.state().mutations.find((mutation) => mutation.kind === "goal")).toMatchObject({ state: "unknown", detail: "The goal request was not confirmed. Check the Session goal before retrying." })
      expect(test.store.state().mutationToasts?.at(-1)).toMatchObject({ label: "Set goal", state: "unknown" })
      expect(test.relay.requests.filter((request) => request.operation === "session.goal.set")).toHaveLength(1)
    } finally { await test.stop() }
  })

  const activeGoal = (text: string) => ({ mode: "goal", yolo: 0, goal: { text, status: "active", iteration: 0, noProgress: 0, maxNoProgress: 3 } })
  const goalSteerAdmitted = { type: "session.input.admitted", data: { sessionID: "ses_a", inputID: "msg_goal_start",
    input: { type: "synthetic", data: { text: "Continue", description: "Goal · steer", metadata: { autonomy: { yolo: 0, goal: true, iteration: 0 } } }, delivery: "steer" } } }

  test("accepts a goal at once, keeps it in flight without blocking, and finishes it from the settled response", async () => {
    const calculation = Promise.withResolvers<void>()
    const test = await harness({ handler: async (request) => {
      if (request.operation !== "session.goal.set") return "default"
      await calculation.promise
      return { ok: true, value: { data: activeGoal("Ship the workspace") } }
    } })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      expect(await Promise.race([test.store.setGoal("Ship the workspace"), Bun.sleep(250).then(() => "still waiting")])).toBe(true)
      expect(test.store.state().mutations).toMatchObject([{ kind: "goal", state: "sending", sessionID: "ses_a", input: { goal: "Ship the workspace" } }])
      expect(test.store.state().view?.autonomy?.goal).toBeUndefined()
      calculation.resolve()
      await waitFor(() => test.store.state().view?.autonomy?.goal?.status === "active")
      expect(test.store.state().mutations).toEqual([])
      expect(test.store.state().mutationToasts?.some((toast) => toast.label === "Set goal")).toBe(false)
    } finally { calculation.resolve(); await test.stop() }
  })

  test("refuses a second goal while one is being set and sends the first only once", async () => {
    const calculation = Promise.withResolvers<void>()
    const test = await harness({ handler: async (request) => {
      if (request.operation !== "session.goal.set") return "default"
      await calculation.promise
      return { ok: true, value: { data: activeGoal("First objective") } }
    } })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      expect(await Promise.race([test.store.setGoal("First objective"), Bun.sleep(250).then(() => "still waiting")])).toBe(true)
      expect(await test.store.setGoal("Second objective")).toBe(false)
      expect(test.store.state().notice).toBe("A goal is already being set for this Session.")
      calculation.resolve()
      await waitFor(() => test.store.state().view?.autonomy?.goal?.text === "First objective")
      expect(test.relay.requests.filter((request) => request.operation === "session.goal.set").map((request) => request.input)).toEqual([{ goal: "First objective" }])
    } finally { calculation.resolve(); await test.stop() }
  })

  test("returns a failed goal to an empty draft and never overwrites newer typing", async () => {
    const failure = Promise.withResolvers<void>()
    const test = await harness({ handler: async (request) => {
      if (request.operation !== "session.goal.set") return "default"
      await failure.promise
      return { ok: false, code: "internal_error", message: "Goal calculation failed" }
    } })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      void test.store.setGoal("Inspect the migration")
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.goal.set"))
      failure.resolve()
      await waitFor(() => test.store.state().mutations.some((mutation) => mutation.kind === "goal" && mutation.state === "failed"))
      expect(test.store.state().drafts.ses_a).toBe("/goal Inspect the migration")
      expect(test.store.state().mutationToasts?.at(-1)).toMatchObject({ label: "Set goal", state: "failed", detail: "Goal calculation failed" })
    } finally { failure.resolve(); await test.stop() }

    const typing = Promise.withResolvers<void>()
    const typed = await harness({ handler: async (request) => {
      if (request.operation !== "session.goal.set") return "default"
      await typing.promise
      return { ok: false, code: "internal_error", message: "Goal calculation failed" }
    } })
    try {
      await typed.store.load()
      await waitFor(() => typed.store.state().sessions.length > 0)
      await typed.store.selectSession("ses_a")
      void typed.store.setGoal("Inspect the migration")
      await waitFor(() => typed.relay.requests.some((request) => request.operation === "session.goal.set"))
      typed.store.setDraft("ses_a", "Also check the docs")
      typing.resolve()
      await waitFor(() => typed.store.state().mutations.some((mutation) => mutation.kind === "goal" && mutation.state === "failed"))
      expect(typed.store.state().drafts.ses_a).toBe("Also check the docs")
    } finally { typing.resolve(); await typed.stop() }
  })

  test("keeps whitespace the user typed while a failed goal was calculating", async () => {
    const calculation = Promise.withResolvers<void>()
    const test = await harness({ handler: async (request) => {
      if (request.operation !== "session.goal.set") return "default"
      await calculation.promise
      return { ok: false, code: "internal_error", message: "Goal calculation failed" }
    } })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      expect(await test.store.setGoal("Inspect the migration")).toBe(true)
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.goal.set"))
      test.store.setDraft("ses_a", "  ")
      calculation.resolve()
      await waitFor(() => test.store.state().mutations.some((mutation) => mutation.operation === "session.goal.set" && mutation.state === "failed"))
      expect(test.store.state().drafts.ses_a).toBe("  ")
    } finally { calculation.resolve(); await test.stop() }
  })

  test("shows the goal the stream admits without attributing it to an uncertain request", async () => {
    let goal = false
    const test = await harness({ handler: (request) => {
      if (request.operation === "session.goal.set") return { ok: false, code: "outcome_unknown", message: "Request timed out" }
      if (request.operation === "session.autonomy.get") return { ok: true, value: { data: goal ? activeGoal("Ship the workspace") : { mode: "normal", yolo: 0 } } }
      return "default"
    } })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      void test.store.setGoal("Ship the workspace")
      await waitFor(() => test.store.state().mutations.some((mutation) => mutation.kind === "goal" && mutation.state === "unknown"))
      goal = true
      test.relay.pushEvent("ses_a", goalSteerAdmitted)
      await test.runUntil(() => test.store.state().view?.autonomy?.goal?.status === "active")
      expect(test.store.state().mutations.find((mutation) => mutation.kind === "goal")).toMatchObject({ state: "unknown" })
      expect(test.relay.requests.filter((request) => request.operation === "session.goal.set")).toHaveLength(1)
    } finally { await test.stop() }
  })

  test("drops an earlier unresolved goal request when a new goal starts so a later goal cannot confirm it", async () => {
    let requests = 0
    let clock = 1_000
    const test = await harness({ now: () => clock++, handler: (request) => {
      if (request.operation !== "session.goal.set") return "default"
      requests += 1
      return requests === 1 ? { ok: false, code: "outcome_unknown", message: "Request timed out" } : { ok: true, value: { data: activeGoal("Second objective") } }
    } })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      void test.store.setGoal("First objective")
      await waitFor(() => test.store.state().drafts.ses_a === "/goal First objective")
      expect(await test.store.setGoal("Second objective")).toBe(true)
      await waitFor(() => test.store.state().view?.autonomy?.goal?.text === "Second objective")
      expect(test.store.state().mutations).toEqual([])
      expect(test.store.state().mutationToasts?.filter((toast) => toast.label === "Set goal").map((toast) => toast.state)).toEqual(["unknown"])
    } finally { await test.stop() }
  })

  test("keeps a goal whose response was lost with the connection unknown when the reconnect read shows a goal", async () => {
    let goal = false
    const test = await harness({ handler: (request) => {
      if (request.operation === "session.goal.set") { goal = true; return "silent" }
      if (request.operation === "session.autonomy.get") return { ok: true, value: { data: goal ? activeGoal("Ship the workspace") : { mode: "normal", yolo: 0 } } }
      return "default"
    } })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      void test.store.setGoal("Ship the workspace")
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.goal.set"))
      test.relay.dropConnections(1006, "")
      await test.runUntil(() => test.store.state().transport.kind === "open" && test.store.state().view?.autonomy?.goal?.status === "active")
      expect(test.store.state().mutations.find((mutation) => mutation.kind === "goal")).toMatchObject({ state: "unknown" })
      expect(test.relay.requests.filter((request) => request.operation === "session.goal.set")).toHaveLength(1)
    } finally { await test.stop() }
  })

  test("a goal active before the Session autonomy loaded does not confirm the request", async () => {
    const autonomy = Promise.withResolvers<void>()
    const calculation = Promise.withResolvers<void>()
    const test = await harness({ handler: async (request) => {
      if (request.operation === "session.autonomy.get") {
        await autonomy.promise
        return { ok: true, value: { data: activeGoal("Existing objective") } }
      }
      if (request.operation !== "session.goal.set") return "default"
      await calculation.promise
      return { ok: true, value: { data: activeGoal("Replacement objective") } }
    } })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      void test.store.selectSession("ses_a")
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.autonomy.get"))
      expect(test.store.state().view?.autonomy).toBeUndefined()
      expect(await test.store.setGoal("Replacement objective")).toBe(true)
      autonomy.resolve()
      await waitFor(() => test.store.state().view?.autonomy?.goal?.text === "Existing objective")
      expect(test.store.state().mutations).toMatchObject([{ kind: "goal", state: "sending" }])
      expect(test.store.state().mutationToasts?.some((toast) => toast.label === "Set goal")).toBe(false)
      calculation.resolve()
      await waitFor(() => test.store.state().view?.autonomy?.goal?.text === "Replacement objective")
      expect(test.store.state().mutations).toEqual([])
      expect(test.store.state().mutationToasts?.some((toast) => toast.label === "Set goal")).toBe(false)
    } finally { autonomy.resolve(); calculation.resolve(); await test.stop() }
  })

  test("a goal another writer starts while a request is open shows as active but is not reported as its success", async () => {
    const calculation = Promise.withResolvers<void>()
    let other = false
    const test = await harness({ handler: async (request) => {
      if (request.operation === "session.autonomy.get") return { ok: true, value: { data: other ? activeGoal("Other writer objective") : { mode: "normal", yolo: 0 } } }
      if (request.operation !== "session.goal.set") return "default"
      await calculation.promise
      return { ok: true, value: { data: activeGoal("Requested objective") } }
    } })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      expect(await test.store.setGoal("Requested objective")).toBe(true)
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.goal.set"))
      other = true
      test.relay.pushEvent("ses_a", goalSteerAdmitted)
      await test.runUntil(() => test.store.state().view?.autonomy?.goal?.text === "Other writer objective")
      expect(test.store.state().mutations).toMatchObject([{ kind: "goal", state: "sending" }])
      expect(test.store.state().mutationToasts?.some((toast) => toast.label === "Set goal")).toBe(false)
      expect(await test.store.setGoal("Second objective")).toBe(false)
      expect(test.store.state().notice).toBe("A goal is already being set for this Session.")
      calculation.resolve()
      await waitFor(() => test.store.state().view?.autonomy?.goal?.text === "Requested objective")
      expect(test.store.state().mutations).toEqual([])
      expect(test.store.state().mutationToasts?.some((toast) => toast.label === "Set goal")).toBe(false)
    } finally { calculation.resolve(); await test.stop() }
  })

  test("keeps a recovered goal draft and the unknown outcome when another writer's goal appears", async () => {
    let other = false
    const test = await harness({ handler: (request) => {
      if (request.operation === "session.goal.set") return { ok: false, code: "outcome_unknown", message: "Request timed out" }
      if (request.operation === "session.autonomy.get") return { ok: true, value: { data: other ? activeGoal("Other writer objective") : { mode: "normal", yolo: 0 } } }
      return "default"
    } })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      void test.store.setGoal("Inspect the migration")
      await waitFor(() => test.store.state().drafts.ses_a === "/goal Inspect the migration")
      other = true
      test.relay.pushEvent("ses_a", goalSteerAdmitted)
      await test.runUntil(() => test.store.state().view?.autonomy?.goal?.text === "Other writer objective")
      expect(test.store.state().mutations.find((mutation) => mutation.kind === "goal")).toMatchObject({ state: "unknown" })
      expect(test.store.state().drafts.ses_a).toBe("/goal Inspect the migration")
    } finally { await test.stop() }
  })

  test("reports a replacement goal whose text equals the goal it replaced from its own response", async () => {
    const test = await harness({ handler: (request) => {
      if (request.operation === "session.autonomy.get") return { ok: true, value: { data: activeGoal("Ship the workspace") } }
      if (request.operation === "session.goal.set") return { ok: true, value: { data: activeGoal("Ship the workspace") } }
      return "default"
    } })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      await waitFor(() => test.store.state().view?.autonomy?.goal?.text === "Ship the workspace")
      expect(await test.store.setGoal("  Ship   the workspace ")).toBe(true)
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.goal.set") && test.store.state().mutations.length === 0)
      expect(test.store.state().mutations).toEqual([])
      expect(test.store.state().mutationToasts?.some((toast) => toast.label === "Set goal")).toBe(false)
    } finally { await test.stop() }
  })

  test("keeps a replacement goal unknown when its response is lost and the active goal has the replaced text", async () => {
    const test = await harness({ handler: (request) => {
      if (request.operation === "session.autonomy.get") return { ok: true, value: { data: activeGoal("Ship the workspace") } }
      if (request.operation === "session.goal.set") return { ok: false, code: "outcome_unknown", message: "Request timed out" }
      return "default"
    } })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      await waitFor(() => test.store.state().view?.autonomy?.goal?.text === "Ship the workspace")
      expect(await test.store.setGoal("Ship the workspace")).toBe(true)
      await waitFor(() => test.store.state().drafts.ses_a === "/goal Ship the workspace")
      expect(test.store.state().mutations.find((mutation) => mutation.kind === "goal")).toMatchObject({ state: "unknown" })
    } finally { await test.stop() }
  })

  test("refuses a second goal while the autonomy read of an unknown outcome is open", async () => {
    const read = Promise.withResolvers<void>()
    let reads = 0
    const test = await harness({ handler: async (request) => {
      if (request.operation === "session.goal.set") return { ok: false, code: "outcome_unknown", message: "Request timed out" }
      if (request.operation !== "session.autonomy.get") return "default"
      reads += 1
      if (reads > 1) await read.promise
      return { ok: true, value: { data: { mode: "normal", yolo: 0 } } }
    } })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      void test.store.setGoal("First objective")
      await waitFor(() => test.store.state().mutations.some((mutation) => mutation.kind === "goal" && mutation.state === "unknown"))
      expect(await test.store.setGoal("Second objective")).toBe(false)
      expect(test.store.state().notice).toBe("A goal is already being set for this Session.")
      read.resolve()
      await waitFor(() => test.store.state().drafts.ses_a === "/goal First objective")
      expect(test.relay.requests.filter((request) => request.operation === "session.goal.set")).toHaveLength(1)
    } finally { read.resolve(); await test.stop() }
  })

  for (const [name, leave] of [
    ["switches to another machine", (store: Harness["store"]) => store.connect("dev_2")],
    ["disconnects", (store: Harness["store"]) => store.disconnect()],
  ] as const) test(`leaves no goal request, draft, or toast behind when the workspace ${name} during a goal request`, async () => {
    const calculation = Promise.withResolvers<void>()
    const test = await harness({ handler: async (request) => {
      if (request.operation !== "session.goal.set") return "default"
      await calculation.promise
      return { ok: true, value: { data: activeGoal("Ship the workspace") } }
    } })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      expect(await test.store.setGoal("Ship the workspace")).toBe(true)
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.goal.set"))
      leave(test.store)
      await test.runUntil(() => name === "disconnects" || test.store.state().transport.kind === "open")
      await Bun.sleep(50)
      expect(test.store.state().drafts.ses_a).toBeUndefined()
      expect(test.store.state().mutations.some((mutation) => mutation.kind === "goal")).toBe(false)
      expect(test.store.state().mutationToasts?.some((toast) => toast.label === "Set goal")).toBeFalsy()
      test.store.connect("dev_1")
      await test.runUntil(() => test.store.state().transport.kind === "open" && test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      expect(await test.store.setGoal("Ship the workspace")).toBe(true)
    } finally { calculation.resolve(); await test.stop() }
  })

  test("a same-machine connection replacement lets its new goal proceed without the old goal settling into it", async () => {
    const second = Promise.withResolvers<void>()
    let goals = 0
    const test = await harness({ handler: async (request) => {
      if (request.operation !== "session.goal.set") return "default"
      goals += 1
      if (goals === 1) return "silent"
      await second.promise
      return { ok: true, value: { data: activeGoal("New connection objective") } }
    } })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      expect(await test.store.setGoal("Old connection objective")).toBe(true)
      await waitFor(() => goals === 1)
      test.store.connect("dev_1")
      await test.runUntil(() => test.store.state().transport.kind === "open" && test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      expect(await test.store.setGoal("New connection objective")).toBe(true)
      await waitFor(() => goals === 2)
      expect(test.store.state().drafts.ses_a).toBeUndefined()
      expect(test.store.state().mutations.filter((mutation) => mutation.operation === "session.goal.set")).toMatchObject([
        { input: { goal: "New connection objective" }, state: "sending" },
      ])
      expect(test.store.state().mutationToasts?.some((toast) => toast.label === "Set goal")).toBe(false)
      expect(await test.store.setGoal("Third objective")).toBe(false)
      expect(goals).toBe(2)
      second.resolve()
      await waitFor(() => test.store.state().view?.autonomy?.goal?.text === "New connection objective")
      expect(test.store.state().mutations.some((mutation) => mutation.operation === "session.goal.set")).toBe(false)
      expect(test.store.state().mutationToasts?.some((toast) => toast.label === "Set goal")).toBe(false)
    } finally { second.resolve(); await test.stop() }
  })

  test("disposal drops an in-flight goal without restoring its draft or outcome", async () => {
    const test = await harness({ handler: (request) => request.operation === "session.goal.set" ? "silent" : "default" })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      expect(await test.store.setGoal("Old objective")).toBe(true)
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.goal.set"))
      test.store.dispose()
      await Bun.sleep(0)
      expect(test.store.state().drafts.ses_a).toBeUndefined()
      expect(test.store.state().mutations.some((mutation) => mutation.operation === "session.goal.set")).toBe(false)
      expect(test.store.state().mutationToasts?.some((toast) => toast.label === "Set goal")).toBe(false)
    } finally { await test.stop() }
  })

  test("interrupts the active session", async () => {
    const test = await harness()
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      await test.store.interrupt()
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.interrupt"))
      expect(test.relay.requests.find((request) => request.operation === "session.interrupt")?.sessionID).toBe("ses_a")
    } finally {
      await test.stop()
    }
  })

  test("reloads history read-only after a reconnect and leaves the caller's draft untouched", async () => {
    const test = await harness({
      messages: {
        ses_a: [{ id: "msg_1", type: "user", text: "before", time: { created: 1 } }],
      },
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      const draft = "work in progress"
      test.relay.dropConnections(1006, "")
      await test.runUntil(
        () => test.store.state().transport.kind === "open" && test.store.state().notice?.includes("read-only") === true,
      )
      expect(test.store.state().notice).toContain("read-only")
      expect(test.store.state().view?.messages.map((message) => message.id)).toEqual(["msg_1"])
      expect(draft).toBe("work in progress")
      expect(test.relay.requests.filter((request) => request.operation === "session.subscribe").length).toBeGreaterThanOrEqual(2)
    } finally {
      await test.stop()
    }
  })

  test("counts unknown events instead of rendering them", async () => {
    const test = await harness()
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      test.relay.pushEvent("ses_a", { id: "evt_x", type: "session.experimental.future", data: { anything: true } })
      test.relay.pushEvent("ses_a", { id: "evt_y", type: "session.context.observed", data: { source: "session-state", text: "…" } })
      await test.flush()
      expect(test.store.state().unhandledEvents).toBe(1)
      expect(test.store.state().view?.messages).toEqual([{ kind: "system", id: "evt_y", text: "…", source: "session-state", created: 1_000 }])
    } finally {
      await test.stop()
    }
  })

  test("drops the browser session and devices when the rejected relay refresh finds an expired account", async () => {
    const test = await harness()
    try {
      await test.store.load()
      await waitFor(() => test.store.state().connection.kind === "connected")
      test.relay.setMe({ error: { code: "unauthorized", message: "Sign in required" } }, 401)
      test.relay.dropConnections(4401, "Your session expired.")
      await waitFor(() => test.store.state().connection.kind === "signed-out")
      expect(test.store.state().devices).toHaveLength(0)
      expect(test.store.state().advertised).toHaveLength(0)
    } finally {
      await test.stop()
    }
  })

  test("seeds chips from the authoritative autonomy read and lists pending requests", async () => {
    const test = await harness({
      autonomy: { mode: "normal", yolo: 2, goal: { text: "Ship it", status: "active", iteration: 4, noProgress: 0, maxNoProgress: 5 } },
      permissions: [{ id: "per_1", action: "edit", resources: ["src/**"] }],
      guardrailRequests: [
        { id: "grq_mine", sessionID: "ses_a", rootSessionID: "ses_a", action: "rm -rf build", resources: ["build"], reason: "Deletion", hardReview: false },
        { id: "grq_child", sessionID: "ses_child", rootSessionID: "ses_a", action: "rm -rf dist", resources: ["dist"], reason: "Deletion", hardReview: true },
      ],
      forms: [
        {
          id: "frm_1",
          sessionID: "ses_a",
          title: "Question",
          metadata: { kind: "question" },
          fields: [{ key: "q0", type: "string", title: "Which?", options: [{ value: "a", label: "A" }], custom: true }],
        },
      ],
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      const view = test.store.state().view
      expect(view?.autonomy).toMatchObject({ mode: "goal", yolo: 2, goal: { iteration: 4 } })
      expect(view?.requests.map((request) => request.id)).toEqual(["per_1", "grq_mine", "grq_child", "frm_1"])
      const foreign = view?.requests.find((request) => request.id === "grq_child")
      expect(foreign && canReplyToRequest(foreign, "ses_a")).toBe(true)
      const mine = view?.requests.find((request) => request.id === "grq_mine")
      expect(mine && canReplyToRequest(mine, "ses_a")).toBe(true)

      await test.store.replyGuardrail("grq_child", "reject")
      expect(test.relay.requests.find((request) => request.operation === "session.guardrail.reply")).toMatchObject({ sessionID: "ses_a", input: { requestID: "grq_child", reply: "reject" } })
      expect(test.store.state().view?.requests.some((request) => request.id === "grq_child")).toBe(false)

      await test.store.replyGuardrail("grq_mine", "once")
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.guardrail.reply"))
    } finally {
      await test.stop()
    }
  })

  test("drops events at or below the snapshot watermark and applies later ones", async () => {
    const test = await harness({
      watermark: 5,
      messages: { ses_a: [{ id: "msg_1", type: "user", text: "before", time: { created: 1 } }] },
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      expect(test.store.state().view?.watermark).toBe(5)

      test.relay.pushEvent("ses_a", {
        id: "evt_dup",
        type: "session.text.delta",
        durable: { aggregateID: "ses_a", seq: 5, version: 1 },
        data: { assistantMessageID: "msg_dup", ordinal: 0, delta: "duplicate" },
      })
      await test.flush()
      expect(test.store.state().view?.messages.map((message) => message.id)).toEqual(["msg_1"])

      test.relay.pushEvent("ses_a", {
        id: "evt_next",
        type: "session.text.delta",
        durable: { aggregateID: "ses_a", seq: 6, version: 1 },
        data: { assistantMessageID: "msg_2", ordinal: 0, delta: "fresh" },
      })
      await test.flush()
      expect(test.store.state().view?.messages.map((message) => message.id)).toEqual(["msg_1", "msg_2"])
      expect(test.store.state().view?.watermark).toBe(6)
    } finally {
      await test.stop()
    }
  })

  test("re-reads the snapshot when a durable gap is detected", async () => {
    let watermark = 5
    const test = await harness({ handler: (request) => request.operation === "session.snapshot"
      ? { ok: true, value: { sourceEpoch: "epoch_1", session: { id: request.sessionID }, messages: [],
        watermark: { type: "log.synced", aggregateID: request.sessionID, seq: watermark } } }
      : "default" })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      watermark = 9
      test.relay.pushEvent("ses_a", {
        id: "evt_gap",
        type: "session.execution.started",
        durable: { aggregateID: "ses_a", seq: 9, version: 1 },
        data: {},
      })
      await test.flush()
      await waitFor(() => test.relay.requests.filter((request) => request.operation === "session.snapshot").length >= 2)
      await waitFor(() => test.store.state().view?.watermark === 9)
      expect(test.store.state().notice).toBeUndefined()
    } finally {
      await test.stop()
    }
  })
})
