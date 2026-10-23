/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { ConfigProvider } from "../src/config"
import { ClientProvider } from "../src/context/client"
import { CoordinationProvider, useCoordination } from "../src/context/coordination"
import { capacitySummary, queueReasonLabel } from "../src/util/coordination"
import { backend, delegatedDecisions, dispatch, groupID, leadID, location, watcherID, workerID, type WriteBody } from "./fixture/coordination-backend"
import { createApi, createEventStream, createFetch } from "./fixture/tui-client"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

async function mount(
  server: ReturnType<typeof backend>,
  options: { config?: Parameters<typeof createTuiResolvedConfig>[0] } = {},
) {
  const events = createEventStream()
  const fetch = createFetch(server.route, events)
  let coordination!: ReturnType<typeof useCoordination>
  function Probe() {
    coordination = useCoordination()
    return (
      <text>
        {coordination.error()
          ? `error ${coordination.error()}`
          : (coordination.groups() ?? []).map((group) => `${group.name} ${group.status}`).join(" | ") || "loading"}
      </text>
    )
  }
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig(options.config)}>
          <ClientProvider api={createApi(fetch.fetch)}>
            <CoordinationProvider>
              <Probe />
            </CoordinationProvider>
          </ClientProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 8 },
  )
  app.renderer.start()
  return { app, events, coordination: () => coordination }
}

async function until(check: () => boolean, label: string, timeout = 5_000) {
  const deadline = Date.now() + timeout
  while (!check() && Date.now() < deadline) await Bun.sleep(10)
  if (!check()) throw new Error(`Timed out waiting for ${label}`)
}

function emit(events: ReturnType<typeof createEventStream>, type: "coordination.group.armed" | "coordination.group.needs-rearm", revision: number) {
  events.emit({
    id: `evt_${type}_${revision}`,
    created: revision,
    type,
    data: { groupID, revision },
    location,
    durable: { aggregateID: groupID, seq: revision, version: 1 },
  })
}

test("the provider loads groups, capacity, receipts and Session titles through the generated client", async () => {
  const server = backend({ dispatches: [dispatch("q1", "queued", "capacity")] })
  const { app, coordination } = await mount(server)
  try {
    await app.waitForFrame((frame) => frame.includes("Release train armed"))
    const group = coordination().groups()![0]!
    expect(group).toMatchObject({
      id: groupID,
      name: "Release train",
      status: "armed",
      revision: 7,
      capacity: { active: 2, hardLimit: 5 },
      policy: { concurrency: 3, queueCapacity: 40, budget: 5 },
    })
    expect(group.roster).toEqual([
      { sessionID: leadID, title: "Lead session", role: "coordinator", allowedTools: ["read"], resourceScopes: ["/repo/**"] },
      { sessionID: workerID, title: "Worker A", role: "worker", allowedTools: ["read", "grep"], resourceScopes: ["/repo/src/**"] },
      { sessionID: watcherID, title: "Watcher", role: "observer" },
    ])
    expect(group.policy.delegatedDecisions).toEqual({ ...delegatedDecisions, categories: ["permission", "review"] })
    expect(group.receipts.map((receipt) => receipt.worker)).toEqual(["Worker A"])
    expect(group.receipts[0]!.selection).toEqual({
      agent: "omoikane",
      model: { providerID: "anthropic", id: "claude-sonnet-5-5", variant: "high" },
      reason: "Needs deep reasoning",
    })
    expect(group.queue[0]!.selection).toEqual({
      agent: "build",
      model: { providerID: "openai", id: "gpt-6", profile: "work" },
      reason: "Quick lease check",
    })
    expect(group.leases).toEqual([{ id: `${workerID}:1`, holder: "Lead session", resource: "Worker A", expiresAt: 99 }])
    expect(coordination().sessions().map((item) => item.sessionID)).toEqual([leadID, watcherID, workerID])
    expect(server.state.sessionQueries.map((url) => [url.searchParams.get("parentID"), url.searchParams.get("cursor")])).toEqual(
      expect.arrayContaining([["null", null], ["null", "page-2"]]),
    )
  } finally {
    app.renderer.destroy()
  }
})

test("a terminal session-list cursor of null ends pagination and keeps every Session title", async () => {
  const server = backend({ lastCursor: { next: null } })
  const page = await createApi(createFetch(server.route, createEventStream()).fetch).session.list({ parentID: null, limit: 200, cursor: "page-2" })
  expect(page.cursor.next).toBeNull()
  const { app, coordination } = await mount(server)
  try {
    await app.waitForFrame((frame) => frame.includes("Release train armed"))
    expect(coordination().sessions().map((item) => item.title)).toEqual(["Lead session", "Watcher", "Worker A"])
    expect(server.state.sessionQueries.map((url) => url.searchParams.get("cursor"))).toSatisfy((cursors: Array<string | null>) =>
      cursors.length > 0 && cursors.every((cursor) => cursor === null || cursor === "page-2"),
    )
  } finally {
    app.renderer.destroy()
  }
})

test("queue reasons carry each actual backend reason as a readable sentence", async () => {
  const reasons = ["capacity", "hard-limit", "dependency", "budget"]
  const server = backend({ dispatches: reasons.map((reason) => dispatch(reason, "queued", reason)) })
  const { app, coordination } = await mount(server)
  try {
    await app.waitForFrame((frame) => frame.includes("Release train armed"))
    const queue = coordination().groups()![0]!.queue
    expect(queue.map((item) => item.reason)).toEqual(reasons)
    for (const item of queue) expect(queueReasonLabel(item.reason)).not.toStartWith("reason ")
  } finally {
    app.renderer.destroy()
  }
})

test("a backend that reports no hard limit never renders a null or zero bound", async () => {
  const server = backend({ capacity: { hardLimit: null, effectiveLimit: null, available: null, concurrency: null } })
  const { app, coordination } = await mount(server)
  try {
    await app.waitForFrame((frame) => frame.includes("Release train armed"))
    const group = coordination().groups()![0]!
    const summary = capacitySummary(group.capacity, group.policy)
    expect(summary).not.toContain("null")
    expect(summary).not.toContain("0/0")
  } finally {
    app.renderer.destroy()
  }
})

test("the resolved global delegation policy is loaded and stays unavailable when it cannot be read", async () => {
  const server = backend()
  const { app, coordination } = await mount(server)
  try {
    await app.waitForFrame((frame) => frame.includes("Release train armed"))
    expect(coordination().globalDelegation()).toEqual({
      enabled: true,
      categories: ["permission", "review"],
      actions: ["shell:git status"],
      expiresAt: 5_000_000_000_000,
    })
  } finally {
    app.renderer.destroy()
  }
  const unavailable = backend()
  unavailable.state.settings = undefined
  const second = await mount(unavailable)
  try {
    await second.app.waitForFrame((frame) => frame.includes("Release train armed"))
    expect(second.coordination().globalDelegation()).toBeUndefined()
    expect(second.coordination().groups()).toHaveLength(1)
  } finally {
    second.app.renderer.destroy()
  }
})

test("a failed load surfaces the error, and a coordination event recovers it", async () => {
  const server = backend()
  server.state.failList = true
  const { app, events, coordination } = await mount(server)
  try {
    await app.waitForFrame((frame) => frame.includes("error"))
    expect(coordination().error()).toBeTruthy()
    expect(coordination().groups()).toBeUndefined()
    server.state.failList = false
    emit(events, "coordination.group.armed", 8)
    await app.waitForFrame((frame) => frame.includes("Release train armed"))
    expect(coordination().error()).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("a disconnected event stream reconnects and reloads the groups", async () => {
  const server = backend()
  const { app, events } = await mount(server)
  try {
    await app.waitForFrame((frame) => frame.includes("Release train armed"))
    await until(() => events.subscriptions() > 0, "event subscription")
    const before = server.state.calls.filter((path) => path === "/api/coordination").length
    events.disconnect()
    server.state.status = "stopped"
    await until(() => server.state.calls.filter((path) => path === "/api/coordination").length > before, "reload after reconnect", 6_000)
    await app.waitForFrame((frame) => frame.includes("Release train stopped"))
  } finally {
    app.renderer.destroy()
  }
})

test("a durable coordination event refreshes the displayed lifecycle status", async () => {
  const server = backend()
  const { app, events } = await mount(server)
  try {
    await app.waitForFrame((frame) => frame.includes("Release train armed"))
    await until(() => events.subscriptions() > 0, "event subscription")
    server.state.status = "needs-rearm"
    emit(events, "coordination.group.needs-rearm", 8)
    await app.waitForFrame((frame) => frame.includes("Release train needs-rearm"))
  } finally {
    app.renderer.destroy()
  }
})

type MemberFields = { sessionID: string; role: string; allowedTools?: ReadonlyArray<string>; resourceScopes?: ReadonlyArray<string> }

function memberFields(body: WriteBody): MemberFields[] {
  return (body.members ?? []).map((member) => ({
    sessionID: member.sessionID,
    role: member.role,
    allowedTools: member.allowedTools,
    resourceScopes: member.resourceScopes,
  }))
}

const loadedMembers = [
  { sessionID: leadID, role: "coordinator", allowedTools: ["read"], resourceScopes: ["/repo/**"] },
  { sessionID: workerID, role: "worker", allowedTools: ["read", "grep"], resourceScopes: ["/repo/src/**"] },
  { sessionID: watcherID, role: "observer" },
]

async function member(change: (service: ReturnType<typeof useCoordination>["service"]) => Promise<void>) {
  const server = backend()
  const { app, coordination } = await mount(server)
  try {
    await app.waitForFrame((frame) => frame.includes("Release train armed"))
    await change(coordination().service)
    return server.state.writes.find((item) => item.method === "PUT" && item.path.endsWith("/members"))
  } finally {
    app.renderer.destroy()
  }
}

test("editing capacity sends only the changed fields and keeps the delegated-decision narrowing and member limits", async () => {
  const write = await member((service) => service.updatePolicy(groupID, { concurrency: 2, queueCapacity: 10 }))
  expect(write!.body.revision).toBe(7)
  expect(write!.body.policy).toEqual({ concurrency: 2, queueCapacity: 10, budget: 5, delegatedDecisions })
  expect(memberFields(write!.body)).toEqual(loadedMembers)
})

test("an explicit uncapped concurrency reaches the backend as null while narrowing stays", async () => {
  const write = await member((service) => service.updatePolicy(groupID, { concurrency: null }))
  expect(write!.body.policy).toEqual({ concurrency: null, queueCapacity: 40, budget: 5, delegatedDecisions })
})

test("clearing the budget removes it and leaves the narrowing", async () => {
  const write = await member((service) => service.updatePolicy(groupID, { budget: null }))
  expect(write!.body.policy).toEqual({ concurrency: 3, queueCapacity: 40, delegatedDecisions })
  expect(write!.body.policy).not.toHaveProperty("budget")
})

test("delegated decisions can be narrowed, disabled with no categories, or returned to the global policy", async () => {
  const narrowed = await member((service) =>
    service.updatePolicy(groupID, { delegatedDecisions: { categories: ["permission"], actions: ["shell:ls"] } }),
  )
  expect(narrowed!.body.policy).toEqual({
    concurrency: 3,
    queueCapacity: 40,
    budget: 5,
    delegatedDecisions: { categories: ["permission"], actions: ["shell:ls"] },
  })
  const disabled = await member((service) => service.updatePolicy(groupID, { delegatedDecisions: { categories: [] } }))
  expect(disabled!.body.policy).toEqual({ concurrency: 3, queueCapacity: 40, budget: 5, delegatedDecisions: { categories: [] } })
  const inherited = await member((service) => service.updatePolicy(groupID, { delegatedDecisions: null }))
  expect(inherited!.body.policy).toEqual({ concurrency: 3, queueCapacity: 40, budget: 5 })
  expect(inherited!.body.policy).not.toHaveProperty("delegatedDecisions")
})

test("changing a role keeps every member's tool and scope limits, demotes the previous coordinator and sends no policy", async () => {
  const observer = await member((service) => service.setMemberRole(groupID, workerID, "observer"))
  expect(memberFields(observer!.body)).toEqual([
    loadedMembers[0],
    { ...loadedMembers[1], role: "observer" },
    loadedMembers[2],
  ])
  expect(observer!.body.policy).toBeUndefined()
  const promoted = await member((service) => service.setMemberRole(groupID, workerID, "coordinator"))
  expect(memberFields(promoted!.body)).toEqual([
    { ...loadedMembers[0], role: "worker" },
    { ...loadedMembers[1], role: "coordinator" },
    loadedMembers[2],
  ])
})

test("member access edits change one member and clearing a list means all", async () => {
  const tools = await member((service) => service.setMemberAccess(groupID, workerID, { allowedTools: ["read"] }))
  expect(memberFields(tools!.body)).toEqual([loadedMembers[0], { ...loadedMembers[1], allowedTools: ["read"] }, loadedMembers[2]])
  const cleared = await member((service) => service.setMemberAccess(groupID, workerID, { resourceScopes: undefined }))
  expect(memberFields(cleared!.body)).toEqual([loadedMembers[0], { ...loadedMembers[1], resourceScopes: undefined }, loadedMembers[2]])
})

test("adding a member sends a worker without invented limits, and removal refuses the only coordinator before any write", async () => {
  const added = await member((service) => service.addMember(groupID, "ses_fresh00000001", "worker"))
  expect(memberFields(added!.body)).toEqual([...loadedMembers, { sessionID: "ses_fresh00000001", role: "worker" }])
  const removed = await member((service) => service.removeMember(groupID, watcherID))
  expect(memberFields(removed!.body)).toEqual(loadedMembers.slice(0, 2))
  const server = backend()
  const { app, coordination } = await mount(server)
  try {
    await app.waitForFrame((frame) => frame.includes("Release train armed"))
    await expect(coordination().service.removeMember(groupID, leadID)).rejects.toThrow("A group needs exactly one coordinator")
    expect(server.state.writes).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("renaming sends the name with the loaded revision and the unchanged members", async () => {
  const write = await member((service) => service.rename(groupID, "Shipping train"))
  expect(write!.body.name).toBe("Shipping train")
  expect(write!.body.revision).toBe(7)
  expect(memberFields(write!.body)).toEqual(loadedMembers)
})

test("a lifecycle call sends the loaded revision and reloads the group afterwards", async () => {
  const server = backend()
  const { app, coordination } = await mount(server)
  try {
    await app.waitForFrame((frame) => frame.includes("Release train armed"))
    const before = server.state.calls.filter((path) => path === "/api/coordination").length
    server.state.status = "stopped"
    await coordination().service.stop(groupID)
    expect(server.state.writes.map((item) => [item.method, item.path, item.body])).toEqual([
      ["POST", `/api/coordination/${groupID}/stop`, { revision: 7 }],
    ])
    expect(server.state.calls.filter((path) => path === "/api/coordination").length).toBeGreaterThan(before)
    await app.waitForFrame((frame) => frame.includes("Release train stopped"))
  } finally {
    app.renderer.destroy()
  }
})

test("external delivery follows the persisted filter and the loaded coordinator roots", async () => {
  const everything = await mount(backend())
  try {
    await everything.app.waitForFrame((frame) => frame.includes("Release train armed"))
    for (const sessionID of [leadID, workerID, "ses_other"]) expect(everything.coordination().externalAllowed(sessionID, "failure")).toBe(true)
  } finally {
    everything.app.renderer.destroy()
  }
  const coordinators = await mount(backend(), { config: { attention: { coordination: { scope: "coordinators", categories: ["failure"] } } } })
  try {
    await coordinators.app.waitForFrame((frame) => frame.includes("Release train armed"))
    const allowed = coordinators.coordination().externalAllowed
    expect(allowed(leadID, "failure")).toBe(true)
    expect(allowed(leadID, "completion")).toBe(false)
    expect(allowed(workerID, "failure")).toBe(false)
    expect(allowed(watcherID, "failure")).toBe(false)
  } finally {
    coordinators.app.renderer.destroy()
  }
})
