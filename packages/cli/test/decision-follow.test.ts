import { expect, test } from "bun:test"
import { ClientError, YCoding } from "@ycoding-ai/client/promise"
import { followFamily, type FollowClient, type FollowEvent, type FollowReceipt } from "../src/commands/handlers/decision/follow"
import { type FollowState, type FollowRequest, validateFollowState } from "../src/commands/handlers/decision/follow-state"

const initial = (): FollowState => ({ version: 1, rootSessionID: "ses_root", server: "a".repeat(64), cursors: [], pending: [], seen: [], requestSeen: [], terminalSeen: [] })

function queue(signal: AbortSignal) {
  const values: FollowEvent[] = []
  let notify: (() => void) | undefined
  let ended = signal.aborted
  let active = 0
  let failure: unknown
  const idleWaiters: (() => void)[] = []
  const end = () => { ended = true; notify?.() }
  signal.addEventListener("abort", end, { once: true })
  return { push(value: FollowEvent) { values.push(value); notify?.() }, end, fail(error: unknown) { failure = error; end() },
    idle() { return new Promise<void>((resolve) => { if (!values.length && notify !== undefined) resolve(); else idleWaiters.push(resolve) }) },
    get active() { return active }, async *stream() {
    active++
    try {
      while (!ended) {
        if (values.length) yield values.shift()!
        else await new Promise<void>((resolve) => { notify = resolve; for (const waiter of idleWaiters.splice(0)) waiter() })
      }
      if (failure !== undefined) throw failure
    } finally { active--; signal.removeEventListener("abort", end) }
  } }
}

function fixture(state = initial()) {
  const controller = new AbortController()
  let global: ReturnType<typeof queue>
  const streams: ReturnType<typeof queue>[] = []
  const logs = new Map<string, ReturnType<typeof queue>>()
  const history = new Map<string, FollowEvent[]>([["ses_root", []]])
  const children: string[] = []
  const receipts: FollowReceipt[] = []
  let pending: FollowRequest[] = []
  let epoch = "epoch_one"
  let failRead = false
  let failLog = false
  let failGlobal = false
  let saved = structuredClone(state)
  const reads = { global: 0, log: 0, active: 0, list: 0, snapshot: 0, pending: 0 }
  const faults: { global?: number; log?: number; snapshot?: number; pending?: number; handshake?: boolean; error?: ClientError } = {}
  const reject = (name: "global" | "log" | "snapshot" | "pending") => {
    if ((faults[name] ?? 0) > 0) { faults[name]!--; throw faults.error ?? new ClientError("Transport") }
  }
  const waiters: { predicate: (receipt: FollowReceipt) => boolean; resolve(receipt: FollowReceipt): void }[] = []
  const client: FollowClient = {
    event: { subscribe({ signal }) {
      reads.global++
      reject("global")
      if (faults.handshake) return (async function* () { yield { type: "server.connected", sourceEpoch: epoch }; throw new ClientError("Transport") })()
      global = queue(signal)
      streams.push(global)
      global.push({ type: "server.connected", sourceEpoch: epoch })
      const current = global
      return (async function* () { yield* current.stream(); if (failGlobal) throw new Error("synthetic genuine global failure after abort") })()
    } },
    decision: { async list({ signal }) { reads.pending++; reject("pending"); if (failRead) throw new Error("synthetic genuine read failure"); if (signal.aborted) throw signal.reason; return pending } },
    session: {
      async get({ sessionID }) { return { id: sessionID } },
      async active() { reads.active++; return {} },
      async list({ parentID }) { reads.list++; return { data: parentID === "ses_root" ? children.map((id) => ({ id, parentID })) : [], cursor: {} } },
      async snapshot({ sessionID }) { reads.snapshot++; reject("snapshot"); return { sourceEpoch: epoch, watermark: { seq: history.get(sessionID)?.at(-1)?.durable?.seq } } },
      log({ sessionID, after }, { signal }) {
        reads.log++
        reject("log")
        const current = queue(signal)
        logs.set(sessionID, current)
        streams.push(current)
        for (const event of history.get(sessionID) ?? []) if (after === undefined || (event.durable?.seq ?? 0) > after) current.push(event)
        current.push({ type: "log.synced", sourceEpoch: epoch, aggregateID: sessionID, seq: history.get(sessionID)?.at(-1)?.durable?.seq })
        return (async function* () { yield* current.stream(); if (failLog) throw new Error("synthetic genuine log failure") })()
      },
    },
  }
  const emit = async (receipt: FollowReceipt) => {
    receipts.push(receipt)
    for (const waiter of [...waiters]) if (waiter.predicate(receipt)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(receipt) }
  }
  const wait = (predicate: (receipt: FollowReceipt) => boolean) => {
    const found = receipts.find(predicate)
    if (found) return Promise.resolve(found)
    return new Promise<FollowReceipt>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Expected follow receipt")), 1500)
      waiters.push({ predicate, resolve(receipt) { clearTimeout(timer); resolve(receipt) } })
    })
  }
  const append = (sessionID: string, seq: number, type: string): FollowEvent => {
    const event = { id: `evt_${sessionID}_${seq}`, sourceEpoch: epoch, type, durable: { aggregateID: sessionID, seq }, data: { sessionID, secret: "NEVER-OUTPUT" } }
    history.set(sessionID, [...(history.get(sessionID) ?? []), event])
    logs.get(sessionID)?.push(event)
    return event
  }
  return { client, controller, children, history, receipts, logs, append, wait, emit, reads, faults, get global() { return global! }, streams,
    setPending(value: FollowRequest[]) { pending = value }, setEpoch(value: string) { epoch = value }, failRead() { failRead = true }, failLog() { failLog = true }, failGlobal() { failGlobal = true },
    get saved() { return saved },
    run(overrides: { emit?: (receipt: FollowReceipt) => Promise<void>; save?: (value: FollowState) => Promise<void>; heartbeatSeconds?: number } = {}) {
      return followFamily(client, { state, signal: controller.signal, heartbeatSeconds: overrides.heartbeatSeconds ?? 3600,
        save: async (value) => { await overrides.save?.(value); saved = structuredClone(validateFollowState(value, state.rootSessionID, state.server)) }, emit: overrides.emit ?? emit })
    } }
}

for (const kind of ["permission", "guardrail", "question", "form"] as const) {
  test(`follow observes exact ${kind} request and reply categories and remains armed through completion`, async () => {
    const f = fixture()
    const run = f.run()
    try {
      await f.wait((receipt) => receipt.kind === "ready")
      const request = { kind, sessionID: "ses_root", id: `${kind}_synthetic` }
      f.setPending([request])
      f.global.push({ type: kind === "form" ? "form.created" : `${kind}.asked`, sourceEpoch: "epoch_one", data: kind === "form" ? { form: { ...request, secret: "NEVER-OUTPUT" } } : { ...request, secret: "NEVER-OUTPUT" } })
      expect(await f.wait((receipt) => receipt.kind === "request-observed")).toEqual({ kind: "request-observed", sessionID: "ses_root", id: request.id, requestKind: kind, resolution: "unknown" })
      f.setPending([])
      f.global.push({ type: `${kind}.replied`, sourceEpoch: "epoch_one", data: { sessionID: "ses_root", ...(kind === "form" ? { id: request.id } : { requestID: request.id }), answer: "NEVER-OUTPUT" } })
      expect(await f.wait((receipt) => receipt.kind === "reply-observed")).toEqual({ kind: "reply-observed", sessionID: "ses_root", id: request.id, requestKind: kind, resolution: "reply-observed" })
      f.append("ses_root", 1, "session.execution.succeeded")
      await f.wait((receipt) => receipt.kind === "durable" && receipt.seq === 1)
      f.append("ses_root", 2, "session.work.completed")
      await f.wait((receipt) => receipt.kind === "durable" && receipt.seq === 2)
      f.append("ses_root", 3, "session.input.admitted")
      await f.wait((receipt) => receipt.kind === "durable" && receipt.seq === 3)
      expect(JSON.stringify(f.receipts)).not.toContain("NEVER-OUTPUT")
    } finally { f.controller.abort(); await run }
    expect(f.streams.every((stream) => stream.active === 0)).toBe(true)
    expect(f.saved.pending).toEqual([])
    expect(f.saved.requestSeen).toEqual([`${kind}\0ses_root\0${kind}_synthetic`])
    expect(f.saved.terminalSeen).toEqual(f.saved.requestSeen)
  })
}

test("follow discovers a dynamic child and replays its short-lived terminal exactly once", async () => {
  const f = fixture()
  const run = f.run()
  try {
    await f.wait((receipt) => receipt.kind === "ready")
    f.children.push("ses_child")
    const event = f.append("ses_child", 1, "session.execution.interrupted")
    f.global.push({ type: "session.created", sourceEpoch: "epoch_one", data: { sessionID: "ses_child", parentID: "ses_root" } })
    await f.wait((receipt) => receipt.kind === "durable" && receipt.sessionID === "ses_child")
    f.logs.get("ses_child")!.push(event)
    f.append("ses_root", 1, "session.step.ended")
    await f.wait((receipt) => receipt.kind === "durable" && receipt.sessionID === "ses_root")
    expect(f.receipts.filter((receipt) => receipt.sessionID === "ses_child")).toHaveLength(1)
  } finally { f.controller.abort(); await run }
})

test("follow restores pending and all dedup ledgers without duplicate callbacks", async () => {
  const state = initial()
  state.sourceEpoch = "epoch_one"
  state.cursors = [{ sessionID: "ses_root", after: 1 }]
  state.pending = [{ kind: "permission", sessionID: "ses_root", id: "per_synthetic" }]
  state.requestSeen = ["permission\0ses_root\0per_synthetic"]
  state.terminalSeen = ["form\0ses_root\0frm_synthetic"]
  state.seen = [`ses_root\0evt_ses_root_1\0${1}`]
  const f = fixture(state)
  f.append("ses_root", 1, "session.execution.succeeded")
  f.setPending(state.pending)
  const run = f.run()
  try {
    await f.wait((receipt) => receipt.kind === "ready")
    f.global.push({ type: "permission.asked", sourceEpoch: "epoch_one", data: { sessionID: "ses_root", id: "per_synthetic" } })
    f.global.push({ type: "form.replied", sourceEpoch: "epoch_one", data: { sessionID: "ses_root", id: "frm_synthetic" } })
    f.append("ses_root", 2, "session.input.admitted")
    await f.wait((receipt) => receipt.kind === "durable")
    expect(f.receipts.filter((receipt) => receipt.requestKind !== undefined)).toEqual([])
  } finally { f.controller.abort(); await run }
  expect(f.saved.requestSeen).toEqual(state.requestSeen)
  expect(f.saved.terminalSeen).toEqual(state.terminalSeen)
})

for (const mode of ["ahead", "epoch", "decision-error", "log-error"] as const) {
  test(`follow fails closed for ${mode} and cleans up streams`, async () => {
    const state = initial()
    if (mode === "ahead" || mode === "epoch") {
      state.sourceEpoch = mode === "epoch" ? "old_epoch" : "epoch_one"
      state.cursors = [{ sessionID: "ses_root", after: 1 }]
    }
    const f = fixture(state)
    if (mode === "decision-error") f.failRead()
    const run = f.run()
    run.catch(() => undefined)
    if (mode === "log-error") {
      await f.wait((receipt) => receipt.kind === "ready")
      f.failLog()
      f.logs.get("ses_root")!.end()
    }
    await expect(run).rejects.toThrow(mode === "ahead" ? /ahead/ : mode === "epoch" ? /epoch/ : /genuine/)
    expect(f.streams.every((stream) => stream.active === 0)).toBe(true)
  })
}

test("follow reconnects a finite global stream without duplicating durable events", async () => {
  const f = fixture()
  const run = f.run()
  try {
    await f.wait((receipt) => receipt.kind === "ready")
    f.append("ses_root", 1, "session.execution.failed")
    await f.wait((receipt) => receipt.kind === "durable")
    f.global.end()
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Reconnect missing")), 1500)
      const check = () => { if (f.receipts.filter((receipt) => receipt.kind === "ready").length === 2) { clearTimeout(timeout); resolve() } else setTimeout(check, 10) }
      check()
    })
    f.append("ses_root", 2, "session.input.admitted")
    await f.wait((receipt) => receipt.seq === 2)
    expect(f.receipts.filter((receipt) => receipt.seq === 1)).toHaveLength(1)
  } finally { f.controller.abort(); await run }
})

test("follow reports review-box pending and disappearance without inventing a reply", async () => {
  const f = fixture()
  f.setPending([{ kind: "review", sessionID: "ses_root", id: "rev_synthetic" }])
  const run = f.run()
  try {
    expect(await f.wait((receipt) => receipt.kind === "pending")).toEqual({ kind: "pending", requestKind: "review", sessionID: "ses_root", id: "rev_synthetic" })
    f.setPending([])
    f.append("ses_root", 1, "session.review.decided")
    expect(await f.wait((receipt) => receipt.kind === "no-longer-pending")).toEqual({ kind: "no-longer-pending", requestKind: "review", sessionID: "ses_root", id: "rev_synthetic", resolution: "unknown" })
    expect(f.receipts.some((receipt) => receipt.kind === "reply-observed")).toBe(false)
  } finally { f.controller.abort(); await run }
})

test("follow fences stale global and log epochs and retains active request identities", async () => {
  const f = fixture()
  const run = f.run()
  try {
    await f.wait((receipt) => receipt.kind === "ready")
    f.global.push({ type: "permission.asked", sourceEpoch: "old_epoch", data: { sessionID: "ses_root", id: "per_stale" } })
    f.logs.get("ses_root")!.push({ type: "session.execution.failed", id: "evt_stale", sourceEpoch: "old_epoch", durable: { aggregateID: "ses_root", seq: 1 } })
    f.append("ses_root", 1, "session.input.admitted")
    await f.wait((receipt) => receipt.kind === "durable")
    expect(JSON.stringify(f.receipts)).not.toContain("stale")
    expect(f.saved.requestSeen).toEqual([])
  } finally { f.controller.abort(); await run }
})

for (const genuine of [false, true]) {
  test(`follow cancellation during a pending read ${genuine ? "preserves a genuine error" : "recognizes its own abort"}`, async () => {
    const f = fixture()
    let entered: () => void = () => undefined
    const reading = new Promise<void>((resolve) => { entered = resolve })
    f.client.decision.list = ({ signal }) => new Promise((_, reject) => {
      entered()
      signal.addEventListener("abort", () => reject(genuine ? new Error("synthetic genuine read failure after abort") : signal.reason), { once: true })
    })
    const run = f.run()
    run.catch(() => undefined)
    await reading
    f.controller.abort()
    if (genuine) await expect(run).rejects.toThrow(/genuine/)
    else await run
    expect(f.streams.every((stream) => stream.active === 0)).toBe(true)
  })
}

test("follow rejects a non-root without subscribing or persisting observer output", async () => {
  const f = fixture()
  f.client.session.get = async () => ({ id: "ses_root", parentID: "ses_parent" })
  await expect(f.run()).rejects.toThrow(/root Session/)
  expect(f.streams).toHaveLength(0)
  expect(f.receipts).toHaveLength(0)
})

test("follow validates all restored descendant cursors before callbacks or replacement state", async () => {
  const state = initial()
  state.sourceEpoch = "epoch_one"
  state.cursors = [{ sessionID: "ses_root", after: 0 }, { sessionID: "ses_child", after: 2 }]
  const f = fixture(state)
  f.children.push("ses_child")
  f.append("ses_root", 0, "session.execution.succeeded")
  f.append("ses_child", 1, "session.execution.failed")
  await expect(f.run()).rejects.toThrow(/ahead/)
  expect(f.receipts).toEqual([])
  expect(f.saved).toEqual(state)
  expect(f.streams.every((stream) => stream.active === 0)).toBe(true)
})

test("follow cancellation does not swallow a genuine in-flight global read error", async () => {
  const f = fixture()
  const run = f.run()
  run.catch(() => undefined)
  await f.wait((receipt) => receipt.kind === "ready")
  f.failGlobal()
  f.controller.abort()
  await expect(run).rejects.toThrow(/genuine global/)
})

for (const kind of ["ready", "request-observed", "reply-observed", "durable", "heartbeat", "closed"] as const) {
  test(`follow emission-first rejects ${kind} output without committing its checkpoint or ledgers`, async () => {
    const f = fixture()
    let before = initial()
    const run = f.run({ heartbeatSeconds: 1, emit: async (receipt) => {
      if (receipt.kind === kind) throw new Error("synthetic output failure")
      await f.emit(receipt)
    } })
    run.catch(() => undefined)
    if (kind !== "ready") {
      await f.wait((receipt) => receipt.kind === "ready")
      if (kind === "reply-observed") {
        f.setPending([{ kind: "permission", sessionID: "ses_root", id: "per_synthetic" }])
        f.global.push({ type: "permission.asked", sourceEpoch: "epoch_one", data: { sessionID: "ses_root", id: "per_synthetic" } })
        await f.wait((receipt) => receipt.kind === "request-observed")
      }
      before = { ...initial(), sourceEpoch: "epoch_one", cursors: [{ sessionID: "ses_root" }] }
      if (kind === "reply-observed") {
        before.pending = [{ kind: "permission", sessionID: "ses_root", id: "per_synthetic" }]
        before.requestSeen = ["permission\0ses_root\0per_synthetic"]
      }
      if (kind === "request-observed") f.global.push({ type: "permission.asked", sourceEpoch: "epoch_one", data: { sessionID: "ses_root", id: "per_synthetic" } })
      if (kind === "reply-observed") f.global.push({ type: "permission.replied", sourceEpoch: "epoch_one", data: { sessionID: "ses_root", requestID: "per_synthetic" } })
      if (kind === "durable") f.append("ses_root", 1, "session.execution.succeeded")
      if (kind === "closed") f.controller.abort()
    }
    await expect(run).rejects.toThrow(/output failure/)
    expect(f.saved).toEqual(before)
    expect(f.streams.every((stream) => stream.active === 0)).toBe(true)
  })
}

test("follow emission-first cannot persist a later pending identity before its output", async () => {
  const f = fixture()
  f.setPending([{ kind: "permission", sessionID: "ses_root", id: "per_first" }, { kind: "form", sessionID: "ses_root", id: "frm_later" }])
  const run = f.run({ emit: async (receipt) => {
    if (receipt.id === "frm_later") throw new Error("synthetic later output failure")
    await f.emit(receipt)
  } })
  await expect(run).rejects.toThrow(/later output failure/)
  expect(f.receipts.filter((receipt) => receipt.kind === "pending").map((receipt) => receipt.id)).toEqual(["per_first"])
  expect(f.saved.pending).toEqual([{ kind: "permission", sessionID: "ses_root", id: "per_first" }])
  expect(f.saved.requestSeen).toEqual(["permission\0ses_root\0per_first"])
})

test("follow emission-first replays a stable event identity when saving fails after output", async () => {
  const f = fixture()
  const run = f.run({ save: async (value) => { if (value.cursors.some((cursor) => cursor.after === 1)) throw new Error("synthetic save failure") } })
  run.catch(() => undefined)
  await f.wait((receipt) => receipt.kind === "ready")
  f.append("ses_root", 1, "session.execution.succeeded")
  await expect(run).rejects.toThrow(/save failure/)
  const delivered = f.receipts.find((receipt) => receipt.kind === "durable")
  if (!delivered) throw new Error("Missing emitted durable receipt")
  expect(delivered).toMatchObject({ id: "evt_ses_root_1", sessionID: "ses_root", seq: 1 })
  expect(f.saved.seen).toEqual([])
  const resumed = fixture(f.saved)
  resumed.append("ses_root", 1, "session.execution.succeeded")
  const following = resumed.run()
  try { expect(await resumed.wait((receipt) => receipt.kind === "durable")).toEqual(delivered) }
  finally { resumed.controller.abort(); await following }
})

test("follow irrelevant durable traffic does not exhaust the material dedup budget or end observation", async () => {
  const f = fixture()
  const run = f.run()
  try {
    await f.wait((receipt) => receipt.kind === "ready")
    for (let seq = 1; seq <= 8193; seq++) f.append("ses_root", seq, "session.agent.selected")
    f.append("ses_root", 8194, "session.execution.succeeded")
    expect(await f.wait((receipt) => receipt.kind === "durable")).toMatchObject({ id: "evt_ses_root_8194", seq: 8194 })
  } finally { f.controller.abort(); await run }
  expect(f.saved.seen).toEqual([])
  expect(f.saved.cursors).toEqual([{ sessionID: "ses_root", after: 8194 }])
})

test("follow recovery compacts only delivered identities covered by acknowledged cursors", async () => {
  const state = initial()
  state.sourceEpoch = "epoch_one"
  state.cursors = [{ sessionID: "ses_root", after: 8191 }]
  state.seen = Array.from({ length: 8192 }, (_, seq) => ["ses_root", `evt_prior_${seq}`, String(seq)].join("\0"))
  const f = fixture(state)
  f.append("ses_root", 8192, "session.execution.succeeded")
  const run = f.run()
  try { await f.wait((receipt) => receipt.kind === "durable") }
  finally { f.controller.abort(); await run }
  expect(f.saved.seen).toEqual([])
  expect(f.saved.cursors).toEqual([{ sessionID: "ses_root", after: 8192 }])
})

test("follow emission-first replays a stable current request identity after saving fails", async () => {
  const f = fixture()
  const request = { kind: "permission", sessionID: "ses_root", id: "per_synthetic" }
  f.setPending([request])
  await expect(f.run({ save: async (value) => { if (value.requestSeen.length) throw new Error("synthetic request save failure") } })).rejects.toThrow(/request save failure/)
  const delivered = f.receipts.find((receipt) => receipt.kind === "pending")
  if (!delivered) throw new Error("Missing emitted pending receipt")
  expect(delivered).toMatchObject({ requestKind: "permission", sessionID: "ses_root", id: "per_synthetic" })
  expect(f.saved).toEqual(initial())
  const resumed = fixture(f.saved)
  resumed.setPending([request])
  const following = resumed.run()
  try { expect(await resumed.wait((receipt) => receipt.kind === "pending")).toEqual(delivered) }
  finally { resumed.controller.abort(); await following }
})

for (const kind of ["ready", "heartbeat", "closed"] as const) {
  test(`follow emission-first propagates ${kind} checkpoint failure after output`, async () => {
    const f = fixture()
    let lastKind: string | undefined
    const run = f.run({ heartbeatSeconds: 1, emit: async (receipt) => { lastKind = receipt.kind; await f.emit(receipt) },
      save: async () => { if (lastKind === kind) throw new Error("synthetic lifecycle save failure") } })
    run.catch(() => undefined)
    if (kind !== "ready") await f.wait((receipt) => receipt.kind === "ready")
    if (kind === "closed") f.controller.abort()
    await expect(run).rejects.toThrow(/lifecycle save failure/)
    expect(f.receipts.some((receipt) => receipt.kind === kind)).toBe(true)
    expect(f.receipts.filter((receipt) => receipt.kind === "closed")).toHaveLength(kind === "closed" ? 1 : 0)
  })
}

for (const source of ["global", "log", "snapshot", "pending"] as const) {
  test(`follow recovery retries native Transport ${source} refusal then observes material progress`, async () => {
    const f = fixture()
    f.faults[source] = 2
    const run = f.run()
    run.catch(() => undefined)
    try {
      await f.wait((receipt) => receipt.kind === "ready")
      f.append("ses_root", 1, "session.execution.started")
      await f.wait((receipt) => receipt.kind === "durable")
    } finally { f.controller.abort(); await run }
    expect(f.streams.every((stream) => stream.active === 0)).toBe(true)
  })
}

for (const source of ["global", "log"] as const) {
  test(`follow recovery replays missed material after native Transport ${source} read drop`, async () => {
    const f = fixture()
    const run = f.run()
    run.catch(() => undefined)
    try {
      await f.wait((receipt) => receipt.kind === "ready")
      f.append("ses_root", 1, "session.execution.started")
      await f.wait((receipt) => receipt.seq === 1)
      const old = source === "global" ? f.global : f.logs.get("ses_root")!
      old.fail(new ClientError("Transport"))
      f.append("ses_root", 4, "session.execution.failed")
      await f.wait((receipt) => receipt.seq === 4)
    } finally { f.controller.abort(); await run }
    expect(f.receipts.filter((receipt) => receipt.seq === 1)).toHaveLength(1)
    expect(f.receipts.filter((receipt) => receipt.seq === 4)).toHaveLength(1)
    expect(f.saved.cursors).toEqual([{ sessionID: "ses_root", after: 4 }])
  })
}

test("follow recovery allows recurring healthy global recovery without lifetime exhaustion", async () => {
  const f = fixture()
  const run = f.run()
  run.catch(() => undefined)
  try {
    await f.wait((receipt) => receipt.kind === "ready")
    for (let index = 1; index <= 12; index++) {
      f.global.push({ type: "permission.asked", sourceEpoch: "epoch_one", data: { sessionID: "ses_root", id: `per_${index}` } })
      await f.wait((receipt) => receipt.id === `per_${index}`)
      f.global.fail(new ClientError("Transport"))
      f.append("ses_root", index, "session.input.admitted")
      await f.wait((receipt) => receipt.seq === index)
      await f.wait((receipt) => receipt.kind === "ready" && f.reads.global > index)
    }
  } finally { f.controller.abort(); await run }
  expect(f.reads.global).toBeGreaterThan(10)
}, 20_000)

for (const source of ["global", "log", "snapshot", "pending"] as const) {
  test(`follow recovery exhausts consecutive unhealthy ${source} refusals and releases streams`, async () => {
    const f = fixture()
    f.faults[source] = 10
    await expect(f.run()).rejects.toThrow(/budget-exhausted/)
    expect(f.streams.every((stream) => stream.active === 0)).toBe(true)
  }, 30_000)
}

for (const reason of ["UnexpectedStatus", "MalformedResponse", "UnsupportedContentType", "SseEventTooLarge"] as const) {
  test(`follow recovery never retries native ${reason} failures`, async () => {
    const f = fixture()
    f.faults.global = 1
    f.faults.error = new ClientError(reason)
    await expect(f.run()).rejects.toThrow(reason)
    expect(f.reads.global).toBe(1)
  })
}

test("follow recovery handles more than 8192 acknowledged material events using monotonic cursors", async () => {
  const f = fixture()
  let acknowledged = 0
  const run = f.run({ emit: async (receipt) => { if (receipt.seq !== undefined) acknowledged = receipt.seq; await f.emit(receipt) },
    save: async (value) => {
      expect(value.cursors.find((cursor) => cursor.sessionID === "ses_root")?.after ?? 0).toBeLessThanOrEqual(acknowledged)
      expect(value.seen).toEqual([])
    } })
  try {
    await f.wait((receipt) => receipt.kind === "ready")
    for (let seq = 1; seq <= 8194; seq++) f.append("ses_root", seq * 3, "session.step.ended")
    await f.wait((receipt) => receipt.seq === 8194 * 3)
  } finally { f.controller.abort(); await run }
  expect(f.saved.cursors).toEqual([{ sessionID: "ses_root", after: 8194 * 3 }])
}, 20_000)

test("follow recovery preserves ahead delivered IDs until gap-tolerant acknowledged replay reaches them", async () => {
  const state = initial()
  state.sourceEpoch = "epoch_one"
  state.cursors = [{ sessionID: "ses_root", after: 2 }]
  state.seen = [["ses_root", "evt_ses_root_11", "11"].join("\0")]
  const f = fixture(state)
  f.append("ses_root", 7, "session.execution.started")
  f.append("ses_root", 11, "session.execution.succeeded")
  f.append("ses_root", 15, "session.work.completed")
  const run = f.run({ save: async (value) => {
    const after = value.cursors[0]?.after ?? 0
    expect(value.seen.includes(state.seen[0]!)).toBe(after < 11)
  } })
  try { await f.wait((receipt) => receipt.seq === 15) }
  finally { f.controller.abort(); await run }
  expect(f.receipts.filter((receipt) => receipt.kind === "durable").map((receipt) => receipt.seq)).toEqual([7, 15])
  expect(f.saved.cursors).toEqual([{ sessionID: "ses_root", after: 15 }])
})

test("follow recovery healthy events and heartbeat never poll native state", async () => {
  const f = fixture()
  const run = f.run({ heartbeatSeconds: 1 })
  try {
    await f.wait((receipt) => receipt.kind === "ready")
    const baseline = { ...f.reads }
    f.global.push({ type: "session.status", sourceEpoch: "epoch_one", data: { sessionID: "ses_root", status: { type: "busy" } } })
    f.global.push({ type: "permission.asked", sourceEpoch: "epoch_one", data: { sessionID: "ses_root", id: "per_live" } })
    await f.wait((receipt) => receipt.kind === "request-observed")
    f.global.push({ type: "permission.replied", sourceEpoch: "epoch_one", data: { sessionID: "ses_root", requestID: "per_live" } })
    await f.wait((receipt) => receipt.kind === "reply-observed")
    f.append("ses_root", 2, "session.execution.succeeded")
    await f.wait((receipt) => receipt.kind === "durable")
    await f.wait((receipt) => receipt.kind === "heartbeat")
    expect(f.reads).toEqual(baseline)
  } finally { f.controller.abort(); await run }
})

for (const source of ["global", "log"] as const) {
  test(`follow native recovery handles generated ${source} fetch and reader Transport failures`, async () => {
    const f = fixture()
    const controllers = new Map<string, ReadableStreamDefaultController<Uint8Array>>()
    const counts = new Map<string, number>()
    const frame = (event: object) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)
    let connected!: () => void
    const connection = new Promise<void>((resolve) => { connected = resolve })
    const selected = source === "global" ? "/api/event" : "/api/experimental/session/ses_root/log"
    const native = YCoding.make({ baseUrl: "http://native.synthetic", fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const route = new URL(typeof input === "string" || input instanceof URL ? input : input.url).pathname
      counts.set(route, (counts.get(route) ?? 0) + 1)
      if (route === selected && counts.get(route) === 1) throw new Error("synthetic native fetch disconnected")
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controllers.set(route, controller)
        if (route === selected) connected()
        if (route === "/api/event") controller.enqueue(frame({ type: "server.connected", sourceEpoch: "epoch_one", data: {} }))
        else {
          for (const event of f.history.get("ses_root") ?? []) controller.enqueue(frame(event))
          controller.enqueue(frame({ type: "log.synced", aggregateID: "ses_root", sourceEpoch: "epoch_one", seq: f.history.get("ses_root")?.at(-1)?.durable?.seq }))
        }
        init?.signal?.addEventListener("abort", () => { try { controller.close() } catch {} }, { once: true })
      } }), { headers: { "content-type": "text/event-stream" } })
    }) as typeof fetch })
    f.client.event = native.event
    f.client.session.log = native.session.log
    const run = f.run()
    run.catch(() => undefined)
    try {
      await f.wait((receipt) => receipt.kind === "ready")
      if (source === "log") {
        const event = f.append("ses_root", 1, "session.execution.started")
        await connection
        controllers.get(selected)!.enqueue(frame(event))
        await f.wait((receipt) => receipt.seq === 1)
      }
      controllers.get(selected)!.error(new Error("synthetic native reader disconnected"))
      f.append("ses_root", 4, "session.work.completed")
      await f.wait((receipt) => receipt.seq === 4)
      expect(counts.get(selected)).toBeGreaterThanOrEqual(3)
    } finally { f.controller.abort(); await run }
    expect(f.saved.cursors).toEqual([{ sessionID: "ses_root", after: 4 }])
    expect(f.receipts.filter((receipt) => receipt.seq === 4)).toHaveLength(1)
  }, 10_000)
}

test("follow recovery cancellation bounds admitted output to one item per owned stream", async () => {
  const state = initial()
  state.sourceEpoch = "epoch_one"
  state.cursors = [{ sessionID: "ses_root" }]
  const f = fixture(state)
  for (let index = 1; index < 64; index++) f.children.push(`ses_child_${index}`)
  for (const sessionID of ["ses_root", ...f.children]) {
    f.append(sessionID, 2, "session.execution.started")
    f.append(sessionID, 5, "session.work.completed")
  }
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const first = new Promise<void>((resolve) => { entered = resolve })
  const run = f.run({ emit: async (receipt) => { if (receipt.kind === "durable") { entered(); await gate }; await f.emit(receipt) } })
  await first
  f.controller.abort()
  release()
  await run
  const delivered = f.receipts.filter((receipt) => receipt.kind === "durable")
  expect(delivered.length).toBeLessThanOrEqual(64)
  expect(delivered.every((receipt) => receipt.seq === 2)).toBe(true)
  expect(f.saved.cursors.every((cursor) => cursor.after === undefined || cursor.after === 2)).toBe(true)
  expect(f.streams.every((stream) => stream.active === 0)).toBe(true)
})

test("follow recovery handshake-only global flaps exhaust without polling healthy silence", async () => {
  const f = fixture()
  f.faults.handshake = true
  await expect(f.run()).rejects.toThrow(/budget-exhausted/)
  expect(f.reads.global).toBe(10)
  expect(f.streams.every((stream) => stream.active === 0)).toBe(true)
}, 30_000)

test("follow recovery reconciles an ephemeral pending request after stalled output and global disconnect", async () => {
  const f = fixture()
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const stalled = new Promise<void>((resolve) => { entered = resolve })
  const run = f.run({ emit: async (receipt) => {
    if (receipt.seq === 1) { entered(); await gate }
    await f.emit(receipt)
  } })
  run.catch(() => undefined)
  try {
    await f.wait((receipt) => receipt.kind === "ready")
    f.append("ses_root", 1, "session.execution.started")
    await stalled
    f.global.fail(new ClientError("Transport"))
    f.setPending([{ kind: "permission", sessionID: "ses_root", id: "per_gap" }])
    release()
    await f.wait((receipt) => receipt.kind === "pending" && receipt.id === "per_gap")
    f.global.push({ type: "permission.asked", sourceEpoch: "epoch_one", data: { sessionID: "ses_root", id: "per_gap" } })
    f.append("ses_root", 3, "session.work.completed")
    await f.wait((receipt) => receipt.seq === 3)
  } finally { release(); f.controller.abort(); await run }
  expect(f.receipts.filter((receipt) => receipt.id === "per_gap")).toHaveLength(1)
})

test("follow recovery allows recurring healthy durable reconnections after acknowledged replay", async () => {
  const f = fixture()
  const run = f.run()
  run.catch(() => undefined)
  try {
    await f.wait((receipt) => receipt.kind === "ready")
    for (let seq = 1; seq <= 12; seq++) {
      await f.logs.get("ses_root")!.idle()
      f.logs.get("ses_root")!.fail(new ClientError("Transport"))
      f.append("ses_root", seq, "session.step.ended")
      await f.wait((receipt) => receipt.seq === seq)
    }
  } finally { f.controller.abort(); await run }
  expect(f.reads.log).toBeGreaterThan(10)
}, 20_000)

test("follow recovery retries EOF before the native connected frame with bounded failures", async () => {
  const f = fixture()
  const subscribe = f.client.event.subscribe
  let refusals = 0
  f.client.event.subscribe = (options) => ++refusals < 3 ? (async function* () {})() : subscribe(options)
  const run = f.run()
  try { await f.wait((receipt) => receipt.kind === "ready") }
  finally { f.controller.abort(); await run }
  expect(refusals).toBe(3)
})

test("follow recovery refuses a mismatched first connection epoch before output or replacement state", async () => {
  const f = fixture()
  f.client.event.subscribe = () => (async function* () { yield { type: "server.connected", sourceEpoch: "epoch_wrong" } })()
  await expect(f.run()).rejects.toThrow(/epoch-mismatch/)
  expect(f.saved).toEqual(initial())
  expect(f.receipts).toEqual([])
})

for (const target of ["emit", "save"] as const) {
  test(`follow recovery never retries a Transport-shaped ${target} failure`, async () => {
    const f = fixture()
    const run = f.run(target === "emit" ? { emit: async (receipt) => {
      if (receipt.kind === "durable") throw new ClientError("Transport")
      await f.emit(receipt)
    } } : { save: async (value) => { if (value.cursors.some((cursor) => cursor.after === 1)) throw new ClientError("Transport") } })
    run.catch(() => undefined)
    await f.wait((receipt) => receipt.kind === "ready")
    f.append("ses_root", 1, "session.execution.started")
    await expect(run).rejects.toThrow("Transport")
    expect(f.reads.global).toBe(1)
    expect(f.reads.log).toBe(1)
    expect(f.saved.cursors).toEqual([{ sessionID: "ses_root" }])
  })
}
