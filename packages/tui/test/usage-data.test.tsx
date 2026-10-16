/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import type { SessionMessageInfo, SessionPromptCostsOutput, SessionTaskCostsOutput } from "@ycoding-ai/client"
import { ClientProvider } from "../src/context/client"
import { DataProvider, useData } from "../src/context/data"
import { createApi, createEventStream, createFetch, directory, json, sessionSnapshot } from "./fixture/tui-client"
import { TestTuiContexts } from "./fixture/tui-environment"

test("TUI accounting uses frozen bounded lookups, retains original anchors, and releases them on eviction", async () => {
  const sessionID = "ses_usage"
  const messages: SessionMessageInfo[] = [{ id: "msg_first", type: "user", text: "First", files: [], agents: [], time: { created: 1 } }, { id: "msg_second", type: "user", text: "Next", files: [], agents: [], time: { created: 2 } }]
  const total = { requests: 1, tokens: { input: 10, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: { known: 0, total: 0, pricedRequests: 1, unpricedRequests: 0, provenance: "recorded" as const } }
  const empty = { requests: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: { pricedRequests: 0, unpricedRequests: 0 } }
  const calls: { path: string; ids: string[] }[] = []
  const source = { settled: false, childCost: 0 }
  const events = createEventStream()
  const fetch = createFetch((url) => {
    if (url.pathname.endsWith("/snapshot")) return sessionSnapshot(sessionID, messages)
    if (url.pathname.endsWith("/usage/prompts")) {
      const ids = url.searchParams.getAll("inputIDs")
      calls.push({ path: "prompts", ids })
      const result: SessionPromptCostsOutput = { units: ids.map((inputID) => ({ anchor: { sessionID, inputID }, status: source.settled ? "settled" : "so-far", attribution: "complete", history: "retained", total: inputID === "msg_first" && source.childCost > 0 ? { ...total, requests: 2, tokens: { ...total.tokens, input: 20 }, cost: { ...total.cost, known: source.childCost, total: source.childCost, pricedRequests: 2 } } : total, main: total, children: inputID === "msg_first" && source.childCost > 0 ? { ...total, cost: { ...total.cost, known: source.childCost, total: source.childCost } } : empty, helpers: [] })), unattributed: empty, history: "retained" }
      return json({ data: result })
    }
    if (url.pathname.endsWith("/usage/tasks")) {
      const ids = url.searchParams.getAll("sessionIDs")
      calls.push({ path: "tasks", ids })
      const wrong = { ...total, cost: { ...total.cost, known: 999, total: 999 } }
      const result: SessionTaskCostsOutput = { tasks: [...ids.map((id) => ({ sessionID: id, status: "settled" as const, attribution: "complete" as const, history: "retained" as const, total, main: total, children: empty, helpers: [] })), ...(ids.includes("ses_child_0") ? [{ sessionID: "ses_child_99", status: "settled" as const, attribution: "complete" as const, history: "retained" as const, total: wrong, main: wrong, children: empty, helpers: [] }] : [])], total: { ...total, requests: ids.length, tokens: { ...total.tokens, input: 10 * ids.length }, cost: { ...total.cost, pricedRequests: ids.length } }, history: "retained" }
      return json({ data: result })
    }
    return undefined
  }, events)
  let data!: ReturnType<typeof useData>
  function Probe() { data = useData(); return <text>Accounting ready</text> }
  const app = await testRender(() => <TestTuiContexts><ClientProvider api={createApi(fetch.fetch)}><DataProvider selectedSessionID={() => sessionID}><Probe /></DataProvider></ClientProvider></TestTuiContexts>, { width: 80, height: 12 })
  try {
    app.renderer.start(); await app.waitForFrame((frame) => frame.includes("Accounting ready"))
    await data.session.message.sync(sessionID)
    await data.session.promptCosts.sync(sessionID)
    expect(calls.filter((call) => call.path === "prompts").map((call) => call.ids)).toEqual([["msg_first", "msg_second"]])
    expect(data.session.promptCosts.get(sessionID, "msg_first")?.anchor.inputID).toBe("msg_first")
    expect(data.session.promptCosts.get(sessionID, "msg_second")?.total.cost.total).toBe(0)
    await data.session.taskCosts.sync(sessionID, Array.from({ length: 205 }, (_, index) => `ses_child_${index}`))
    expect(calls.filter((call) => call.path === "tasks").map((call) => call.ids.length)).toEqual([100, 100, 5])
    expect(data.session.taskCosts.get(sessionID, "ses_child_99")?.total.cost.total).toBe(0)
    await data.session.taskCosts.sync(sessionID, Array.from({ length: 205 }, (_, index) => `ses_child_${204 - index}`))
    expect(calls.filter((call) => call.path === "tasks")).toHaveLength(3)
    source.settled = true
    source.childCost = 2
    events.emit({ id: "evt_settled", created: 10, type: "session.execution.succeeded", data: { sessionID }, location: { directory }, durable: { aggregateID: sessionID, seq: 1, version: 1 } })
    await app.waitForFrame(() => data.session.promptCosts.get(sessionID, "msg_first")?.status === "settled" && calls.filter((call) => call.path === "tasks").length === 6)
    expect(data.session.promptCosts.get(sessionID, "msg_first")?.children.cost.total).toBe(2)
    expect(data.session.promptCosts.get(sessionID, "msg_second")?.total.cost.total).toBe(0)
    data.session.message.evict(sessionID)
    expect(data.session.promptCosts.get(sessionID, "msg_first")).toBeUndefined()
  } finally { app.renderer.destroy() }
})

test("accounting ignores unrelated Sessions and settles a family burst with one follow-up per read", async () => {
  const sessionID = "ses_refresh"
  const calls = new Map<string, number>()
  const gates = {
    prompts: [Promise.withResolvers<Response>(), Promise.withResolvers<Response>()],
    tasks: [Promise.withResolvers<Response>(), Promise.withResolvers<Response>()],
  }
  const responses = new Map<string, (amount: number) => Response>()
  const events = createEventStream()
  const tokens = { input: 10, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
  const fetch = createFetch((url) => {
    const ownerID = url.pathname.split("/")[3]!
    if (url.pathname.endsWith("/snapshot")) return sessionSnapshot(ownerID, ownerID === "ses_child" ? [] : [{ id: `msg_${ownerID}`, type: "user", text: "Refresh scope", files: [], agents: [], time: { created: 1 } }], { session: { ...(ownerID === "ses_child" ? { parentID: sessionID } : {}) } })
    const kind = url.pathname.endsWith("/usage/prompts") ? "prompts" : url.pathname.endsWith("/usage/tasks") ? "tasks" : undefined
    if (!kind) return undefined
    const key = `${ownerID}/${kind}`
    const count = (calls.get(key) ?? 0) + 1
    calls.set(key, count)
    const response = (amount: number) => {
      const total = { requests: 1, tokens, cost: { known: amount, total: amount, pricedRequests: 1, unpricedRequests: 0 } }
      const empty = { requests: 0, tokens: { ...tokens, input: 0 }, cost: { pricedRequests: 0, unpricedRequests: 0 } }
      const unit = { status: "settled", attribution: "complete", history: "retained", total, main: total, children: empty, helpers: [] }
      return json({ data: kind === "prompts" ? { units: url.searchParams.getAll("inputIDs").map((inputID) => ({ ...unit, anchor: { sessionID: ownerID, inputID } })), unattributed: empty, history: "retained" } : { tasks: url.searchParams.getAll("sessionIDs").map((id) => ({ ...unit, sessionID: id })), total, history: "retained" } })
    }
    responses.set(kind, response)
    return ownerID === sessionID && count >= 2 && count <= 3 ? gates[kind][count - 2]!.promise : response(0)
  }, events)
  let data!: ReturnType<typeof useData>
  function Probe() { data = useData(); return <text>Refresh probe</text> }
  const app = await testRender(() => <TestTuiContexts><ClientProvider api={createApi(fetch.fetch)}><DataProvider selectedSessionID={() => sessionID}><Probe /></DataProvider></ClientProvider></TestTuiContexts>, { width: 80, height: 12 })
  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("Refresh probe"))
    await data.session.message.sync(sessionID)
    await data.session.message.sync("ses_child")
    await data.session.message.sync("ses_other")
    await data.session.promptCosts.sync(sessionID)
    await data.session.taskCosts.sync(sessionID, ["ses_child"])
    await data.session.promptCosts.sync("ses_other")
    await data.session.taskCosts.sync("ses_other", ["ses_other_child"])
    const emit = (id: string, value: number) => events.emit({ id: `evt_${id}_${value}`, created: value, type: "session.usage.updated", location: { directory }, data: { sessionID: id, cost: value, tokens } })
    emit("ses_other", 9)
    await app.waitFor(() => data.session.get("ses_other")?.cost === 9)
    expect(calls.get(`${sessionID}/prompts`)).toBe(1)
    expect(calls.get(`${sessionID}/tasks`)).toBe(1)
    for (let index = 1; index <= 50; index++) emit("ses_child", index)
    await app.waitFor(() => data.session.get("ses_child")?.cost === 50)
    expect(calls.get(`${sessionID}/prompts`)).toBe(2)
    expect(calls.get(`${sessionID}/tasks`)).toBe(2)
    for (const kind of ["prompts", "tasks"] as const) gates[kind][0]!.resolve(responses.get(kind)!(1))
    await app.waitFor(() => data.session.promptCosts.get(sessionID, `msg_${sessionID}`)?.total.cost.total === 1 && data.session.taskCosts.get(sessionID, "ses_child")?.total.cost.total === 1)
    expect(calls.get(`${sessionID}/prompts`)).toBe(3)
    expect(calls.get(`${sessionID}/tasks`)).toBe(3)
    for (const kind of ["prompts", "tasks"] as const) gates[kind][1]!.resolve(responses.get(kind)!(2))
    await app.waitFor(() => data.session.promptCosts.state(sessionID) === "ready" && data.session.taskCosts.state(sessionID) === "ready")
    expect(data.session.promptCosts.get(sessionID, `msg_${sessionID}`)?.total.cost.total).toBe(2)
    expect(data.session.taskCosts.get(sessionID, "ses_child")?.total.cost.total).toBe(2)
    await data.session.promptCosts.sync("ses_other")
    await data.session.taskCosts.sync("ses_other", ["ses_other_child"])
    expect(calls.get("ses_other/prompts")).toBe(1)
    expect(calls.get("ses_other/tasks")).toBe(1)
  } finally {
    for (const kind of ["prompts", "tasks"] as const) for (const gate of gates[kind]) gate.resolve(responses.get(kind)?.(0) ?? json({}))
    app.renderer.destroy()
  }
})
