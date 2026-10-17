import { expect, test } from "bun:test"
import { createRemoteHttp } from "../src/remote/http"
import { createRemoteStore } from "../src/remote/store"
import { createRemoteTransport } from "../src/remote/transport"
import { usageSlots } from "../src/remote/ui/team-model"
import { accountingPresentation } from "../src/remote/ui/usage-accounting"
import { accountedTask } from "./usage-fixture"
import { startRelayDouble, waitFor } from "./relay-double"
import { createRemoteStoreClock } from "./remote-store-clock"

const listedTask = (sessionID: string, description: string) => ({
  sessionID,
  parentID: "ses_a",
  description,
  agent: "builder",
  model: { providerID: "openai", id: "gpt-5" },
  background: true,
  state: "running",
  revision: 1,
  time: { created: 1, updated: 2 },
})
const taskSummary = (total: number) => ({ total, active: total, running: total, waiting: 0 })
const usageTokens = { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }

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
    relay.pushEvent("ses_a", { id: "evt_child_settled", created: 11, type: "session.task.updated", data: { sessionID: "ses_child", change: { type: "completed" } } })
    await waitFor(() => store.state().view?.promptCosts?.[0]?.status === "settled")
    expect(store.state().view?.promptCosts?.map((value) => value.anchor.inputID)).toEqual(["msg_first", "msg_next"])
  } finally { store.dispose(); await relay.stop() }
})

test("Team accounting refreshes despite retained diagnostics and qualifies a failed lookup until recovery", async () => {
  const source = { failed: false, cost: 0.25 }
  const relay = await startRelayDouble({ handler: (request) => {
    if (request.operation === "session.subagent.list") return { ok: true, value: { data: [listedTask("ses_child", "Task")], summary: taskSummary(1), cursor: {} } }
    if (request.operation === "session.taskCosts") return source.failed ? { wire: (peer, dispatch) => peer.error(dispatch, "ycoding.v5.ServiceUnavailableError", { _tag: "ServiceUnavailableError", message: "Unavailable" }) } : { ok: true, value: { data: { tasks: [accountedTask("ses_child", source.cost, 20)], total: accountedTask("ses_child", source.cost, 20).total, history: "retained" } } }
    if (request.operation === "session.team.economics") return { ok: true, value: { data: [{ sessionID: "ses_child", cost: 999, tokens: accountedTask("ses_child", 0.25, 20).total.tokens, cacheHitRatio: 0.75, contextTotal: 800, contextLimit: 2000 }] } }
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
    if (request.operation === "session.subagent.list") return { ok: true, value: { data: [listedTask("ses_child", "Recursive task")], summary: taskSummary(1), cursor: {} } }
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
  return Array.from({ length: count }, (_, index) => listedTask(`ses_task_${index}`, `Task ${index}`))
}

test("with more than 100 tasks and continuous events one task-cost read completes every page, and rereads wait out the interval", async () => {
  const gate = Promise.withResolvers<void>()
  let held = true
  const relay = await startRelayDouble({ handler: async (request) => {
    if (request.operation === "session.subagent.list") return { ok: true, value: { data: manyTasks(150), summary: taskSummary(150), cursor: {} } }
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
    for (let index = 0; index < 20; index += 1) relay.pushEvent("ses_a", { id: `evt_${prefix}_${index}`, created: 10 + index, type: "session.usage.updated", data: { sessionID: "ses_a", cost: 0.01, tokens: usageTokens } })
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

test("a failed task-cost lookup leaves the cards unreported and the next accounting event recovers", async () => {
  const source = { failed: true }
  const relay = await startRelayDouble({ handler: (request) => {
    if (request.operation === "session.subagent.list") return { ok: true, value: { data: manyTasks(2), summary: taskSummary(2), cursor: {} } }
    if (request.operation === "session.taskCosts") {
      if (source.failed) return { wire: (peer, dispatch) => peer.error(dispatch, "ycoding.v5.ServiceUnavailableError", { _tag: "ServiceUnavailableError", message: "Unavailable" }) }
      const ids = (request.input as { sessionIDs: string[] }).sessionIDs
      return { ok: true, value: { data: { tasks: ids.map((id) => accountedTask(id, 0.25, 20)), total: accountedTask("ses_a").total, history: "retained" } } }
    }
    return "default"
  } })
  const clock = createRemoteStoreClock()
  const recovery = Promise.withResolvers<void>()
  const store = createRemoteStore({
    http: createRemoteHttp({ baseURL: relay.httpURL }),
    createTransport: (id, handlers) =>
      createRemoteTransport({
        url: relay.wsURL(id),
        handlers: {
          ...handlers,
          onEvents: (sessionID, events) => {
            handlers.onEvents?.(sessionID, events)
            const delivered = events.some(
              (event) => typeof event === "object" && event !== null && Reflect.get(event, "id") === "evt_after_failure",
            )
            if (delivered) recovery.resolve()
          },
        },
      }),
    schedule: clock.schedule,
    monotonicNow: clock.now,
  })
  const tasks = () => store.state().team?.tasks ?? []
  try {
    await store.load(); await waitFor(() => store.state().transport.kind === "open"); store.watchTeam(true); await store.selectSession("ses_a")
    await waitFor(() => tasks().length === 2 && tasks().every((task) => task.accountingUnavailable === true))
    const task = tasks()[0]!
    expect(task.accounting).toBeUndefined()
    expect(usageSlots(task, {}).slice(0, 2).map((slot) => [slot.state, slot.value])).toEqual([["unreported", "—"], ["unreported", "—"]])
    source.failed = false
    relay.pushEvent("ses_a", { id: "evt_after_failure", created: 10, type: "session.execution.succeeded", data: { sessionID: "ses_a" } })
    await recovery.promise
    await clock.advanceBy(5_000)
    await waitFor(() => tasks().length === 2 && tasks().every((entry) => entry.accounting !== undefined && entry.accountingUnavailable === false))
    expect(usageSlots(tasks()[0]!, {}).slice(0, 2).map((slot) => slot.value)).toEqual(["20", "$0.25"])
  } finally { store.dispose(); await relay.stop() }
})

test("events that arrive while a prompt-cost read is in flight share one trailing reread", async () => {
  const gate = Promise.withResolvers<void>()
  let reads = 0
  const relay = await startRelayDouble({
    messages: { ses_a: [{ id: "msg_first", type: "user", text: "First", files: [], agents: [], time: { created: 1, consumed: 2 } }] },
    handler: async (request): Promise<"default"> => {
      if (request.operation !== "session.promptCosts") return "default"
      reads += 1
      if (reads === 1) await gate.promise
      return "default"
    },
  })
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }), createTransport: (id, handlers) => createRemoteTransport({ url: relay.wsURL(id), handlers }) })
  try {
    await store.load()
    await waitFor(() => store.state().transport.kind === "open")
    await store.selectSession("ses_a")
    await waitFor(() => reads === 1)
    expect(store.state().view?.promptCostState).toBe("loading")
    for (let index = 0; index < 20; index += 1)
      relay.pushEvent("ses_a", { id: `evt_usage_${index}`, created: 10 + index, type: "session.usage.updated", data: { cost: 0.01, tokens: usageTokens } })
    relay.pushEvent("ses_a", { id: "evt_done", created: 40, type: "session.execution.succeeded", data: {} })
    await Bun.sleep(150)
    expect(reads).toBe(1)
    gate.resolve()
    await waitFor(() => reads === 2 && store.state().view?.promptCostState === "ready")
    await Bun.sleep(100)
    expect(reads).toBe(2)
  } finally {
    gate.resolve()
    store.dispose()
    await relay.stop()
  }
})

test("a prompt-cost answer that settles after the selection moved never paints the new Session", async () => {
  const gate = Promise.withResolvers<void>()
  const unit = (sessionID: string, inputID: string) => ({
    anchor: { sessionID, inputID },
    status: "settled",
    attribution: "complete",
    history: "retained",
    total: accountedTask(sessionID, 9).total,
    main: accountedTask(sessionID, 9).main,
    children: accountedTask(sessionID, 9).children,
    helpers: [],
  })
  const relay = await startRelayDouble({
    messages: {
      ses_a: [{ id: "msg_a", type: "user", text: "A", files: [], agents: [], time: { created: 1, consumed: 2 } }],
      ses_b: [{ id: "msg_b", type: "user", text: "B", files: [], agents: [], time: { created: 1, consumed: 2 } }],
    },
    handler: async (request) => {
      if (request.operation !== "session.promptCosts") return "default"
      if (request.sessionID === "ses_a") await gate.promise
      const sessionID = request.sessionID ?? ""
      return { ok: true, value: { data: { units: [unit(sessionID, sessionID === "ses_a" ? "msg_a" : "msg_b")], unattributed: accountedTask().children, history: "retained" } } }
    },
  })
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }), createTransport: (id, handlers) => createRemoteTransport({ url: relay.wsURL(id), handlers }) })
  try {
    await store.load()
    await waitFor(() => store.state().transport.kind === "open")
    await store.selectSession("ses_a")
    await waitFor(() => relay.requests.some((request) => request.operation === "session.promptCosts" && request.sessionID === "ses_a"))
    await store.selectSession("ses_b")
    await waitFor(() => store.state().view?.id === "ses_b" && store.state().view?.promptCostState === "ready")
    gate.resolve()
    await Bun.sleep(100)
    expect(store.state().view?.id).toBe("ses_b")
    expect(store.state().view?.promptCosts?.map((value) => value.anchor.sessionID)).toEqual(["ses_b"])
  } finally {
    gate.resolve()
    store.dispose()
    await relay.stop()
  }
})

test("a prompt-cost lookup that cannot be read marks the view unavailable without dropping the previous units", async () => {
  const source = { failed: false }
  const unit = { anchor: { sessionID: "ses_a", inputID: "msg_first" }, ...accountedTask("ses_a", 0.5), helpers: [] }
  const relay = await startRelayDouble({
    messages: { ses_a: [{ id: "msg_first", type: "user", text: "First", files: [], agents: [], time: { created: 1, consumed: 2 } }] },
    handler: (request) => {
      if (request.operation !== "session.promptCosts") return "default"
      return source.failed
        ? { wire: (peer, dispatch) => peer.error(dispatch, "ycoding.v5.ServiceUnavailableError", { _tag: "ServiceUnavailableError", message: "Unavailable" }) }
        : { ok: true, value: { data: { units: [unit], unattributed: accountedTask().children, history: "retained" } } }
    },
  })
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }), createTransport: (id, handlers) => createRemoteTransport({ url: relay.wsURL(id), handlers }) })
  try {
    await store.load()
    await waitFor(() => store.state().transport.kind === "open")
    await store.selectSession("ses_a")
    await waitFor(() => store.state().view?.promptCostState === "ready")
    source.failed = true
    relay.pushEvent("ses_a", { id: "evt_failed_read", created: 10, type: "session.execution.succeeded", data: {} })
    await waitFor(() => store.state().view?.promptCostState === "unavailable")
    expect(store.state().view?.promptCosts?.map((value) => value.anchor.inputID)).toEqual(["msg_first"])
  } finally {
    store.dispose()
    await relay.stop()
  }
})
