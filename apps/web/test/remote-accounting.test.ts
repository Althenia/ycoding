import { expect, test } from "bun:test"
import { createRemoteHttp } from "../src/remote/http"
import { createRemoteStore } from "../src/remote/store"
import { createRemoteTransport } from "../src/remote/transport"
import { usageSlots } from "../src/remote/ui/team-model"
import { accountingPresentation } from "../src/remote/ui/usage-accounting"
import { accountedTask } from "./usage-fixture"
import { startRelayDouble, waitFor } from "./relay-double"
import { createRemoteStoreClock } from "./remote-store-clock"

test("resident prompt accounting requests actual user IDs and never transfers an absent anchor's cost", async () => {
  const base = accountedTask()
  const unit = (inputID: string, cost: number) => ({ anchor: { sessionID: "ses_a", inputID }, status: "so-far", attribution: "complete", history: "retained", total: accountedTask("ses_child", cost).total, main: accountedTask("ses_child", cost).main, children: base.children, helpers: [] })
  const relay = await startRelayDouble({ messages: { ses_a: [
    { id: "msg_first", type: "user", text: "First", files: [], agents: [], time: { created: 1, consumed: 2 } },
    { id: "msg_synthetic", type: "synthetic", text: "Runtime observation", time: { created: 3 } },
    { id: "msg_newer", type: "user", text: "Next", files: [], agents: [], time: { created: 4, consumed: 5 } },
  ] }, handler: (request) => request.operation === "session.promptCosts" ? { ok: true, value: { data: { units: [unit("msg_first", 2), unit("msg_newer", 0.1), unit("msg_pruned", 99)], unattributed: base.total, history: "retained" } } } : "default" })
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }), createTransport: (id, handlers) => createRemoteTransport({ url: relay.wsURL(id), handlers }) })
  try {
    await store.load()
    await waitFor(() => store.state().transport.kind === "open")
    await store.selectSession("ses_a")
    await waitFor(() => store.state().view?.promptCostState === "ready")
    expect(relay.requests.filter((request) => request.operation === "session.promptCosts").map((request) => request.input)).toEqual([{ inputIDs: ["msg_first", "msg_newer"] }])
    expect(store.state().view?.promptCosts?.map((value) => [value.anchor.inputID, value.total.cost.total])).toEqual([["msg_first", 2], ["msg_newer", 0.1]])
    expect(store.state().view?.promptCosts?.some((value) => value.anchor.inputID === "msg_pruned")).toBe(false)
  } finally { store.dispose(); await relay.stop() }
})

test("settlement refreshes prompt costs without captured records and keeps the original anchor", async () => {
  const source = { cost: 2, settled: false }
  const base = accountedTask()
  const unit = (inputID: string) => ({ anchor: { sessionID: "ses_a", inputID }, status: source.settled ? "settled" : "so-far", attribution: "complete", history: "retained", total: accountedTask("ses_a", inputID === "msg_first" ? source.cost : 0).total, main: accountedTask("ses_a", inputID === "msg_first" ? source.cost : 0).main, children: base.children, helpers: [] })
  const relay = await startRelayDouble({ messages: { ses_a: [
    { id: "msg_first", type: "user", text: "First", files: [], agents: [], time: { created: 1, consumed: 2 } },
    { id: "msg_next", type: "user", text: "Next", files: [], agents: [], time: { created: 3, consumed: 4 } },
  ] }, handler: (request) => {
    if (request.operation === "session.capturedChanges.list") return { ok: false, code: "unknown_operation", message: "Unavailable" }
    if (request.operation === "session.promptCosts") return { ok: true, value: { data: { units: [unit("msg_first"), unit("msg_next")], unattributed: base.children, history: "retained" } } }
    return "default"
  } })
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }), createTransport: (id, handlers) => createRemoteTransport({ url: relay.wsURL(id), handlers }) })
  try {
    await store.load(); await waitFor(() => store.state().transport.kind === "open"); await store.selectSession("ses_a")
    await waitFor(() => store.state().view?.promptCostState === "ready")
    source.cost = 3.5
    relay.pushEvent("ses_a", { id: "evt_parent_settled", created: 10, type: "session.execution.succeeded", data: { sessionID: "ses_a" } })
    await waitFor(() => store.state().view?.promptCosts?.[0]?.total.cost.total === 3.5)
    expect(store.state().view?.promptCosts?.[0]?.status).toBe("so-far")
    expect(store.state().view?.promptCosts?.[1]?.total.cost.total).toBe(0)
    source.settled = true
    relay.pushEvent("ses_a", { id: "evt_child_settled", created: 11, type: "session.task.updated", data: { sessionID: "ses_child", revision: 1, change: { type: "completed" } } })
    await waitFor(() => store.state().view?.promptCosts?.[0]?.status === "settled")
    expect(store.state().view?.promptCosts?.map((value) => value.anchor.inputID)).toEqual(["msg_first", "msg_next"])
  } finally { store.dispose(); await relay.stop() }
})

test("Team accounting refreshes despite retained diagnostics and qualifies a failed lookup until recovery", async () => {
  const source = { failed: false, cost: 0.25 }
  const relay = await startRelayDouble({ handler: (request) => {
    if (request.operation === "session.subagent.list") return { ok: true, value: { data: [{ sessionID: "ses_child", parentID: "ses_a", description: "Task", state: "running", revision: 1, time: { created: 1, updated: 2 } }], summary: { total: 1, active: 1 }, cursor: {} } }
    if (request.operation === "session.taskCosts") return source.failed ? { ok: false, code: "internal_error", message: "Unavailable" } : { ok: true, value: { data: { tasks: [accountedTask("ses_child", source.cost, 20)], total: accountedTask("ses_child", source.cost, 20).total, history: "retained" } } }
    if (request.operation === "session.team.economics") return { ok: true, value: { data: [{ sessionID: "ses_child", tokens: accountedTask("ses_child", 0.25, 20).total.tokens, cacheHitRatio: 0.75, contextTotal: 800, contextLimit: 2000 }] } }
    return "default"
  } })
  const clock = createRemoteStoreClock()
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }), createTransport: (id, handlers) => createRemoteTransport({ url: relay.wsURL(id), handlers }), schedule: clock.schedule, monotonicNow: clock.now })
  const settle = async (expected: () => boolean) => { for (let attempt = 0; attempt < 200 && !expected(); attempt += 1) { await clock.advanceBy(100); await Bun.sleep(5) } }
  try {
    await store.load(); await waitFor(() => store.state().transport.kind === "open"); store.watchTeam(true); await store.selectSession("ses_a")
    await waitFor(() => store.state().team?.status === "ready"); await store.loadTeamControls()
    await waitFor(() => store.state().team?.tasks[0]?.accounting?.total.cost.total === 0.25 && store.state().team?.tasks[0]?.contextTotal === 800)
    source.failed = true
    await clock.advanceBy(5_000)
    relay.pushEvent("ses_a", { id: "evt_cost_failure", created: 10, type: "session.execution.succeeded", data: { sessionID: "ses_a" } })
    await settle(() => store.state().team?.tasks[0]?.accountingUnavailable === true)
    const previous = store.state().team!.tasks[0]!
    expect(usageSlots(previous, {})[1]?.value).toBe("$0.25 · incomplete")
    expect(accountingPresentation(previous.accounting!, previous.accountingUnavailable).reason).toContain("Latest lookup unavailable")
    source.failed = false; source.cost = 2
    await clock.advanceBy(5_000)
    relay.pushEvent("ses_a", { id: "evt_cost_recovery", created: 11, type: "session.execution.succeeded", data: { sessionID: "ses_a" } })
    await settle(() => store.state().team?.tasks[0]?.accounting?.total.cost.total === 2)
    expect(usageSlots(store.state().team!.tasks[0]!, {}).map((slot) => slot.value)).toEqual(["20", "$2.00", "800 / 2,000", "75% hit"])
    expect(relay.requests.filter((request) => request.operation === "session.taskCosts")).toHaveLength(3)
  } finally { store.dispose(); await relay.stop() }
})

test("Team cost reads use frozen recursive task results while context/cache stay diagnostic", async () => {
  const task = accountedTask("ses_child", 0.25, 20)
  const partial = { ...task, status: "so-far" as const, attribution: "partial" as const, total: { ...task.total, cost: { known: 0.25, pricedRequests: 1, unpricedRequests: 1, provenance: "recorded" as const } } }
  const relay = await startRelayDouble({ handler: (request) => {
    if (request.operation === "session.subagent.list") return { ok: true, value: { data: [{ sessionID: "ses_child", parentID: "ses_a", description: "Recursive task", state: "running", revision: 1, time: { created: 1, updated: 2 } }], summary: { total: 1, active: 1 }, cursor: {} } }
    if (request.operation === "session.taskCosts") return { ok: true, value: { data: { tasks: [partial, accountedTask("ses_foreign", 999)], total: partial.total, history: "retained" } } }
    if (request.operation === "session.team.economics") return { ok: true, value: { data: [{ sessionID: "ses_child", cost: 999, tokens: task.total.tokens, cacheHitRatio: 0.75, contextTotal: 800, contextLimit: 2000 }] } }
    return "default"
  } })
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }), createTransport: (id, handlers) => createRemoteTransport({ url: relay.wsURL(id), handlers }) })
  try {
    await store.load(); await waitFor(() => store.state().transport.kind === "open")
    store.watchTeam(true)
    await store.selectSession("ses_a")
    await waitFor(() => store.state().team?.status === "ready")
    await store.loadTeamControls()
    await waitFor(() => store.state().team?.tasks[0]?.accounting !== undefined)
    const row = store.state().team!.tasks[0]!
    expect(row.accounting).toEqual(partial)
    expect(usageSlots(row, {}).map((slot) => slot.value)).toEqual(["20", "Known $0.25 + unreported · so far · incomplete", "800 / 2,000", "75% hit"])
    expect(relay.requests.filter((request) => request.operation === "session.taskCosts").map((request) => request.input)).toEqual([{ sessionIDs: ["ses_child"] }])
    expect(store.state().team?.tasks).toHaveLength(1)
  } finally { store.dispose(); await relay.stop() }
})

function manyTasks(count: number) {
  return Array.from({ length: count }, (_, index) => ({ sessionID: `ses_task_${index}`, parentID: "ses_a", description: `Task ${index}`, state: "running", revision: 1, time: { created: 1, updated: 2 } }))
}

test("with more than 100 tasks and continuous events one task-cost read completes every page, and rereads wait out the interval", async () => {
  const gate = Promise.withResolvers<void>()
  let held = true
  const relay = await startRelayDouble({ handler: async (request) => {
    if (request.operation === "session.subagent.list") return { ok: true, value: { data: manyTasks(150), summary: { total: 150, active: 150 }, cursor: {} } }
    if (request.operation === "session.taskCosts") {
      if (held) await gate.promise
      const ids = (request.input as { sessionIDs: string[] }).sessionIDs
      return { ok: true, value: { data: { tasks: ids.map((id) => accountedTask(id, 0.25, 20)), total: accountedTask("ses_a").total, history: "retained" } } }
    }
    return "default"
  } })
  const clock = createRemoteStoreClock()
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }), createTransport: (id, handlers) => createRemoteTransport({ url: relay.wsURL(id), handlers }), schedule: clock.schedule, monotonicNow: clock.now })
  const costReads = () => relay.requests.filter((request) => request.operation === "session.taskCosts").map((request) => (request.input as { sessionIDs: string[] }).sessionIDs.length)
  const burst = async (prefix: string) => {
    for (let index = 0; index < 20; index += 1) relay.pushEvent("ses_a", { id: `evt_${prefix}_${index}`, created: 10 + index, type: "session.usage.updated", data: { sessionID: "ses_a" } })
    await Bun.sleep(40)
    await clock.advanceBy(100)
    await Bun.sleep(20)
  }
  const accounted = () => store.state().team?.tasks.filter((task) => task.accounting !== undefined).length ?? 0
  try {
    await store.load(); await waitFor(() => store.state().transport.kind === "open"); store.watchTeam(true); await store.selectSession("ses_a")
    await waitFor(() => costReads().length === 1)
    await burst("held")
    expect(costReads()).toEqual([100])
    held = false
    gate.resolve()
    await waitFor(() => accounted() === 150)
    expect(costReads()).toEqual([100, 50])
    await burst("settled")
    expect(costReads()).toEqual([100, 50])
    await clock.advanceBy(4_999)
    expect(costReads()).toEqual([100, 50])
    await clock.advanceBy(1)
    await waitFor(() => costReads().length === 4)
    expect(costReads()).toEqual([100, 50, 100, 50])
    await burst("again")
    await clock.advanceBy(4_000)
    expect(costReads()).toEqual([100, 50, 100, 50])
  } finally { gate.resolve(); store.dispose(); await relay.stop() }
})

test("a connector without task costs shows the update state once and is not asked again", async () => {
  const relay = await startRelayDouble({ handler: (request) => {
    if (request.operation === "session.subagent.list") return { ok: true, value: { data: manyTasks(2), summary: { total: 2, active: 2 }, cursor: {} } }
    if (request.operation === "session.taskCosts") return { ok: false, code: "unknown_operation", message: "Unavailable" }
    return "default"
  } })
  const clock = createRemoteStoreClock()
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }), createTransport: (id, handlers) => createRemoteTransport({ url: relay.wsURL(id), handlers }), schedule: clock.schedule, monotonicNow: clock.now })
  try {
    await store.load(); await waitFor(() => store.state().transport.kind === "open"); store.watchTeam(true); await store.selectSession("ses_a")
    await waitFor(() => store.state().team?.accountingUnsupported === true)
    const task = store.state().team!.tasks[0]!
    expect(usageSlots(task, { accountingUnsupported: true }).slice(0, 2).map((slot) => [slot.state, slot.value])).toEqual([["unsupported", "Update YCoding"], ["unsupported", "Update YCoding"]])
    expect(usageSlots(task, {}).slice(0, 2).map((slot) => slot.state)).toEqual(["unreported", "unreported"])
    relay.pushEvent("ses_a", { id: "evt_after_unsupported", created: 10, type: "session.execution.succeeded", data: { sessionID: "ses_a" } })
    await Bun.sleep(40); await clock.advanceBy(10_000); await Bun.sleep(20)
    expect(relay.requests.filter((request) => request.operation === "session.taskCosts")).toHaveLength(1)
    expect(store.state().team?.tasks.every((entry) => entry.accountingUnavailable !== true)).toBe(true)
  } finally { store.dispose(); await relay.stop() }
})
