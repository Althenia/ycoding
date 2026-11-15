import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { DecisionItem } from "@ycoding-ai/client/promise"
import { ClientError } from "@ycoding-ai/client/promise"
import { createFollowDelivery, type DeliveryClient } from "../src/commands/handlers/decision/follow-delivery"
import type { FollowReceipt } from "../src/commands/handlers/decision/follow"
import { FollowError, openFollowState, validateFollowState, type FollowState } from "../src/commands/handlers/decision/follow-state"

const server = "a".repeat(64)
const authority = "Settle these only within existing authority"
const base = (): FollowState => ({ version: 1, rootSessionID: "ses_root", server, sourceEpoch: "epoch_one", cursors: [{ sessionID: "ses_root", after: 0 }],
  pending: [], seen: [], requestSeen: [], terminalSeen: [] })
type Admission = { admission: "started" | "steered" | "duplicate" | "unknown"; turnID?: string }
type Sent = { threadID: string; text: string; clientMessageID: string; mode: string }

const durable = (type: string, sessionID = "ses_child", seq = 5): FollowReceipt => ({ kind: "durable", sessionID, id: `evt_${sessionID}_${seq}`, seq, type, rootActive: false, activity: "idle", ...(type === "session.execution.interrupted" ? { unrecovered: true } : {}) })
const pending = (requestKind: string, id: string, sessionID = "ses_root", extra: Partial<FollowReceipt> = {}): FollowReceipt => ({ kind: "pending", requestKind, sessionID, id, ...extra })
const item = (kind: DecisionItem["kind"], id: string, operation: string, key: string): DecisionItem => ({
  kind, sessionID: "ses_root", sessionTitle: "Synthetic title", directory: "/synthetic", id, summary: `synthetic ${kind} summary`,
  decide: [{ label: "once", argv: ["ycoding", "api", operation, "--param", "sessionID=ses_root", "--param", `${key}=${id}`, "--data", "{\"reply\":\"once\"}"] }],
}) as DecisionItem

async function until(predicate: () => boolean, label: string) {
  for (const started = Date.now(); !predicate();) {
    if (Date.now() - started > 3000) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function harness(options: { state?: FollowState; targets?: string[]; statuses?: Record<string, string | undefined>; items?: DecisionItem[]; admissions?: (Admission | unknown)[]; listed?: string[]; root?: () => string | undefined; resume?: () => Promise<void>; ready?: Promise<void> } = {}) {
  const controller = new AbortController()
  const sends: Sent[] = []
  const records: Record<string, unknown>[] = []
  const calls: string[] = []
  const admissions = [...(options.admissions ?? [])]
  const statuses = options.statuses ?? { thr_root: "idle" }
  let saved = options.state ?? base()
  let release: (() => void) | undefined
  let gate: Promise<void> | undefined
  const client: DeliveryClient = {
    decision: { async list() { calls.push("decision.list"); return options.items ?? [] } },
    dots: {
      async threads() {
        calls.push("dots.threads")
        const rootThreadID = options.root?.()
        return { ...(rootThreadID === undefined ? {} : { rootThreadID }),
          threads: (options.listed ?? Object.keys(statuses)).map((threadID) => ({ threadID, ...(statuses[threadID] === undefined ? {} : { status: statuses[threadID] }) })) }
      },
      async resume() { calls.push("dots.resume"); await options.resume?.(); return { outcome: "resumed" as const } },
      thread: { async send(input, requestOptions) {
        calls.push("dots.thread.send")
        sends.push(structuredClone(input) as Sent)
        await gate
        if (requestOptions.signal.aborted) throw requestOptions.signal.reason
        const next = admissions.shift() ?? { admission: "started" }
        if (typeof next !== "object" || next === null || !("admission" in next)) throw next
        return next as Admission
      } },
    },
  }
  const delivery = createFollowDelivery(client, { state: saved, targets: options.targets ?? ["thr_root"], signal: controller.signal, ready: options.ready ?? Promise.resolve(),
    save: async (value) => { saved = validateFollowState(structuredClone(value), saved.rootSessionID, server) },
    emit: async (record) => { records.push(record as Record<string, unknown>) } })
  const checkpoint = structuredClone(delivery.state)
  return {
    client, controller, sends, records, calls, delivery,
    get saved() { return saved },
    hold() { gate = new Promise<void>((resolve) => { release = resolve }) },
    release() { gate = undefined; release?.() },
    async observe(...receipts: FollowReceipt[]) { for (const receipt of receipts) { await delivery.emit(receipt); await delivery.save(checkpoint) } },
    async stop(run: Promise<void>) { controller.abort(); await run },
  }
}

for (const [type, phrase] of [
  ["session.execution.failed", "execution failed"],
  ["session.execution.interrupted", "execution interrupted"],
] as const) {
  test(`delivery pushes the ${type} lifecycle event with its read command`, async () => {
    const h = harness()
    const run = h.delivery.run()
    try {
      await h.observe(durable(type, "ses_root"))
      await until(() => h.sends.length === 1, "lifecycle send")
      const [sent] = h.sends
      expect(sent).toMatchObject({ threadID: "thr_root", mode: "send" })
      expect(sent!.text).toContain(`Session ses_root ${phrase} (event evt_ses_root_5, seq 5).`)
      expect(sent!.text).toContain("ycoding api session.snapshot --param sessionID=ses_root --param limit=50")
      expect(sent!.text).not.toContain("session.log")
      expect(sent!.text).not.toContain(authority)
    } finally { await h.stop(run) }
  })
}

for (const [kind, id, operation, key] of [
  ["permission", "per_one", "session.permission.reply", "requestID"],
  ["guardrail", "grq_one", "session.guardrail.request.reply", "requestID"],
  ["question", "que_one", "session.question.reply", "requestID"],
  ["form", "frm_one", "session.form.reply", "formID"],
  ["review", "rvw_one", "session.review.decide", "itemID"],
] as const) {
  test(`delivery pushes a pending ${kind} with its listed decide command and never decides it`, async () => {
    const h = harness({ items: [item(kind, id, operation, key)] })
    const run = h.delivery.run()
    try {
      await h.observe(pending(kind, id))
      await until(() => h.sends.length === 1, "request send")
      const text = h.sends[0].text
      expect(text).toContain(`${kind} ${id} pending in ses_root.`)
      expect(text).toContain(`once: ycoding api ${operation} --param sessionID=ses_root --param ${key}=${id} --data '{"reply":"once"}'`)
      expect(text).not.toContain("Read: ycoding decision list --json")
      expect(text).not.toContain(authority)
      expect(h.calls.every((call) => ["dots.threads", "decision.list", "dots.thread.send"].includes(call))).toBe(true)
    } finally { await h.stop(run) }
  })
}

test("delivery pushes a live child question with its answer template and read command", async () => {
  const h = harness()
  const run = h.delivery.run()
  try {
    await h.observe(pending("child-question", "que_child", "ses_child", { parentID: "ses_root", revision: 3, operation: "session.subagent.answer" }))
    await until(() => h.sends.length === 1, "child question send")
    const text = h.sends[0].text
    expect(text).toContain("child-question que_child pending in ses_child (parent ses_root).")
    expect(text).toContain("Answer [template]: ycoding api session.subagent.answer --param parentID=ses_root --param childID=ses_child --param questionID=que_child --data '{\"text\":\"<answer:text>\"}'")
    expect(text).toContain("Read: ycoding api session.subagent.list --param parentID=ses_root")
  } finally { await h.stop(run) }
})

test("a request no longer listed when sent keeps its IDs and points to the decision list", async () => {
  const h = harness()
  const run = h.delivery.run()
  try {
    await h.observe({ ...pending("guardrail", "grq_gone"), kind: "request-observed", resolution: "unknown" })
    await until(() => h.sends.length === 1, "unlisted send")
    expect(h.sends[0].text).toContain("guardrail grq_gone pending in ses_root.")
    expect(h.sends[0].text).toContain("It is not listed by ycoding decision list now; it may have settled.")
  } finally { await h.stop(run) }
})

test("routine lifecycle and ownership observations never enter the outbox", async () => {
  const h = harness()
  for (const sessionID of ["ses_root", "ses_child", "ses_supervisor", "ses_compaction"]) {
    await h.observe(durable("session.execution.started", sessionID), durable("session.execution.succeeded", sessionID), durable("session.work.completed", sessionID))
  }
  for (const snapshot of [true, undefined] as const) await h.observe({ kind: "ownership", type: "owner-changed", groupID: "grp_one", sessionID: "ses_member", ownerSessionID: "ses_owner", revision: 3, snapshot })
  await h.observe({ kind: "ownership", type: "owner-released", groupID: "grp_one", sessionID: "ses_member", revision: 4 })
  expect(h.records).toHaveLength(15)
  expect(h.saved.delivery?.targets[0]?.outbox).toEqual([])
})

test("compaction failures and recovered or descendant interruptions stay observation-only", async () => {
  const h = harness()
  await h.observe({ ...durable("session.execution.failed", "ses_compaction"), compaction: true },
    durable("session.execution.interrupted", "ses_child"),
    { ...durable("session.execution.interrupted", "ses_root"), unrecovered: undefined },
    { ...durable("session.execution.interrupted", "ses_root"), rootActive: true })
  expect(h.records).toHaveLength(4)
  expect(h.saved.delivery?.targets[0]?.outbox).toEqual([])
})

test("Project escalations deliver once with exact decision identity and no authority paragraph", async () => {
  const h = harness({ items: [item("review", "rvw_escalated", "session.review.decide", "itemID")] })
  const run = h.delivery.run()
  try {
    const request: FollowReceipt = { ...pending("review", "rvw_escalated"), kind: "project-escalation", type: "coordination.request.escalated" }
    await h.observe(request, request)
    await until(() => h.records.some((record) => record.outcome === "delivered"), "escalated decision")
    expect(h.sends).toHaveLength(1)
    expect(h.sends[0]!.text).toContain("review rvw_escalated pending in ses_root, escalated")
    expect(h.sends[0]!.text).toContain("session.review.decide --param sessionID=ses_root --param itemID=rvw_escalated")
    expect(h.sends[0]!.text).not.toContain(authority)
  } finally { await h.stop(run) }
})

for (const reason of ["completed", "open-questions", "recovery-needed", "unfinished-idle"]) {
  test(`compact ${reason} summary survives reload and drains with one inspect command`, async () => {
    const h = harness()
    await h.observe({ kind: "reconciliation", sessionID: "ses_root", id: "watch_synthetic", reason,
      evidence: reason === "open-questions" ? "review rvw_pending sessionID=ses_root" : "synthetic retained evidence" })
    const reloaded = harness({ state: validateFollowState(JSON.parse(JSON.stringify(h.saved)), "ses_root", server) })
    const run = reloaded.delivery.run()
    try {
      await until(() => reloaded.records.some((record) => record.outcome === "delivered"), "retained summary")
      const text = reloaded.sends[0]!.text
      expect(text.split("\n")).toHaveLength(3)
      expect(text).toContain(`Session ses_root: ${reason};`)
      expect(text).toContain("ycoding decision watch ses_root --family")
      expect(text).not.toContain(authority)
    } finally { await reloaded.stop(run) }
  })
}

test("v1 reload preserves 68 cursors, request ledgers, ownership and legacy inflight identity on the sole target", async () => {
  const state = base()
  const target = "6af84c7d-0e3c-8191-a340-caaf8e789001"
  const clientMessageID = "00000000-0000-8000-8000-000000000001"
  state.cursors.push(...Array.from({ length: 67 }, (_, i) => ({ sessionID: `ses_retained_${i}`, after: i })))
  state.pending = [{ kind: "review", sessionID: "ses_root", id: "rvw_pending" }]
  state.requestSeen = ["review\0ses_root\0rvw_pending"]
  state.seen = [["ses_root", "evt_awaiting_ack", "1"].join("\0")]
  state.terminalSeen = ["question\0ses_root\0que_done"]
  state.ownership = [{ groupID: "cgrp_retained", sessionID: "ses_member", ownerSessionID: "ses_owner", revision: 3 }]
  state.delivery = { announced: ["review\0ses_root\0rvw_pending"], targets: [{ target,
    outbox: [{ sessionID: "ses_root", id: "evt_success", type: "session.execution.succeeded", seq: 2 }],
    inflight: { threadID: target, clientMessageID, events: [{ sessionID: "ses_root", id: "evt_start", type: "session.execution.started", seq: 1 }] } }] }
  const directory = await mkdtemp(join(homedir(), ".local/share/ycoding/tasks/decision-watch-v1-"))
  const filename = join(directory, "state.json")
  await writeFile(filename, JSON.stringify(state), { mode: 0o600 })
  const store = await openFollowState(filename, "ses_root", server)
  const h = harness({ state: store.state, targets: [target], listed: [target], admissions: [{ admission: "duplicate" }] })
  const run = h.delivery.run()
  try {
    await until(() => h.saved.delivery?.targets[0]?.inflight === undefined && h.saved.delivery?.targets[0]?.outbox.length === 0, "legacy drain")
    expect(h.sends).toHaveLength(2)
    expect(h.sends[0]!.clientMessageID).toBe(clientMessageID)
    for (const key of ["cursors", "pending", "seen", "requestSeen", "terminalSeen", "ownership", "sourceEpoch"] as const) expect(h.saved[key]).toEqual(state[key])
    expect(h.saved.delivery?.announced).toEqual(state.delivery.announced)
    await store.save(h.saved)
  } finally { await h.stop(run); await store.close() }
  try {
    const reloaded = await openFollowState(filename, "ses_root", server)
    try { expect(reloaded.state.delivery?.targets).toEqual([{ target, outbox: [] }]) }
    finally { await reloaded.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("noise receipts, unlisted durable types and request endings are never delivered", async () => {
  const h = harness()
  const run = h.delivery.run()
  try {
    await h.observe(
      { kind: "ready", sessionID: "ses_root" }, { kind: "heartbeat", sessionID: "ses_root" }, { kind: "activity", sessionID: "ses_root", activity: "running" },
      { kind: "gap", sessionID: "ses_root", resolution: "unknown" },
      durable("session.step.started", "ses_root", 1), { kind: "reply-observed", requestKind: "guardrail", sessionID: "ses_root", id: "grq_old", resolution: "reply-observed" },
      { kind: "closed", sessionID: "ses_root" },
    )
    await h.observe(durable("session.execution.failed", "ses_root", 2))
    await until(() => h.sends.length === 1, "single send")
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(h.sends).toHaveLength(1)
    expect(h.sends[0].text).toContain("1. ")
    expect(h.sends[0].text).not.toContain("grq_old")
  } finally { await h.stop(run) }
})

test("events observed during a send coalesce into one message per target on the next pass", async () => {
  const h = harness({ targets: ["thr_root", "thr_task"], statuses: { thr_root: "idle", thr_task: "idle" } })
  h.hold()
  const run = h.delivery.run()
  try {
    await h.observe(durable("session.execution.failed", "ses_root", 1))
    await until(() => h.sends.length === 1, "first send")
    await h.observe(durable("session.execution.failed", "ses_root", 2), pending("question", "que_three"), pending("permission", "per_two"))
    h.release()
    await until(() => h.sends.length === 4, "coalesced sends")
    const second = h.sends.filter((sent) => sent.text.includes("3. "))
    expect(second.map((sent) => sent.threadID).toSorted()).toEqual(["thr_root", "thr_task"])
    for (const sent of second) for (const value of ["execution failed", "question que_three", "permission per_two"]) expect(sent.text).toContain(value)
    expect(h.saved.delivery?.targets.every((target) => target.outbox.length === 0 && target.inflight === undefined)).toBe(true)
  } finally { await h.stop(run) }
})

for (const status of ["idle", "not-loaded", "error", "active", "waiting-approval", "waiting-input", undefined] as const) {
  test(`delivery to a ${status ?? "status-less"} thread sends without queueing and records send`, async () => {
    const h = harness({ statuses: { thr_root: status } })
    const run = h.delivery.run()
    try {
      await h.observe(durable("session.execution.failed"))
      await until(() => h.records.some((record) => record.kind === "delivery"), "mode send")
      expect(h.sends[0].mode).toBe("send")
      expect(h.records.find((record) => record.kind === "delivery")).toMatchObject({ target: "thr_root", threadID: "thr_root", mode: "send", outcome: "delivered" })
    } finally { await h.stop(run) }
  })
}

test("delivery to dot resolves the Dot's current root at each pass and moves an in-flight batch to a rotated root with a new message ID", async () => {
  let root: string | undefined = "thr_root_one"
  const h = harness({ targets: ["dot"], statuses: { thr_root_one: undefined, thr_root_two: undefined }, root: () => root,
    admissions: [{ admission: "unknown" }, { admission: "started" }, { admission: "started" }] })
  const run = h.delivery.run()
  try {
    await h.observe(durable("session.execution.failed", "ses_root", 1))
    await until(() => h.records.some((record) => record.outcome === "unknown"), "unknown admission")
    expect(h.sends[0]).toMatchObject({ threadID: "thr_root_one", mode: "send" })
    expect(h.saved.delivery?.targets).toEqual([{ target: "dot", outbox: [], inflight: { threadID: "thr_root_one", clientMessageID: h.sends[0].clientMessageID, events: [expect.objectContaining({ seq: 1 })] } }])
    root = "thr_root_two"
    await until(() => h.records.some((record) => record.outcome === "delivered"), "rotated delivery")
    expect(h.sends.at(-1)).toMatchObject({ threadID: "thr_root_two", mode: "send" })
    expect(h.sends.at(-1)!.clientMessageID).not.toBe(h.sends[0].clientMessageID)
    expect(h.sends.at(-1)!.text).toContain("execution failed")
    expect(h.records.find((record) => record.outcome === "delivered")).toMatchObject({ target: "dot", threadID: "thr_root_two", clientMessageID: h.sends.at(-1)!.clientMessageID })
    await h.observe(durable("session.execution.failed", "ses_root", 2))
    await until(() => h.sends.some((sent) => sent.text.includes("execution failed")), "later delivery")
    expect(h.sends.at(-1)!.threadID).toBe("thr_root_two")
    await until(() => h.saved.delivery?.targets[0]?.inflight === undefined && h.saved.delivery?.targets[0]?.outbox.length === 0, "drained")
    expect(h.saved.delivery?.targets).toEqual([{ target: "dot", outbox: [] }])
  } finally { await h.stop(run) }
})

test("delivery to dot refuses a Dot that reports no root conversation before sending anything", async () => {
  const h = harness({ targets: ["dot"], root: () => undefined })
  const error = await h.delivery.run().then(() => undefined, (failure: unknown) => failure)
  expect(String((error as Error).message)).toContain("[delivery-target-unavailable]")
  expect(h.sends).toHaveLength(0)
})

test("an unknown admission stays undelivered and is resent with the same message ID until confirmed", async () => {
  const h = harness({ admissions: [{ admission: "unknown" }, new ClientError("Transport"), { admission: "duplicate" }] })
  const run = h.delivery.run()
  try {
    await h.observe(pending("guardrail", "grq_one"))
    await until(() => h.records.some((record) => record.outcome === "delivered"), "confirmed delivery")
    expect(h.sends).toHaveLength(3)
    expect(new Set(h.sends.map((sent) => sent.clientMessageID)).size).toBe(1)
    expect(h.sends[0].clientMessageID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    const outcomes = h.records.filter((record) => record.kind === "delivery")
    expect(outcomes.map((record) => record.outcome)).toEqual(["unknown", "unknown", "delivered"])
    expect(outcomes[2]).toMatchObject({ kind: "delivery", threadID: "thr_root", clientMessageID: h.sends[0].clientMessageID, admission: "duplicate", mode: "send" })
    expect(h.saved.delivery?.targets[0]).toEqual({ target: "thr_root", outbox: [] })
  } finally { await h.stop(run) }
})

test("a rejected send fails the delivery visibly and keeps the batch for a restart", async () => {
  const h = harness({ admissions: [{ message: "NEVER-OUTPUT upstream body" }] })
  const run = h.delivery.run()
  await h.observe(durable("session.execution.interrupted", "ses_root"))
  const error = await run.then(() => undefined, (failure: unknown) => failure)
  expect(error).toBeInstanceOf(FollowError)
  expect(String((error as Error).message)).toContain("[delivery-failed]")
  expect(String((error as Error).message)).not.toContain("NEVER-OUTPUT")
  expect(h.records.at(-1)).toMatchObject({ kind: "delivery", threadID: "thr_root", outcome: "failed", clientMessageID: h.sends[0].clientMessageID })
  expect(h.saved.delivery?.targets[0]?.inflight?.clientMessageID).toBe(h.sends[0].clientMessageID)
  const restarted = harness({ state: h.saved, admissions: [{ admission: "duplicate" }] })
  const again = restarted.delivery.run()
  try {
    await until(() => restarted.sends.length === 1, "restart resend")
    expect(restarted.sends[0].clientMessageID).toBe(h.sends[0].clientMessageID)
    await until(() => restarted.saved.delivery?.targets[0]?.inflight === undefined, "restart confirmation")
  } finally { await restarted.stop(again) }
})

test("a restart delivers persisted undelivered events and never redelivers delivered ones", async () => {
  const first = harness()
  first.hold()
  const run = first.delivery.run()
  await first.observe(durable("session.execution.failed", "ses_root", 1))
  await until(() => first.sends.length === 1, "held send")
  await first.observe(durable("session.execution.failed", "ses_root", 2))
  first.controller.abort()
  first.release()
  await run
  expect(first.saved.delivery?.targets[0]?.inflight?.events).toHaveLength(1)
  expect(first.saved.delivery?.targets[0]?.outbox).toHaveLength(1)

  const second = harness({ state: first.saved, admissions: [{ admission: "duplicate" }, { admission: "started" }] })
  const resumed = second.delivery.run()
  try {
    await until(() => second.sends.length === 2, "restart deliveries")
    expect(second.sends[0].clientMessageID).toBe(first.sends[0].clientMessageID)
    expect(second.sends[0].text).toContain("execution failed")
    expect(second.sends[1].text).toContain("execution failed")
    expect(second.sends[1].text).not.toContain("execution started")
    await until(() => second.saved.delivery?.targets[0]?.outbox.length === 0, "restart drained")
  } finally { await second.stop(resumed) }

  const third = harness({ state: second.saved })
  const idle = third.delivery.run()
  await new Promise((resolve) => setTimeout(resolve, 50))
  await third.stop(idle)
  expect(third.sends).toHaveLength(0)
})

test("68 retained cursors and a sole synthetic outbox survive interrupted delivery and duplicate acknowledgement in order", async () => {
  const state = base()
  state.cursors = [{ sessionID: "ses_root", after: 24860 }, ...Array.from({ length: 67 }, (_, index) => ({ sessionID: `ses_compaction_${index}`, after: 1 }))]
  state.delivery = { announced: [], targets: [{ target: "thr_synthetic_only", outbox: [{ sessionID: "ses_root", id: "evt_retained", type: "session.execution.interrupted", seq: 24860 }] }] }
  const config = { targets: ["thr_synthetic_only"], statuses: { thr_synthetic_only: "idle" } }
  const first = harness({ ...config, state })
  first.hold()
  const run = first.delivery.run()
  await until(() => first.sends.length === 1, "retained outbox admission")
  await first.observe(durable("session.execution.failed", "ses_compaction_34", 2), durable("session.execution.failed", "ses_compaction_34", 3))
  first.controller.abort()
  first.release()
  await run
  expect(first.saved.cursors).toEqual(state.cursors)
  expect(first.saved.delivery?.targets).toHaveLength(1)
  expect(first.saved.delivery?.targets[0]?.inflight?.events).toEqual(state.delivery.targets[0]!.outbox)
  expect(first.saved.delivery?.targets[0]?.outbox.map((event) => event.seq)).toEqual([2, 3])
  const second = harness({ ...config, state: first.saved, admissions: [{ admission: "duplicate" }, { admission: "started" }] })
  const next = second.delivery.run()
  try {
    await until(() => second.saved.delivery?.targets[0]?.inflight === undefined && second.saved.delivery?.targets[0]?.outbox.length === 0, "confirmed drain")
    expect(second.sends.map((sent) => sent.threadID)).toEqual(["thr_synthetic_only", "thr_synthetic_only"])
    expect(second.sends[0]!.clientMessageID).toBe(first.sends[0]!.clientMessageID)
    expect(second.records.filter((record) => record.kind === "delivery").flatMap((record) => record.events as object[])).toMatchObject([{ seq: 24860 }, { seq: 2 }, { seq: 3 }])
    expect(second.saved.cursors).toEqual(state.cursors)
  } finally { await second.stop(next) }
  const third = harness({ ...config, state: second.saved })
  const final = third.delivery.run()
  await until(() => third.calls.includes("dots.threads"), "restarted target validation")
  await third.stop(final)
  expect(third.sends).toEqual([])
})

test("a retained outbox waits for complete observation readiness and stays untouched when startup is cancelled", async () => {
  const state = base()
  state.delivery = { announced: [], targets: [{ target: "thr_root", outbox: [{ sessionID: "ses_root", id: "evt_retained", type: "session.execution.interrupted", seq: 1 }] }] }
  const ready = Promise.withResolvers<void>()
  const h = harness({ state, ready: ready.promise })
  const run = h.delivery.run()
  await until(() => h.calls.includes("dots.threads"), "target validation")
  await h.stop(run)
  expect(h.sends).toEqual([])
  expect(h.saved).toEqual(state)
  ready.resolve()
})

test("an emitted receipt is not delivered until the follow state that records it is saved", async () => {
  const h = harness()
  const run = h.delivery.run()
  try {
    await h.delivery.emit(durable("session.execution.failed"))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(h.sends).toHaveLength(0)
    await h.delivery.save(structuredClone(h.delivery.state))
    await until(() => h.sends.length === 1, "send after save")
  } finally { await h.stop(run) }
})

test("a request that ends before delivery is dropped and a repeated observation is delivered once", async () => {
  const h = harness({ items: [item("guardrail", "grq_twice", "session.guardrail.request.reply", "requestID")] })
  h.hold()
  const run = h.delivery.run()
  try {
    await h.observe(durable("session.execution.failed", "ses_root", 1))
    await until(() => h.sends.length === 1, "held send")
    await h.observe(pending("question", "que_gone"),
      { kind: "request-ended-observed", requestKind: "question", sessionID: "ses_root", id: "que_gone", resolution: "cancelled" },
      { ...pending("guardrail", "grq_twice"), kind: "request-observed", resolution: "unknown" },
      pending("guardrail", "grq_twice", "ses_root", { fingerprint: "f".repeat(64) }))
    h.release()
    await until(() => h.sends.length === 2, "second send")
    expect(h.sends[1].text).not.toContain("que_gone")
    expect(h.sends[1].text.split("grq_twice pending").length - 1).toBe(1)
    await h.observe(pending("guardrail", "grq_twice", "ses_root", { fingerprint: "e".repeat(64) }), durable("session.execution.failed", "ses_root", 2))
    await until(() => h.sends.length === 3, "third send")
    expect(h.sends[2].text).not.toContain("grq_twice")
  } finally { await h.stop(run) }
})

test("delivery refuses a thread the Dot does not list before sending anything", async () => {
  const h = harness({ targets: ["thr_missing"], listed: ["thr_root"] })
  const error = await h.delivery.run().then(() => undefined, (failure: unknown) => failure)
  expect(String((error as Error).message)).toContain("[delivery-target-unavailable]")
  expect(h.sends).toHaveLength(0)
})

test("adding a target preserves existing inflight and outbox without copying them", () => {
  const event = { sessionID: "ses_root", id: "evt_old", type: "session.execution.started", seq: 1 }
  const inflight = { threadID: "thr_old", clientMessageID: "00000000-0000-8000-8000-000000000001", events: [event] }
  const state = { ...base(), delivery: { announced: [], targets: [{ target: "dot", outbox: [event], inflight }] } }
  const h = harness({ state, targets: ["dot", "thr_task"] })
  expect(h.delivery.state.delivery?.targets).toEqual([{ target: "dot", outbox: [event], inflight }, { target: "thr_task", outbox: [] }])
  expect(state.delivery.targets).toEqual([{ target: "dot", outbox: [event], inflight }])
})

test("removing clean targets succeeds but removing pending targets fails", () => {
  const event = { sessionID: "ses_root", id: "evt_old", type: "session.execution.started", seq: 1 }
  const clean = { ...base(), delivery: { announced: [], targets: [{ target: "thr_root", outbox: [] }, { target: "thr_task", outbox: [] }] } }
  expect(harness({ state: clean, targets: ["thr_root"] }).delivery.state.delivery?.targets).toEqual([{ target: "thr_root", outbox: [] }])
  for (const removed of [
    { target: "thr_task", outbox: [event] },
    { target: "thr_task", outbox: [], inflight: { threadID: "thr_task", clientMessageID: "00000000-0000-8000-8000-000000000001", events: [event] } },
  ]) {
    const state = { ...clean, delivery: { announced: [], targets: [clean.delivery.targets[0]!, removed] } }
    expect(() => harness({ state, targets: ["thr_root"] })).toThrow("[delivery-targets-changed]")
    expect(state.delivery.targets[1]).toEqual(removed)
  }
  expect(() => harness({ state: clean, targets: [] })).toThrow("[delivery-targets-changed]")
})

for (const newRoot of ["thr_old", "thr_new"]) {
  test(`restart after a rejected dot send recovers on ${newRoot}`, async () => {
    const first = harness({ targets: ["dot"], root: () => "thr_old", admissions: [new Error("thread not found")] })
    const failed = first.delivery.run()
    await first.observe(durable("session.execution.failed", "ses_root", 1))
    expect(await failed.then(() => undefined, (error: unknown) => error)).toBeInstanceOf(FollowError)
    expect(first.records.at(-1)).toMatchObject({ outcome: "failed", threadID: "thr_old" })
    const oldID = first.saved.delivery!.targets[0]!.inflight!.clientMessageID
    const resumed = harness({ state: first.saved, targets: ["dot"], root: () => newRoot })
    const run = resumed.delivery.run()
    try {
      await until(() => resumed.saved.delivery?.targets[0]?.inflight === undefined, "recovered batch saved")
      expect(resumed.sends).toHaveLength(1)
      expect(resumed.sends[0]!.threadID).toBe(newRoot)
      if (newRoot === "thr_old") expect(resumed.sends[0]!.clientMessageID).toBe(oldID)
      else expect(resumed.sends[0]!.clientMessageID).not.toBe(oldID)
      expect(resumed.records.filter((record) => record.kind === "delivery")).toMatchObject([{ outcome: "delivered", threadID: newRoot }])
      expect(resumed.saved.delivery?.targets).toEqual([{ target: "dot", outbox: [] }])
    } finally { await resumed.stop(run) }
  })
}

test("adding a task target while recovering dot sends old events only to dot and later events to both", async () => {
  const event = { sessionID: "ses_root", id: "evt_old", type: "session.execution.started", seq: 1 }
  const state = { ...base(), delivery: { announced: [], targets: [{ target: "dot", outbox: [], inflight: {
    threadID: "thr_old", clientMessageID: "00000000-0000-8000-8000-000000000001", events: [event],
  } }] } }
  const h = harness({ state, targets: ["dot", "thr_task"], root: () => "thr_new", listed: ["thr_new", "thr_task"] })
  expect(h.delivery.state.delivery?.targets[1]).toEqual({ target: "thr_task", outbox: [] })
  const run = h.delivery.run()
  try {
    await until(() => h.saved.delivery?.targets[0]?.inflight === undefined && h.records.some((record) => record.outcome === "delivered"), "old batch delivered")
    expect(h.sends).toHaveLength(1)
    expect(h.sends[0]).toMatchObject({ threadID: "thr_new" })
    expect(h.sends[0]!.clientMessageID).not.toBe(state.delivery.targets[0]!.inflight.clientMessageID)
    await h.observe(durable("session.execution.failed", "ses_root", 2))
    await until(() => h.records.filter((record) => record.outcome === "delivered").length === 3, "later deliveries")
    expect(h.sends).toHaveLength(3)
    expect(h.sends.slice(1).map((sent) => sent.threadID).toSorted()).toEqual(["thr_new", "thr_task"])
    for (const sent of h.sends.slice(1)) {
      expect(sent.text).toContain("execution failed")
      expect(sent.text).not.toContain("execution started")
    }
  } finally { await h.stop(run) }
})

test("a missing dot root resumes once and retries the saved batch at the new root", async () => {
  let root = "thr_old"
  const event = { sessionID: "ses_root", id: "evt_old", type: "session.execution.started", seq: 1 }
  const oldID = "00000000-0000-8000-8000-000000000001"
  const state = { ...base(), delivery: { announced: [], targets: [{ target: "dot", outbox: [], inflight: { threadID: root, clientMessageID: oldID, events: [event] } }] } }
  const h = harness({ state, targets: ["dot"], root: () => root, resume: async () => { root = "thr_new" },
    admissions: [{ _tag: "InvalidRequestError", rejection: { code: -32600, message: "thread not found" } }, { admission: "started" }] })
  const run = h.delivery.run()
  try {
    await until(() => h.saved.delivery?.targets[0]?.inflight === undefined, "recovered delivery saved")
    expect(h.calls.filter((call) => call === "dots.resume")).toHaveLength(1)
    expect(h.sends.map((send) => send.threadID)).toEqual(["thr_old", "thr_new"])
    expect(h.sends[0]!.clientMessageID).toBe(oldID)
    expect(h.sends[1]!.clientMessageID).not.toBe(oldID)
    expect(h.records.filter((record) => record.kind === "delivery").map((record) => record.outcome)).toEqual(["failed", "delivered"])
    expect(h.saved.delivery?.targets).toEqual([{ target: "dot", outbox: [] }])
  } finally { await h.stop(run) }
})

for (const scenario of ["task", "unchanged", "other rejection", "resume rejected", "repeated failure"] as const) {
  test(`delivery fails without unsafe resume retries for ${scenario}`, async () => {
    let root = "thr_old"
    const target = scenario === "task" ? "thr_task" : "dot"
    const threadID = target === "dot" ? root : target
    const event = { sessionID: "ses_root", id: "evt_old", type: "session.execution.started", seq: 1 }
    const inflight = { threadID, clientMessageID: "00000000-0000-8000-8000-000000000001", events: [event] }
    const state = { ...base(), delivery: { announced: [], targets: [{ target, outbox: [], inflight }] } }
    const rejection = { _tag: "InvalidRequestError", rejection: { code: -32600, message: scenario === "other rejection" ? "other error" : "thread not found" } }
    const h = harness({ state, targets: [target], listed: ["thr_task"], root: () => root, admissions: [rejection, rejection],
      resume: async () => { if (scenario === "resume rejected") throw new Error("resume rejected"); if (scenario === "repeated failure") root = "thr_new" } })
    const error = await h.delivery.run().then(() => undefined, (failure: unknown) => failure)
    expect(error).toBeInstanceOf(FollowError)
    expect((error as FollowError).code).toBe("delivery-failed")
    expect(h.calls.filter((call) => call === "dots.resume")).toHaveLength(scenario === "task" || scenario === "other rejection" ? 0 : 1)
    expect(h.sends).toHaveLength(scenario === "repeated failure" ? 2 : 1)
    expect(h.saved.delivery?.targets[0]?.inflight?.events).toEqual([event])
  })
}

const liveRoot = "ses_e36de2194ffejEQ7aSOTTvCzLJ"
const retiredRoot = "6af7242e-5c98-8191-8cd1-680197a1500c"
const rotatedRoot = "6af7b826-0000-8191-8000-000000000001"
const taskThread = "6af71ccd-3ff0-8191-8d6a-e00451fbe039"
const savedMessageID = "cb143090-203e-8487-b2d0-43c29e5784de"
const liveGroup = "cgrp_1c921dee6001TeDrmjutbX2o7R"
const liveSnapshot = { sessionID: liveRoot, id: liveGroup, snapshot: true as const, revision: 28, members: [
  { sessionID: "ses_dot_yquery_five_designs_20261020_0650" }, { sessionID: "ses_e28b896f9ffecX7VlWEjFqFE3Z" },
  { sessionID: "ses_e2cc4db50ffe491yRaWV5ZmYdi", ownerSessionID: "ses_task_bf495517c746ad880e31d7d1" },
  { sessionID: "ses_e7349b71bffeH7ct5fjPoDDRRl", ownerSessionID: "ses_task_1d14e34613825b376ea47fda" },
] }
const liveState = (): FollowState => ({ version: 1, rootSessionID: liveRoot, server, sourceEpoch: "b84fa17f-6d31-4cb3-ade6-fce5ac6385dd",
  cursors: [{ sessionID: liveRoot, after: 10659 }, { sessionID: "ses_task_847e601a7773d3394212597e", after: 5361 }], pending: [], seen: [], requestSeen: [], terminalSeen: [],
  ownership: liveSnapshot.members.map((member) => ({ groupID: liveGroup, revision: 28, ...member })),
  delivery: { announced: [], targets: [{ target: "dot", outbox: [], inflight: { threadID: retiredRoot, clientMessageID: savedMessageID, events: [structuredClone(liveSnapshot)] } }] } })
const notFound = { _tag: "InvalidRequestError", rejection: { code: -32600, message: "thread not found" } }

for (const current of [retiredRoot, rotatedRoot]) {
  test(`restarting the saved snapshot batch with an added task thread sends the snapshot only to dot at ${current === retiredRoot ? "the unchanged" : "a rotated"} root`, async () => {
    const h = harness({ state: liveState(), targets: ["dot", taskThread], root: () => current, listed: [taskThread] })
    expect(h.delivery.state.delivery?.targets.map((target) => target.target)).toEqual(["dot", taskThread])
    const run = h.delivery.run()
    try {
      await until(() => h.saved.delivery?.targets[0]?.inflight === undefined, "recovered snapshot delivered")
      expect(h.sends).toHaveLength(1)
      expect(h.sends[0]!.threadID).toBe(current)
      if (current === retiredRoot) expect(h.sends[0]!.clientMessageID).toBe(savedMessageID)
      else expect(h.sends[0]!.clientMessageID).not.toBe(savedMessageID)
      expect(h.sends[0]!.text).toContain(`Project ${liveGroup} ownership when this watch started (current state, not a change; revision 28)`)
      expect(h.saved.delivery?.targets).toEqual([{ target: "dot", outbox: [] }, { target: taskThread, outbox: [] }])
      await h.observe(durable("session.execution.failed", "ses_task_847e601a7773d3394212597e", 5362))
      await until(() => h.records.filter((record) => record.outcome === "delivered").length === 3, "post-restart deliveries")
      expect(h.sends).toHaveLength(3)
      expect(h.sends.slice(1).map((sent) => sent.threadID).toSorted()).toEqual([current, taskThread].toSorted())
      for (const sent of h.sends.slice(1)) {
        expect(sent.text).toContain("Session ses_task_847e601a7773d3394212597e execution failed (event evt_ses_task_847e601a7773d3394212597e_5362, seq 5362).")
        expect(sent.text).not.toContain(liveGroup)
      }
      expect(h.saved.delivery?.targets).toEqual([{ target: "dot", outbox: [] }, { target: taskThread, outbox: [] }])
    } finally { await h.stop(run) }
  })
}

test("a retired dot root resumes without sending, losing or duplicating the task thread batch formed in the same pass, and can resume again later", async () => {
  let root = retiredRoot
  const roots = [rotatedRoot, "6af7c000-0000-8191-8000-000000000002"]
  let formedTask: unknown
  const h = harness({ state: liveState(), targets: ["dot", taskThread], root: () => root, listed: [taskThread],
    resume: async () => { formedTask ??= structuredClone(h.saved.delivery?.targets[1]); root = roots.shift()! },
    admissions: [notFound, { admission: "started" }, { admission: "started" }, { admission: "started" }, notFound] })
  await h.observe(durable("session.execution.failed", "ses_task_847e601a7773d3394212597e", 5362))
  const run = h.delivery.run()
  try {
    await until(() => h.records.filter((record) => record.outcome === "delivered").length === 3, "recovered deliveries")
    expect(h.calls.filter((call) => call === "dots.resume")).toHaveLength(1)
    expect(h.sends.map((sent) => sent.threadID)).toEqual([retiredRoot, rotatedRoot, taskThread, rotatedRoot])
    expect(h.sends[0]!.clientMessageID).toBe(savedMessageID)
    expect(h.sends[1]!.clientMessageID).not.toBe(savedMessageID)
    expect(h.sends[1]!.text).toContain(`Project ${liveGroup} ownership`)
    expect(formedTask).toMatchObject({ target: taskThread, outbox: [], inflight: { threadID: taskThread } })
    expect(h.sends[2]!.clientMessageID).toBe((formedTask as { inflight: { clientMessageID: string } }).inflight.clientMessageID)
    for (const sent of h.sends.slice(2)) {
      expect(sent.text).toContain("execution failed (event evt_ses_task_847e601a7773d3394212597e_5362, seq 5362)")
      expect(sent.text).not.toContain(liveGroup)
    }
    expect(h.records.filter((record) => record.kind === "delivery").map((record) => [record.outcome, record.threadID]))
      .toEqual([["failed", retiredRoot], ["delivered", rotatedRoot], ["delivered", taskThread], ["delivered", rotatedRoot]])
    await until(() => h.saved.delivery?.targets.every((target) => target.inflight === undefined && target.outbox.length === 0) === true, "drained state")
    await h.observe(durable("session.execution.failed", "ses_task_847e601a7773d3394212597e", 5363))
    await until(() => h.records.filter((record) => record.outcome === "delivered").length === 5, "deliveries after a second rotation")
    expect(h.calls.filter((call) => call === "dots.resume")).toHaveLength(2)
    expect(h.sends.slice(4).map((sent) => sent.threadID)).toEqual([rotatedRoot, "6af7c000-0000-8191-8000-000000000002", taskThread])
    await until(() => h.saved.delivery?.targets.every((target) => target.inflight === undefined && target.outbox.length === 0) === true, "drained state after rotation")
  } finally { await h.stop(run) }
})

test("a restart drains a delivered target's backlog in batches of 20 and a preserved in-flight batch before its own backlog", async () => {
  const events = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => ({ sessionID: "ses_root", id: `evt_${prefix}_${index}`, type: "session.execution.started", seq: index + 1 }))
  const inflight = events("held", 5)
  const state: FollowState = { ...base(), ownership: [{ groupID: "cgrp_project", sessionID: "ses_member", ownerSessionID: "ses_owner", revision: 28 }],
    delivery: { announced: [], targets: [
      { target: "dot", outbox: events("dot", 32) },
      { target: "thr_task", outbox: events("task", 27), inflight: { threadID: "thr_task", clientMessageID: "00000000-0000-8000-8000-0000000000aa", events: inflight } },
    ] } }
  const h = harness({ state, targets: ["dot", "thr_task"], root: () => "thr_root", statuses: { thr_root: "idle", thr_task: "idle" } })
  const run = h.delivery.run()
  try {
    await until(() => h.saved.delivery?.targets.every((target) => target.inflight === undefined && target.outbox.length === 0) === true, "both backlogs drained")
    const count = (text: string) => [...text.matchAll(/^\d+\. /gm)].length
    expect(h.sends.filter((sent) => sent.threadID === "thr_root").map((sent) => count(sent.text))).toEqual([20, 12])
    const task = h.sends.filter((sent) => sent.threadID === "thr_task")
    expect(task.map((sent) => count(sent.text))).toEqual([5, 20, 7])
    expect(task[0]!.clientMessageID).toBe("00000000-0000-8000-8000-0000000000aa")
    expect(new Set(h.sends.map((sent) => sent.clientMessageID)).size).toBe(5)
    for (const sent of h.sends) expect(sent.text).not.toContain("ownership when this watch started")
  } finally { await h.stop(run) }
})
