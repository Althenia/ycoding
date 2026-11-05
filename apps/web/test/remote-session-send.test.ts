import { describe, expect, spyOn, test } from "bun:test"
import { RemoteLimits } from "@ycoding-ai/remote"
import { createRemoteHttp } from "../src/remote/http"
import { createRemoteStore } from "../src/remote/store"
import { createRemoteTransport } from "../src/remote/transport"
import { startRelayDouble, waitFor, type RelayHandlerOutcome, type RelayRequestHandler } from "./relay-double"

function gate() {
  return Promise.withResolvers<RelayHandlerOutcome>()
}

async function harness(handler: RelayRequestHandler, now?: () => number, deterministicIDs = true) {
  const relay = await startRelayDouble({ handler, advertisedSessions: ["ses_a", "ses_b"] })
  let ids = 0
  const store = createRemoteStore({
    http: createRemoteHttp({ baseURL: relay.httpURL }),
    createTransport: (deviceID, handlers) => createRemoteTransport({ url: relay.wsURL(deviceID), handlers, resetDelayMs: 10, maxDelayMs: 20 }),
    ...(deterministicIDs ? { createMessageID: () => `msg_send_${++ids}` } : {}),
    now,
    batchMs: 0,
  })
  await store.load()
  await waitFor(() => store.state().sessions.length > 0)
  await store.selectSession("ses_a")
  return { store, relay, stop: async () => { store.dispose(); await relay.stop() } }
}

const source = { id: "ses_a", scope: "bound", projectID: "prj_test", location: { directory: "/work" }, title: "Source" }
const forked = { ...source, id: "ses_child", title: "Fork", fork: { sessionID: "ses_a" } }
const boundaryFork = { ...forked, fork: { ...forked.fork, messageID: "msg_boundary" } }
const forkHarness = (handler: RelayRequestHandler) => harness((request) => request.operation === "session.list"
  ? { ok: true, value: { data: [source, { ...source, id: "ses_b" }] } }
  : handler(request))

describe("remote Session nonblocking sends", () => {
  test("opens a verified fork on the same device", async () => {
    const child = forked
    const context = await forkHarness((request) => request.operation === "session.fork" ? { ok: true, value: { data: child } }
      : request.operation === "session.get" && request.sessionID === child.id ? { ok: true, value: { data: child } } : "default")
    try {
      expect(await context.store.forkSession()).toMatchObject({ status: "ok", sessionID: child.id })
      expect(context.store.state().selectedSessionInfo?.id).toBe(child.id)
      expect(context.relay.requests.filter((request) => request.operation === "session.fork")).toHaveLength(1)
    } finally { await context.stop() }
  })

  test("fork reports an unsupported operation without Team copy", async () => {
    const context = await forkHarness((request) => request.operation === "session.fork" ? { ok: false, code: "unknown_operation", message: "unknown" } : "default")
    try {
      const result = await context.store.forkSession()
      expect(result.status).toBe("failed")
      if (result.status === "ok") throw new Error("Expected fork failure")
      expect(result.message).toContain("fork")
      expect(result.message).not.toContain("Team")
    } finally { await context.stop() }
  })

  for (const [name, child] of [
    ["scope", { ...boundaryFork, scope: "standalone" }],
    ["directory", { ...boundaryFork, location: { directory: "/other" } }],
    ["source", { ...boundaryFork, fork: { ...boundaryFork.fork, sessionID: "ses_other" } }],
    ["message", { ...boundaryFork, fork: { ...boundaryFork.fork, messageID: "msg_other" } }],
    ["missing scope", { ...boundaryFork, scope: undefined }],
  ] as const) test(`fork rejects mismatched ${name}`, async () => {
    const context = await forkHarness((request) => request.operation === "session.fork" ? { ok: true, value: { data: child } } : "default")
    try {
      expect((await context.store.forkSession("msg_boundary")).status).toBe("unknown")
      expect(context.store.state().activeSessionID).toBe("ses_a")
    } finally { await context.stop() }
  })

  test("fork without a boundary rejects an unexpected boundary", async () => {
    const context = await forkHarness((request) => request.operation === "session.fork" ? { ok: true, value: { data: boundaryFork } } : "default")
    try {
      expect((await context.store.forkSession()).status).toBe("unknown")
      expect(context.store.state().activeSessionID).toBe("ses_a")
    } finally { await context.stop() }
  })

  test("fork rejects a source placement changed by a list refresh", async () => {
    const response = gate()
    let changed = false
    const context = await harness((request) => request.operation === "session.fork" ? response.promise
      : request.operation === "session.list" ? { ok: true, value: { data: [{ ...source, location: { directory: changed ? "/other" : "/work" } }] } } : "default")
    try {
      const result = context.store.forkSession()
      await waitFor(() => context.relay.requests.some((request) => request.operation === "session.fork"))
      changed = true
      context.store.searchSessions("source")
      await waitFor(() => context.store.state().selectedSessionInfo?.directory === "/other")
      response.resolve({ ok: true, value: { data: forked } })
      expect((await result).status).toBe("unknown")
      expect(context.store.state().activeSessionID).toBe("ses_a")
    } finally { response.resolve("default"); await context.stop() }
  })

  test("fork prevents concurrent duplicate submissions", async () => {
    const response = gate()
    const context = await forkHarness((request) => request.operation === "session.fork" ? response.promise : "default")
    try {
      const first = context.store.forkSession()
      await waitFor(() => context.relay.requests.some((request) => request.operation === "session.fork"))
      const duplicate = context.store.forkSession()
      response.resolve({ ok: false, code: "outcome_unknown", message: "unknown" })
      expect((await first).status).toBe("unknown")
      expect((await duplicate).status).toBe("failed")
      expect(context.relay.requests.filter((request) => request.operation === "session.fork")).toHaveLength(1)
      expect(context.store.state().mutations).toEqual([])
    } finally { response.resolve("default"); await context.stop() }
  })

  test("fork does not report success after selection is superseded", async () => {
    const subscription = gate()
    const context = await forkHarness((request) => request.operation === "session.fork" ? { ok: true, value: { data: forked } }
      : request.operation === "session.subscribe" && request.sessionID === forked.id ? subscription.promise : "default")
    try {
      const result = context.store.forkSession()
      await waitFor(() => context.relay.requests.some((request) => request.operation === "session.subscribe" && request.sessionID === forked.id))
      await context.store.selectSession("ses_b")
      subscription.resolve({ ok: true, value: {} })
      expect((await result).status).toBe("unknown")
      expect(context.store.state().activeSessionID).toBe("ses_b")
    } finally { subscription.resolve("default"); await context.stop() }
  })

  test("fork does not report success after the device changes during selection", async () => {
    const subscription = gate()
    const context = await forkHarness((request) => request.operation === "session.fork" ? { ok: true, value: { data: forked } }
      : request.operation === "session.subscribe" && request.sessionID === forked.id ? subscription.promise : "default")
    try {
      const result = context.store.forkSession()
      await waitFor(() => context.relay.requests.some((request) => request.operation === "session.subscribe" && request.sessionID === forked.id))
      context.store.connect("device_other")
      subscription.resolve({ ok: true, value: {} })
      expect((await result).status).toBe("unknown")
    } finally { subscription.resolve("default"); await context.stop() }
  })

  test("fork requires explicit source scope", async () => {
    const context = await harness((request) => request.operation === "session.list"
      ? { ok: true, value: { data: [{ ...source, scope: undefined }] } } : "default")
    try {
      expect((await context.store.forkSession()).status).toBe("failed")
      expect(context.relay.requests.filter((request) => request.operation === "session.fork")).toHaveLength(0)
    } finally { await context.stop() }
  })

  test("fork retains unknown outcomes and does not replay the mutation", async () => {
    const context = await forkHarness((request) => request.operation === "session.fork"
      ? { ok: false, code: "outcome_unknown", message: "Fork outcome unknown" } : "default")
    try {
      expect(await context.store.forkSession("msg_boundary")).toMatchObject({ status: "unknown" })
      expect(context.relay.requests.filter((request) => request.operation === "session.fork")).toHaveLength(1)
      expect(context.store.state().selectedSessionInfo?.id).toBe("ses_a")
    } finally { await context.stop() }
  })

  test("a late fork response cannot change a newer Session selection", async () => {
    const response = gate()
    const context = await forkHarness((request) => request.operation === "session.fork" ? response.promise : "default")
    try {
      const fork = context.store.forkSession()
      await waitFor(() => context.relay.requests.some((request) => request.operation === "session.fork"))
      await context.store.selectSession("ses_b")
      response.resolve({ ok: true, value: { data: { id: "ses_child", scope: "bound", location: { directory: "/work" } } } })
      await fork
      expect(context.store.state().selectedSessionInfo?.id).toBe("ses_b")
    } finally { response.resolve("default"); await context.stop() }
  })
  const snapshotInfo = { projectID: "prj_test", title: "Deep", location: { directory: "/work" }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 } }
  for (const [name, session, aggregateID] of [["empty", {}, undefined], ["mismatched", { ...snapshotInfo, id: "ses_other" }, undefined], ["invalid scope", { ...snapshotInfo, id: "ses_deep", scope: "unknown" }, undefined], ["foreign watermark", { ...snapshotInfo, id: "ses_deep" }, "ses_other"]] as const)
    test(`deep-linked placement rejects ${name} snapshot authority`, async () => {
      const context = await harness((request) => request.sessionID !== "ses_deep" ? "default"
        : request.operation === "session.get" ? { ok: false, code: "not_found", message: "Not found" }
        : request.operation === "session.snapshot" ? { ok: true, value: { session, messages: [], watermark: { seq: 0, aggregateID } } } : "default")
      try {
        await context.store.selectSession("ses_deep")
        expect(await context.store.sendPrompt({ text: "Must not send", delivery: "queue" })).toBe(false)
        expect(context.relay.requests.filter((request) => request.operation === "session.prompt" && request.sessionID === "ses_deep")).toHaveLength(0)
      } finally { await context.stop() }
    })

  test("deep-linked placement rejects stale snapshot authority", async () => {
    let reads = 0
    const context = await harness((request) => request.sessionID !== "ses_deep" ? "default"
      : request.operation === "session.get" ? { ok: false, code: "not_found", message: "Not found" }
      : request.operation === "session.snapshot" ? { ok: true, value: { session: ++reads === 1 ? {} : { ...snapshotInfo, id: "ses_deep" }, messages: [], watermark: { seq: reads === 1 ? 5 : 4, aggregateID: "ses_deep" } } } : "default")
    try {
      await context.store.selectSession("ses_deep")
      expect(context.store.state().view?.watermark).toBe(5)
      await context.store.reloadMessages()
      expect(await context.store.sendPrompt({ text: "Must not send", delivery: "queue" })).toBe(false)
      expect(context.relay.requests.filter((request) => request.operation === "session.prompt" && request.sessionID === "ses_deep")).toHaveLength(0)
    } finally { await context.stop() }
  })

  test("placement change prevents queued and retried prompt dispatch", async () => {
    const modelGate = gate()
    const context = await harness((request) => request.operation === "session.switchModel" ? modelGate.promise : "default")
    try {
      expect(await context.store.sendPrompt({ text: "First", delivery: "steer", model: { id: "next", providerID: "synthetic" } })).toBe(true)
      await waitFor(() => context.relay.requests.some((request) => request.operation === "session.switchModel"))
      expect(await context.store.sendPrompt({ text: "Queued", delivery: "queue" })).toBe(true)
      context.relay.pushEvent("ses_a", { type: "session.created", data: { sessionID: "ses_a", scope: "standalone" }, durable: { aggregateID: "ses_a", seq: 1, version: 2 } })
      await waitFor(() => context.store.state().view?.scope === "standalone")
      modelGate.resolve({ ok: true, value: { data: {} } })
      await waitFor(() => context.store.state().mutations.every((mutation) => mutation.state === "failed"))
      for (const mutation of context.store.state().mutations) await context.store.retryMutation(mutation.id)
      expect(context.relay.requests.filter((request) => request.operation === "session.prompt")).toHaveLength(0)
    } finally { modelGate.resolve("default"); await context.stop() }
  })

  for (const outcome of ["standalone", "failed", "legacy"] as const)
    test(`deep-linked placement ${outcome} gates sends until resolved`, async () => {
      const detail = gate()
      const context = await harness((request) => request.sessionID === "ses_deep" && request.operation === "session.get" ? detail.promise
        : request.sessionID === "ses_deep" && request.operation === "session.snapshot" && outcome === "failed" ? { ok: false, code: "not_found", message: "Not found" } : "default")
      try {
        const selection = context.store.selectSession("ses_deep")
        await waitFor(() => context.relay.requests.some((request) => request.operation === "session.get" && request.sessionID === "ses_deep"))
        expect(context.store.state().selectedSessionInfo?.scope).toBeUndefined()
        expect(await context.store.sendPrompt({ text: "Pending", delivery: "queue" })).toBe(false)
        expect(context.relay.requests.filter((request) => request.operation === "session.prompt" && request.sessionID === "ses_deep")).toHaveLength(0)
        detail.resolve(outcome === "failed" ? { ok: false, code: "not_found", message: "Not found" } : { ok: true, value: { data: { id: "ses_deep", ...(outcome === "standalone" ? { scope: "standalone" } : {}) } } })
        await selection
        expect(context.store.state().selectedSessionInfo?.scope).toBe(outcome === "failed" ? undefined : outcome === "legacy" ? "bound" : "standalone")
        expect(await context.store.sendPrompt({ text: "Resolved", delivery: "steer" })).toBe(outcome === "legacy")
        await waitFor(() => outcome !== "legacy" || context.relay.requests.some((request) => request.operation === "session.prompt" && request.sessionID === "ses_deep"))
        expect(context.relay.requests.filter((request) => request.operation === "session.prompt" && request.sessionID === "ses_deep")).toHaveLength(outcome === "legacy" ? 1 : 0)
      } finally { detail.resolve({ ok: false, code: "not_found", message: "Not found" }); await context.stop() }
    })

  test("confirms a lost model-switch response from the exact selected model without sending it again", async () => {
    const target = { id: "model-next", providerID: "synthetic", variant: "high", profile: "synthetic-account" }
    let switched = false
    const context = await harness((request) => {
      if (request.operation === "session.switchModel") {
        switched = true
        return { ok: false, code: "outcome_unknown", message: "The model-switch response was lost" }
      }
      if (switched && request.operation === "session.get" && request.sessionID === "ses_a")
        return { ok: true, value: { data: { id: "ses_a", title: "Alpha session", model: target } } }
      return "default"
    })
    try {
      expect(await context.store.switchModel(target)).toBe(true)
      expect(context.store.state().view?.model).toEqual(target)
      expect(context.store.state().mutations).toEqual([])
      expect(context.store.state().mutationToasts ?? []).toEqual([])
      expect(context.relay.requests.filter((request) => request.operation === "session.switchModel")).toHaveLength(1)
      expect(context.store.state().transport.kind).toBe("open")
    } finally { await context.stop() }
  })

  for (const mismatch of ["id", "providerID", "variant", "profile", "missing"] as const)
    test(`keeps a model-switch outcome unknown when the read differs in ${mismatch}`, async () => {
      const target = { id: "model-next", providerID: "synthetic", variant: "high", profile: "synthetic-account" }
      let switched = false
      const context = await harness((request) => {
        if (request.operation === "session.switchModel") {
          switched = true
          return { ok: false, code: "outcome_unknown", message: "The model-switch response was lost" }
        }
        if (switched && request.operation === "session.get" && request.sessionID === "ses_a")
          return { ok: true, value: { data: { id: "ses_a", title: "Alpha session", ...(mismatch === "missing" ? {} : { model: { ...target, [mismatch]: "different" } }) } } }
        return "default"
      })
      try {
        expect(await context.store.switchModel(target)).toBe(false)
        expect(context.store.state().mutations).toEqual([expect.objectContaining({ state: "unknown", operation: "session.switchModel" })])
        expect(context.store.state().mutationToasts).toEqual([expect.objectContaining({ state: "unknown" })])
        expect(context.relay.requests.filter((request) => request.operation === "session.switchModel")).toHaveLength(1)
        expect(context.store.state().transport.kind).toBe("open")
      } finally { await context.stop() }
    })

  test("confirms a model prerequisite before sending its prompt, without repeating the switch", async () => {
    const target = { id: "model-next", providerID: "synthetic" }
    let switched = false
    const context = await harness((request) => {
      if (request.operation === "session.switchModel") {
        switched = true
        return { ok: false, code: "outcome_unknown", message: "The model-switch response was lost" }
      }
      if (switched && request.operation === "session.get" && request.sessionID === "ses_a")
        return { ok: true, value: { data: { id: "ses_a", title: "Alpha session", model: target } } }
      return "default"
    })
    try {
      expect(await context.store.sendPrompt({ text: "Use the selected model", model: target, delivery: "steer" })).toBe(true)
      await waitFor(() => context.relay.requests.some((request) => request.operation === "session.prompt"))
      expect(context.relay.requests.filter((request) => request.operation === "session.switchModel")).toHaveLength(1)
      expect(context.relay.requests.filter((request) => request.operation === "session.prompt")).toHaveLength(1)
    } finally { await context.stop() }
  })

  test("does not use a former Session's model confirmation after navigation", async () => {
    const target = { id: "model-next", providerID: "synthetic" }
    const reading = Promise.withResolvers<"reading">()
    const confirmed = gate()
    let switched = false
    const context = await harness((request) => {
      if (request.operation === "session.switchModel") {
        switched = true
        return { ok: false, code: "outcome_unknown", message: "The model-switch response was lost" }
      }
      if (switched && request.operation === "session.get" && request.sessionID === "ses_a") {
        reading.resolve("reading")
        return confirmed.promise
      }
      return "default"
    })
    try {
      const outcome = context.store.switchModel(target)
      expect(await Promise.race([reading.promise, outcome])).toBe("reading")
      await context.store.selectSession("ses_b")
      confirmed.resolve({ ok: true, value: { data: { id: "ses_a", title: "Alpha session", model: target } } })
      expect(await outcome).toBe(false)
      expect(context.store.state().view?.id).toBe("ses_b")
      expect(context.store.state().view?.model).not.toEqual(target)
      expect(context.relay.requests.filter((request) => request.operation === "session.switchModel")).toHaveLength(1)
    } finally { confirmed.resolve("default"); await context.stop() }
  })

  test("keeps a rejected model selection failed rather than inferring success from a read", async () => {
    const context = await harness((request) => request.operation === "session.switchModel"
      ? { ok: false, code: "forbidden", message: "Model change is not allowed" } : "default")
    try {
      const before = context.relay.requests.filter((request) => request.operation === "session.get").length
      expect(await context.store.switchModel({ id: "model-next", providerID: "synthetic" })).toBe(false)
      expect(context.store.state().mutations).toEqual([expect.objectContaining({ state: "failed" })])
      expect(context.relay.requests.filter((request) => request.operation === "session.get")).toHaveLength(before)
      expect(context.relay.requests.filter((request) => request.operation === "session.switchModel")).toHaveLength(1)
    } finally { await context.stop() }
  })

  for (const known of [true, false]) test(`does not treat ${known ? "an already-selected profile" : "a missing baseline"} as proof that an uncertain profile rebind completed`, async () => {
    const target = { id: "model-next", providerID: "synthetic", profile: "synthetic-account" }
    const context = await harness((request) => {
      if (request.operation === "session.snapshot") return { ok: true, value: {
        sourceEpoch: "epoch_1", session: { id: request.sessionID, title: "Alpha session", ...(known ? { model: target } : {}) }, messages: [],
        watermark: { type: "log.synced", aggregateID: request.sessionID, seq: 0 },
      } }
      if (request.operation === "session.switchModel") return { ok: false, code: "outcome_unknown", message: "The profile rebind response was lost" }
      if (request.operation === "session.get") return { ok: true, value: { data: { id: request.sessionID, model: target } } }
      return "default"
    })
    try {
      expect(context.store.state().view?.model).toEqual(known ? target : undefined)
      expect(await context.store.switchModel(target)).toBe(false)
      expect(context.store.state().mutations).toEqual([expect.objectContaining({ state: "unknown", operation: "session.switchModel" })])
      expect(context.relay.requests.filter((request) => request.operation === "session.switchModel")).toHaveLength(1)
    } finally { await context.stop() }
  })

  for (const kind of ["prompt", "command"] as const) test(`keeps an acknowledged ${kind} visible when an earlier pending read settles empty`, async () => {
    const pending = gate()
    let hold = false
    const context = await harness((request) => request.operation === "session.pending.list" && hold ? pending.promise : "default")
    try {
      const before = context.relay.requests.filter((request) => request.operation === "session.pending.list").length
      hold = true
      const selection = context.store.selectSession("ses_a")
      await waitFor(() => context.relay.requests.filter((request) => request.operation === "session.pending.list").length > before)
      expect(await (kind === "prompt"
        ? context.store.sendPrompt({ text: "Keep this prompt", delivery: "steer" })
        : context.store.runCommand({ command: "build", arguments: "--fast", delivery: "queue" }))).toBe(true)
      const id = context.store.state().mutations[0]!.id
      const text = kind === "prompt" ? "Keep this prompt" : "/build --fast"
      expect(context.store.state().view?.messages.find((message) => message.id === id)).toMatchObject({ text, state: "pending" })
      await waitFor(() => context.store.state().mutations.length === 0)
      pending.resolve({ ok: true, value: { data: [] } })
      await selection
      expect(context.store.state().view?.messages.find((message) => message.id === id)).toMatchObject({ text, state: "pending" })
      context.relay.pushEvent("ses_a", { type: "session.input.admitted", durable: { aggregateID: "ses_a", seq: 1, version: 1 }, data: {
        inputID: id, input: { type: "user", delivery: kind === "prompt" ? "steer" : "queue", data: { text } },
      } })
      context.relay.pushEvent("ses_a", { type: "session.input.promoted", durable: { aggregateID: "ses_a", seq: 2, version: 1 }, data: { inputID: id } })
      await waitFor(() => context.store.state().view?.messages.find((message) => message.id === id)?.kind === "user" && context.store.state().view?.watermark === 2)
      expect(context.store.state().view?.messages.filter((message) => message.id === id)).toEqual([expect.objectContaining({ text, state: "promoted" })])
      expect(context.relay.requests.filter((request) => request.operation === `session.${kind}`)).toHaveLength(1)
    } finally { pending.resolve("default"); await context.stop() }
  })

  test("keeps a send already in flight when a pending read starts and its acknowledgement arrives first", async () => {
    const pending = gate()
    const admission = gate()
    let hold = false
    const context = await harness((request) => request.operation === "session.pending.list" && hold ? pending.promise
      : request.operation === "session.prompt" ? admission.promise : "default")
    try {
      expect(await context.store.sendPrompt({ text: "Already sending", delivery: "steer" })).toBe(true)
      const id = context.store.state().mutations[0]!.id
      await waitFor(() => context.relay.requests.some((request) => request.operation === "session.prompt"))
      hold = true
      const before = context.relay.requests.filter((request) => request.operation === "session.pending.list").length
      const reload = context.store.reloadMessages()
      await waitFor(() => context.relay.requests.filter((request) => request.operation === "session.pending.list").length > before)
      admission.resolve("default")
      await waitFor(() => context.store.state().mutations.length === 0)
      pending.resolve({ ok: true, value: { data: [] } })
      await reload
      expect(context.store.state().view?.messages.find((message) => message.id === id)).toMatchObject({ text: "Already sending", state: "pending" })
    } finally { pending.resolve("default"); admission.resolve("default"); await context.stop() }
  })

  test("keeps a live admission over an older pending read while removing pending rows already absent at read start", async () => {
    const pending = gate()
    let hold = false
    const context = await harness((request) => request.operation === "session.pending.list" && hold ? pending.promise : "default")
    try {
      context.relay.pushEvent("ses_a", { type: "session.input.admitted", durable: { aggregateID: "ses_a", seq: 1, version: 1 }, data: {
        inputID: "msg_old_pending", input: { type: "user", delivery: "steer", data: { text: "Earlier pending input" } },
      } })
      await waitFor(() => context.store.state().view?.watermark === 1)
      hold = true
      const before = context.relay.requests.filter((request) => request.operation === "session.pending.list").length
      const reload = context.store.reloadMessages()
      await waitFor(() => context.relay.requests.filter((request) => request.operation === "session.pending.list").length > before)
      context.relay.pushEvent("ses_a", { type: "session.input.admitted", durable: { aggregateID: "ses_a", seq: 2, version: 1 }, data: {
        inputID: "msg_live_pending", input: { type: "user", delivery: "queue", data: { text: "New live input" } },
      } })
      await waitFor(() => context.store.state().view?.watermark === 2)
      pending.resolve({ ok: true, value: { data: [] } })
      await reload
      expect(context.store.state().view?.messages.some((message) => message.id === "msg_old_pending")).toBe(false)
      expect(context.store.state().view?.messages.find((message) => message.id === "msg_live_pending")).toMatchObject({ text: "New live input", state: "pending", delivery: "queue" })
    } finally { pending.resolve("default"); await context.stop() }
  })

  test("queued prompt skills travel in one admission without early skill activation or a separate wake", async () => {
    const response = gate()
    const context = await harness((request) => request.operation === "session.prompt" ? response.promise : "default")
    try {
      expect(await context.store.sendPrompt({ text: "Review later", delivery: "queue", skills: ["audit", "test"] })).toBe(true)
      await waitFor(() => context.relay.requests.some((request) => request.operation === "session.prompt"))
      expect(context.relay.requests.filter((request) => request.operation === "session.skill")).toEqual([])
      expect(context.relay.requests.find((request) => request.operation === "session.prompt")?.input).toMatchObject({ text: "Review later", delivery: "queue", skills: ["audit", "test"] })
      response.resolve("default")
      await waitFor(() => context.store.state().mutations.length === 0)
      expect(context.relay.requests.filter((request) => request.operation === "session.prompt")).toHaveLength(1)
    } finally { response.resolve("default"); await context.stop() }
  })

  test("returning to the original device preserves unadmitted text and attachments for explicit same-ID recovery", async () => {
    const upload = gate()
    let delayed = true
    const context = await harness((request) => request.operation === "session.attachment.upload" ? delayed ? upload.promise
      : { ok: true, value: { uri: `ycoding-upload://${String(request.input?.uploadID)}` } } : "default")
    try {
      const files = [{ uri: "data:text/plain;base64,SGk=", name: "note.txt" }]
      await context.store.sendPrompt({ text: "Accepted original", delivery: "steer", files })
      const id = context.store.state().mutations[0]!.id
      await waitFor(() => context.relay.requests.some((request) => request.operation === "session.attachment.upload"))
      context.store.connect("dev_other")
      await waitFor(() => context.store.state().sessions.length > 0)
      await context.store.selectSession("ses_a")
      expect(context.store.state().mutations).toEqual([])
      expect(context.store.state().view?.messages.some((message) => message.id === id)).toBe(false)
      await context.store.retryMutation(id)
      expect(context.relay.requests.filter((request) => request.operation === "session.prompt")).toEqual([])
      context.relay.pushEvent("ses_a", { type: "session.input.admitted", aggregateID: "ses_a", seq: 1, data: {
        inputID: id, input: { type: "user", delivery: "steer", data: { text: "Other device's independent history" } },
      } })
      await waitFor(() => context.store.state().view?.messages.some((message) => message.kind === "user" && message.text === "Other device's independent history") === true)
      context.store.connect("dev_1")
      await waitFor(() => context.store.state().sessions.length > 0)
      await context.store.selectSession("ses_a")
      expect(context.store.state().mutations.find((mutation) => mutation.id === id)).toMatchObject({ state: "failed", input: { text: "Accepted original", files } })
      expect(context.store.state().view?.messages.find((message) => message.id === id)).toMatchObject({ text: "Accepted original", state: "pending" })
      expect(context.relay.requests.filter((request) => request.operation === "session.prompt")).toEqual([])
      delayed = false
      await context.store.retryMutation(id)
      expect(context.relay.requests.find((request) => request.operation === "session.prompt")?.input?.id).toBe(id)
      expect(context.store.state().mutations).toEqual([])
    } finally { upload.resolve("default"); await context.stop() }
  })

  test("accepts two drafts immediately with distinct bubbles and IDs while acknowledgements are delayed", async () => {
    const response = gate()
    const context = await harness((request) => request.operation === "session.prompt" ? response.promise : "default")
    try {
      const accepted: boolean[] = []
      void context.store.sendPrompt({ text: "First", delivery: "steer" }).then((value) => accepted.push(value))
      void context.store.sendPrompt({ text: "Second", delivery: "queue" }).then((value) => accepted.push(value))
      await waitFor(() => accepted.length === 2)
      expect(accepted).toEqual([true, true])
      expect(context.store.state().view?.messages.filter((message) => message.kind === "user").map((message) => message.text)).toEqual(["First", "Second"])
      expect(new Set(context.store.state().mutations.map((mutation) => mutation.id)).size).toBe(2)
      await waitFor(() => context.relay.requests.filter((request) => request.operation === "session.prompt").length === 2)
      expect(context.store.state().mutations.every((mutation) => mutation.phase === "admitting" && mutation.state === "sending")).toBe(true)
      response.resolve("default")
      await waitFor(() => context.store.state().mutations.length === 0)
    } finally { response.resolve("default"); await context.stop() }
  })

  test("accepts before uploads and model selection, and admits the selected skills only after their acknowledgements", async () => {
    const upload = gate()
    const model = gate()
    const admission = gate()
    const context = await harness((request) => {
      if (request.operation === "session.attachment.upload") return upload.promise
      if (request.operation === "session.switchModel") return model.promise
      if (request.operation === "session.prompt") return admission.promise
      return "default"
    })
    try {
      const files = [{ uri: "data:text/plain;base64,SGk=", name: "note.txt" }]
      expect(await context.store.sendPrompt({ text: "Use skill", delivery: "steer", files, model: { id: "next", providerID: "openai" }, skills: ["review"] })).toBe(true)
      const root = context.store.state().mutations[0]
      expect(root).toMatchObject({ kind: "prompt", phase: "preparing", input: { files } })
      expect(context.store.state().view?.messages.at(-1)).toMatchObject({ id: root?.id, text: "Use skill", state: "pending" })
      await waitFor(() => context.relay.requests.some((request) => request.operation === "session.attachment.upload"))
      expect(context.relay.requests.some((request) => request.operation === "session.switchModel")).toBe(false)
      const uploadID = context.relay.requests.find((request) => request.operation === "session.attachment.upload")?.input?.uploadID
      upload.resolve({ ok: true, value: { uri: `ycoding-upload://${String(uploadID)}` } })
      await waitFor(() => context.relay.requests.some((request) => request.operation === "session.switchModel"))
      expect(context.relay.requests.some((request) => request.operation === "session.skill")).toBe(false)
      model.resolve("default")
      await waitFor(() => context.relay.requests.some((request) => request.operation === "session.prompt"))
      expect(context.relay.requests.find((request) => request.operation === "session.prompt")?.input?.skills).toEqual(["review"])
      expect(context.relay.requests.some((request) => request.operation === "session.skill")).toBe(false)
      admission.resolve("default")
      await waitFor(() => context.store.state().mutations.length === 0)
      expect(context.relay.requests.filter((request) => request.operation === "session.prompt")).toHaveLength(1)
      expect(context.relay.requests.filter((request) => request.operation === "session.prompt").every((request) => request.input?.id === root?.id)).toBe(true)
    } finally { upload.resolve("default"); model.resolve("default"); admission.resolve("default"); await context.stop() }
  })

  test("retries a failed admission with stable IDs and selected skills while preserving a newer draft", async () => {
    let fail = true
    const context = await harness((request) => request.operation === "session.prompt" && fail
      ? { ok: false, code: "internal_error", message: "Admission failed" } : "default")
    try {
      expect(await context.store.sendPrompt({ text: "Try skills", delivery: "steer", skills: ["first", "second"] })).toBe(true)
      await waitFor(() => context.store.state().mutations.some((mutation) => mutation.state === "failed"))
      const root = context.store.state().mutations[0]
      expect(root).toMatchObject({ kind: "prompt", phase: "admitting", detail: "Admission failed" })
      context.store.setDraft("ses_a", "Newer draft")
      fail = false
      await context.store.retryMutation(root!.id)
      await waitFor(() => context.store.state().mutations.length === 0)
      expect(context.relay.requests.filter((request) => request.operation === "session.skill")).toEqual([])
      expect(context.relay.requests.filter((request) => request.operation === "session.prompt").map((request) => request.input?.skills)).toEqual([["first", "second"], ["first", "second"]])
      expect(context.relay.requests.filter((request) => request.operation === "session.prompt").every((request) => request.input?.id === root?.id)).toBe(true)
      expect(context.store.state().drafts.ses_a).toBe("Newer draft")
    } finally { await context.stop() }
  })

  test("an admission event before acknowledgement settles the receipt and suppresses a later unknown result", async () => {
    const response = gate()
    const context = await harness((request) => request.operation === "session.prompt" ? response.promise : "default")
    try {
      expect(await context.store.sendPrompt({ text: "Durable first", delivery: "steer" })).toBe(true)
      await waitFor(() => context.relay.requests.some((request) => request.operation === "session.prompt"))
      const id = context.store.state().mutations[0]!.id
      context.relay.pushEvent("ses_a", { type: "session.input.admitted", aggregateID: "ses_a", seq: 1, data: {
        inputID: id, input: { type: "user", delivery: "steer", data: { text: "Durable first" } },
      } })
      await waitFor(() => context.store.state().mutations.length === 0)
      context.relay.dropConnections(1012, "restart")
      await waitFor(() => context.relay.connections === 2 && context.store.state().transport.kind === "open")
      expect(context.store.state().mutations).toEqual([])
      expect(context.store.state().mutationToasts).toEqual([])
      expect(context.relay.requests.filter((request) => request.operation === "session.prompt")).toHaveLength(1)
    } finally { response.resolve("default"); await context.stop() }
  })

  test("reconciles an unknown selected-skill admission without replay or a wake", async () => {
    let close = true
    let admittedID: unknown
    const context = await harness((request) => {
      if (request.operation === "session.prompt" && close) {
        close = false
        admittedID = request.input?.id
        return "close"
      }
      if (request.operation === "session.pending.list" && admittedID) return { ok: true, value: { data: [{
        id: admittedID, sessionID: "ses_a", admittedSeq: 2, timeCreated: 2, type: "user", data: { text: "With skill" }, delivery: "steer",
      }] } }
      return "default"
    })
    try {
      expect(await context.store.sendPrompt({ text: "With skill", delivery: "steer", skills: ["review"] })).toBe(true)
      await waitFor(() => context.relay.connections === 2 && context.store.state().transport.kind === "open")
      await waitFor(() => context.store.state().mutations.length === 0)
      expect(context.relay.requests.filter((request) => request.operation === "session.skill")).toEqual([])
      expect(context.relay.requests.filter((request) => request.operation === "session.prompt")).toHaveLength(1)
    } finally { await context.stop() }
  })

  test("unknown standalone skill activation retries only that skill with its original ID", async () => {
    let close = true
    const context = await harness((request) => {
      if (request.operation === "session.skill" && close) { close = false; return "close" }
      return "default"
    })
    try {
      expect(await context.store.activateSkill("review")).toBe(true)
      await waitFor(() => context.store.state().mutations[0]?.state === "unknown")
      expect(context.relay.requests.some((request) => request.operation === "session.prompt")).toBe(false)
      await waitFor(() => context.relay.connections === 2 && context.store.state().transport.kind === "open")
      const root = context.store.state().mutations[0]!
      await context.store.retryMutation(root.id)
      const skills = context.relay.requests.filter((request) => request.operation === "session.skill")
      expect(skills).toHaveLength(2)
      expect(skills[0]?.input?.id).toBe(skills[1]?.input?.id)
      expect(context.relay.requests.filter((request) => request.operation === "session.prompt")).toEqual([])
    } finally { await context.stop() }
  })

  test("accepts command and standalone skill immediately, with failure owned by their mutations", async () => {
    const response = gate()
    const context = await harness((request) => request.operation === "session.command" || request.operation === "session.skill" ? response.promise : "default")
    try {
      expect(await context.store.runCommand({ command: "build", arguments: "--fast", delivery: "steer" })).toBe(true)
      expect(await context.store.activateSkill("review")).toBe(true)
      await waitFor(() => context.relay.requests.some((request) => request.operation === "session.skill"))
      expect(context.store.state().view?.messages.at(-1)).toMatchObject({ text: "/build --fast", state: "pending" })
      expect(context.store.state().mutations.map((mutation) => mutation.kind)).toEqual(["command", "skill"])
      response.resolve({ ok: false, code: "internal_error", message: "Rejected" })
      await waitFor(() => context.store.state().mutations.every((mutation) => mutation.state === "failed"))
      expect(context.store.state().mutationToasts?.map((toast) => toast.detail)).toEqual(["Rejected", "Rejected"])
    } finally { response.resolve("default"); await context.stop() }
  })

  test("retains failed upload files and a newer draft, and retries without losing either", async () => {
    let fail = true
    const context = await harness((request) => request.operation === "session.attachment.upload" ? fail
      ? { ok: false, code: "invalid_message", message: "Upload failed" }
      : { ok: true, value: { uri: `ycoding-upload://${String(request.input?.uploadID)}` } } : "default")
    try {
      const files = [{ uri: "data:text/plain;base64,SGk=", name: "note.txt" }]
      expect(await context.store.sendPrompt({ text: "Original", delivery: "steer", files })).toBe(true)
      context.store.setDraft("ses_a", "Newer draft")
      await waitFor(() => context.store.state().mutations[0]?.state === "failed")
      const root = context.store.state().mutations[0]!
      expect(root.input.files).toEqual(files)
      expect(context.store.state().drafts.ses_a).toBe("Newer draft")
      expect(context.relay.requests.some((request) => request.operation === "session.prompt")).toBe(false)
      fail = false
      await context.store.retryMutation(root.id)
      expect(context.store.state().drafts.ses_a).toBe("Newer draft")
      expect(context.relay.requests.find((request) => request.operation === "session.prompt")?.input?.id).toBe(root.id)
    } finally { await context.stop() }
  })

  test("stops after an old Session prerequisite acknowledges and cannot mutate the new Session", async () => {
    const model = gate()
    const context = await harness((request) => request.operation === "session.switchModel" ? model.promise : "default")
    try {
      expect(await context.store.sendPrompt({ text: "Old", delivery: "steer", model: { id: "next", providerID: "openai" } })).toBe(true)
      await waitFor(() => context.relay.requests.some((request) => request.operation === "session.switchModel"))
      await context.store.selectSession("ses_b")
      context.store.setDraft("ses_b", "New Session draft")
      model.resolve("default")
      await waitFor(() => context.store.state().mutations[0]?.state === "failed")
      expect(context.relay.requests.some((request) => request.operation === "session.prompt")).toBe(false)
      expect(context.store.state().view?.messages.some((message) => message.id === context.store.state().mutations[0]?.id)).toBe(false)
      expect(context.store.state().drafts.ses_b).toBe("New Session draft")
      await context.store.retryMutation(context.store.state().mutations[0]!.id)
      expect(context.relay.requests.filter((request) => request.operation === "session.switchModel")).toHaveLength(1)
      expect(context.relay.requests.some((request) => request.operation === "session.prompt")).toBe(false)
    } finally { model.resolve("default"); await context.stop() }
  })

  test("device replacement hides old send receipts and does not dispatch their prerequisites on the new machine", async () => {
    const model = gate()
    const context = await harness((request) => request.operation === "session.switchModel" ? model.promise : "default")
    try {
      expect(await context.store.sendPrompt({ text: "Old device", delivery: "steer", model: { id: "next", providerID: "openai" } })).toBe(true)
      await waitFor(() => context.relay.requests.some((request) => request.operation === "session.switchModel"))
      context.store.connect("dev_other")
      await waitFor(() => context.store.state().sessions.length > 0)
      await context.store.selectSession("ses_a")
      model.resolve("default")
      expect(context.store.state().mutations).toEqual([])
      expect(context.store.state().view?.messages.some((message) => message.kind === "user" && message.text === "Old device")).toBe(false)
      expect(context.relay.requests.some((request) => request.operation === "session.prompt")).toBe(false)
    } finally { model.resolve("default"); await context.stop() }
  })

  test("rejects local invalid and offline sends without optimistic messages or mutations", async () => {
    const context = await harness(() => "default")
    try {
      expect(await context.store.sendPrompt({ text: "", delivery: "steer" })).toBe(false)
      expect(await context.store.sendPrompt({ text: "x".repeat(32_768), delivery: "steer" })).toBe(false)
      expect(await context.store.sendPrompt({ text: "Invalid", delivery: "steer", skills: [" "] })).toBe(false)
      expect(await context.store.sendPrompt({ text: "Invalid", delivery: "steer", skills: Array.from({ length: 201 }, () => "audit") })).toBe(false)
      expect(await context.store.runCommand({ command: "", delivery: "steer" })).toBe(false)
      expect(await context.store.activateSkill(" ")).toBe(false)
      context.relay.dropConnections(1012, "offline")
      await waitFor(() => context.store.state().transport.kind !== "open")
      expect(await context.store.sendPrompt({ text: "Offline", delivery: "steer" })).toBe(false)
      expect(await context.store.runCommand({ command: "build", delivery: "steer" })).toBe(false)
      expect(await context.store.activateSkill("review")).toBe(false)
      expect(context.store.state().mutations).toEqual([])
      expect(context.store.state().view?.messages).toEqual([])
    } finally { await context.stop() }
  })

  test("serializes selection changes through admission acknowledgement and restores a later draft's chosen model", async () => {
    const admission = gate()
    const context = await harness((request) => {
      if (request.operation === "session.snapshot") return { ok: true, value: { session: { model: { id: "original", providerID: "openai" } }, messages: [], watermark: { type: "log.synced", aggregateID: request.sessionID, seq: 0 } } }
      if (request.operation === "session.prompt" && request.input?.text === "First model") return admission.promise
      return "default"
    })
    try {
      expect(await context.store.sendPrompt({ text: "First model", delivery: "steer", model: { id: "next", providerID: "openai" } })).toBe(true)
      expect(await context.store.sendPrompt({ text: "Restore original", delivery: "steer", model: { id: "original", providerID: "openai" } })).toBe(true)
      await waitFor(() => context.relay.requests.some((request) => request.operation === "session.prompt"))
      expect(context.relay.requests.filter((request) => request.operation === "session.prompt")).toHaveLength(1)
      admission.resolve("default")
      await waitFor(() => context.store.state().mutations.length === 0)
      expect(context.relay.requests.filter((request) => ["session.switchModel", "session.prompt"].includes(request.operation)).map((request) => [request.operation, request.input?.model ?? request.input?.text])).toEqual([
        ["session.switchModel", { id: "next", providerID: "openai" }], ["session.prompt", "First model"],
        ["session.switchModel", { id: "original", providerID: "openai" }], ["session.prompt", "Restore original"],
      ])
    } finally { admission.resolve("default"); await context.stop() }
  })

  test("a failed model remains the root retry prerequisite and a completed upload is not repeated", async () => {
    let fail = true
    const context = await harness((request) => {
      if (request.operation === "session.attachment.upload") return { ok: true, value: { uri: `ycoding-upload://${String(request.input?.uploadID)}` } }
      if (request.operation === "session.switchModel" && fail) return { ok: false, code: "invalid_message", message: "Model failed" }
      return "default"
    })
    try {
      expect(await context.store.sendPrompt({ text: "Retry model", delivery: "steer", files: [{ uri: "data:text/plain;base64,SGk=" }], model: { id: "next", providerID: "openai" } })).toBe(true)
      await waitFor(() => context.store.state().mutations[0]?.state === "failed")
      const root = context.store.state().mutations[0]!
      await context.store.retryMutation(root.id)
      expect(context.relay.requests.some((request) => request.operation === "session.prompt")).toBe(false)
      fail = false
      await context.store.retryMutation(root.id)
      expect(context.relay.requests.filter((request) => request.operation === "session.attachment.upload")).toHaveLength(1)
      expect(context.relay.requests.filter((request) => request.operation === "session.switchModel")).toHaveLength(3)
      expect(context.relay.requests.find((request) => request.operation === "session.prompt")?.input?.id).toBe(root.id)
    } finally { await context.stop() }
  })

  test("retry reasserts a model changed by an unrelated send while keeping skills in the same prompt", async () => {
    let fail = true
    const context = await harness((request) => request.operation === "session.prompt" && request.input?.text === "Original model" && fail
      ? { ok: false, code: "internal_error", message: "Admission failed" } : "default")
    try {
      await context.store.sendPrompt({ text: "Original model", delivery: "steer", model: { id: "first", providerID: "openai" }, skills: ["first", "second"] })
      await waitFor(() => context.store.state().mutations[0]?.state === "failed")
      const root = context.store.state().mutations[0]!
      await context.store.sendPrompt({ text: "Other model", delivery: "steer", model: { id: "other", providerID: "openai" } })
      await waitFor(() => context.store.state().mutations.length === 1)
      fail = false
      await context.store.retryMutation(root.id)
      expect(context.relay.requests.filter((request) => request.operation === "session.switchModel").map((request) => request.input?.model)).toEqual([
        { id: "first", providerID: "openai" }, { id: "other", providerID: "openai" }, { id: "first", providerID: "openai" },
      ])
      expect(context.relay.requests.filter((request) => request.operation === "session.skill")).toEqual([])
      expect(context.relay.requests.filter((request) => request.operation === "session.prompt" && request.input?.text === "Original model").every((request) => request.input?.id === root.id)).toBe(true)
    } finally { await context.stop() }
  })

  test("retry after agent drift confirms restoration before re-admitting the same prompt and skills", async () => {
    let fail = true
    const restoredAgent = gate()
    let switches = 0
    let agent = "god"
    const context = await harness((request) => {
      if (request.operation === "session.switchAgent") {
        agent = String(request.input?.agent)
        if (++switches === 3) return restoredAgent.promise
      }
      if (request.operation === "session.snapshot") return { ok: true, value: { session: { agent }, messages: [], watermark: { type: "log.synced", aggregateID: request.sessionID, seq: 0 } } }
      if (request.operation === "session.prompt" && request.input?.text === "Original agent" && fail) return { ok: false, code: "internal_error", message: "Admission failed" }
      return "default"
    })
    try {
      await context.store.sendPrompt({ text: "Original agent", delivery: "steer", agent: "reviewer", skills: ["first", "second"] })
      await waitFor(() => context.store.state().mutations[0]?.state === "failed")
      const root = context.store.state().mutations[0]!
      await context.store.sendPrompt({ text: "Other agent", delivery: "steer", agent: "builder" })
      await waitFor(() => context.store.state().mutations.length === 1)
      fail = false
      const retry = context.store.retryMutation(root.id)
      await waitFor(() => switches === 3)
      expect(context.relay.requests.filter((request) => request.operation === "session.switchAgent").map((request) => request.input?.agent)).toEqual(["reviewer", "builder", "reviewer"])
      expect(context.relay.requests.filter((request) => request.operation === "session.prompt" && request.input?.text === "Original agent")).toHaveLength(1)
      restoredAgent.resolve("close")
      await retry
      await waitFor(() => context.relay.connections === 2 && context.store.state().transport.kind === "open")
      expect(context.store.state().mutations[0]?.state).toBe("unknown")
      await context.store.retryMutation(root.id)
      expect(context.relay.requests.filter((request) => request.operation === "session.skill")).toEqual([])
      expect(context.relay.requests.filter((request) => request.operation === "session.prompt" && request.input?.text === "Original agent").map((request) => request.input?.id)).toEqual([root.id, root.id])
    } finally { restoredAgent.resolve("default"); await context.stop() }
  })

  test("a following prompt cannot execute ahead of an unacknowledged standalone skill activation", async () => {
    const skill = gate()
    const context = await harness((request) => request.operation === "session.skill" ? skill.promise : "default")
    try {
      expect(await context.store.activateSkill("review")).toBe(true)
      expect(await context.store.sendPrompt({ text: "Following", delivery: "steer" })).toBe(true)
      await waitFor(() => context.relay.requests.some((request) => request.operation === "session.skill"))
      expect(context.relay.requests.some((request) => request.operation === "session.prompt")).toBe(false)
      skill.resolve("default")
      await waitFor(() => context.store.state().mutations.length === 0)
      expect(context.relay.requests.filter((request) => request.operation === "session.prompt")).toHaveLength(1)
    } finally { skill.resolve("default"); await context.stop() }
  })

  test("retry restores attachment references lost with the connection while preserving selected skills", async () => {
    let close = true
    const uploads = new Set<string>()
    const context = await harness((request) => {
      if (request.operation === "session.attachment.upload") {
        const uri = `ycoding-upload://${String(request.input?.uploadID)}`
        uploads.add(uri)
        return { ok: true, value: { uri } }
      }
      if (request.operation === "session.prompt" && close) { close = false; uploads.clear(); return "close" }
      if (request.operation === "session.prompt" && Array.isArray(request.input?.files) && !uploads.has(request.input.files[0]?.uri))
        return { ok: false, code: "invalid_message", message: "Attachment upload is unavailable or incomplete" }
      return "default"
    })
    try {
      await context.store.sendPrompt({ text: "Recover attachments", delivery: "steer", files: [{ uri: "data:text/plain;base64,SGk=" }], skills: ["review"] })
      await waitFor(() => context.store.state().mutations[0]?.state === "unknown")
      const root = context.store.state().mutations[0]!
      await waitFor(() => context.relay.connections === 2 && context.store.state().transport.kind === "open")
      await context.store.retryMutation(root.id)
      expect(context.store.state().mutations).toEqual([])
      expect(context.relay.requests.filter((request) => request.operation === "session.attachment.upload")).toHaveLength(2)
      expect(context.relay.requests.filter((request) => request.operation === "session.skill")).toEqual([])
      expect(context.relay.requests.filter((request) => request.operation === "session.prompt").map((request) => request.input?.id)).toEqual([root.id, root.id])
    } finally { await context.stop() }
  })

  test("retry refreshes expired attachment references while preserving selected skills", async () => {
    let time = 1_000
    let fail = true
    const context = await harness((request) => {
      if (request.operation === "session.attachment.upload") return { ok: true, value: { uri: `ycoding-upload://${String(request.input?.uploadID)}` } }
      if (request.operation === "session.prompt" && fail) return { ok: false, code: "internal_error", message: "Admission failed" }
      return "default"
    }, () => time)
    try {
      await context.store.sendPrompt({ text: "Expired attachments", delivery: "steer", files: [{ uri: "data:text/plain;base64,SGk=" }], skills: ["first", "second"] })
      await waitFor(() => context.store.state().mutations[0]?.state === "failed")
      const root = context.store.state().mutations[0]!
      time += RemoteLimits.attachmentTtlMs
      fail = false
      await context.store.retryMutation(root.id)
      expect(context.relay.requests.filter((request) => request.operation === "session.attachment.upload")).toHaveLength(2)
      expect(context.relay.requests.filter((request) => request.operation === "session.skill")).toEqual([])
      expect(context.store.state().mutations).toEqual([])
    } finally { await context.stop() }
  })

  test("parallel production message IDs remain unique when sends share a clock tick and random sample", async () => {
    const response = gate()
    const context = await harness((request) => request.operation === "session.prompt" ? response.promise : "default", undefined, false)
    try {
      const clock = spyOn(Date, "now").mockReturnValue(1_000)
      const random = spyOn(Math, "random").mockReturnValue(0)
      const first = context.store.sendPrompt({ text: "First", delivery: "steer" })
      const second = context.store.sendPrompt({ text: "Second", delivery: "steer" })
      clock.mockRestore()
      random.mockRestore()
      expect(await Promise.all([first, second])).toEqual([true, true])
      expect(new Set(context.store.state().mutations.map((mutation) => mutation.id)).size).toBe(2)
      response.resolve("default")
      await waitFor(() => context.store.state().mutations.length === 0)
    } finally { response.resolve("default"); await context.stop() }
  })

  test.each(["dismiss", "logout"] as const)("%s clears an accepted record retained on another device", async (action) => {
    const context = await harness((request) => request.operation === "session.attachment.upload"
      ? { ok: false, code: "invalid_message", message: "Upload failed" } : "default")
    try {
      await context.store.sendPrompt({ text: "Retained until discarded", delivery: "steer", files: [{ uri: "data:text/plain;base64,SGk=" }] })
      await waitFor(() => context.store.state().mutations[0]?.state === "failed")
      const id = context.store.state().mutations[0]!.id
      context.store.connect("dev_other")
      await waitFor(() => context.store.state().sessions.length > 0)
      await context.store.selectSession("ses_a")
      if (action === "dismiss") context.store.dismissMutation(id)
      if (action === "logout") await context.store.logout()
      context.store.connect("dev_1")
      await waitFor(() => context.store.state().sessions.length > 0)
      await context.store.selectSession("ses_a")
      expect(context.store.state().mutations.find((mutation) => mutation.id === id)).toBeUndefined()
      expect(context.store.state().view?.messages.find((message) => message.id === id)).toBeUndefined()
      expect(context.relay.requests.filter((request) => request.operation === "session.prompt")).toEqual([])
    } finally { await context.stop() }
  })

  test("disposal clears accepted records before a delayed upload settles", async () => {
    const upload = gate()
    const context = await harness((request) => request.operation === "session.attachment.upload" ? upload.promise : "default")
    try {
      await context.store.sendPrompt({ text: "Dispose safely", delivery: "steer", files: [{ uri: "data:text/plain;base64,SGk=" }] })
      await waitFor(() => context.relay.requests.some((request) => request.operation === "session.attachment.upload"))
      context.store.dispose()
      upload.resolve("default")
      await waitFor(() => context.store.state().upload === undefined)
      expect(context.store.state().mutations).toEqual([])
      expect(context.store.state().mutationToasts).toEqual([])
      expect(context.relay.requests.filter((request) => request.operation === "session.prompt")).toEqual([])
    } finally { upload.resolve("default"); await context.stop() }
  })
})
