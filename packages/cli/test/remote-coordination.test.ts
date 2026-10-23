import { expect, test } from "bun:test"
import type { SessionInfo } from "@ycoding-ai/client/promise"
import { remoteOperationAccess, type RemoteRequest } from "@ycoding-ai/remote"
import type { LocalServer } from "../src/remote-local"
import { coordinationCoordinatorMap, createSessionRegistry, createSubscriptions, executeRemoteOperation } from "../src/remote-operations"
import { excludedOperations, laneOf, tools } from "../src/remote-mcp-schemas"

type Call = { readonly method: string; readonly args: readonly unknown[] }

const group = {
  id: "cgrp_1",
  name: "Project",
  status: "armed",
  revision: 3,
  policy: { concurrency: 2, queueCapacity: 10 },
  fencingGeneration: 1,
  members: [
    { sessionID: "ses_coord", role: "coordinator", location: { directory: "/work" } },
    { sessionID: "ses_worker", role: "worker", location: { directory: "/work" } },
  ],
  claims: [],
  dispatches: [],
  time: { created: 1, updated: 2 },
}

function sessionInfo(id: string): SessionInfo {
  return {
    id,
    projectID: "prj_1",
    model: { providerID: "test", id: "model" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
    title: id,
    location: { directory: "/work", workspaceID: undefined },
  }
}

async function harness(results: Record<string, unknown> = {}) {
  const infos = [sessionInfo("ses_coord"), sessionInfo("ses_worker")]
  results.listPage ??= async () => ({ data: infos })
  results.getSession ??= async (sessionID: string) => infos.find((info) => info.id === sessionID)
  results.coordinationGet ??= group
  const calls: Call[] = []
  const local = new Proxy({} as LocalServer, {
    get(_target, property: PropertyKey) {
      return (...args: unknown[]) => {
        calls.push({ method: String(property), args })
        const result = results[String(property)]
        if (typeof result === "function") return Promise.resolve((result as (...a: unknown[]) => unknown)(...args))
        if (result instanceof Error) return Promise.reject(result)
        return Promise.resolve(result)
      }
    },
  })
  const registry = createSessionRegistry({ local })
  await registry.refresh()
  calls.length = 0
  return { local, calls, registry, subscriptions: createSubscriptions() }
}

function request(operation: RemoteRequest["operation"], input?: Record<string, unknown>, sessionID?: string): RemoteRequest {
  return { type: "request", id: "req_1", operation, ...(sessionID === undefined ? {} : { sessionID }), ...(input === undefined ? {} : { input }) }
}

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

test("coordination reads return the local backend data envelope without a Session or Location input", async () => {
  const fixture = await harness({
    coordinationSettings: { enabled: true, categories: ["question"] },
    coordinationList: [{ id: "cgrp_1" }],
    coordinationReceipts: [{ id: "crcpt_1" }],
    coordinationCapacity: { groupID: "cgrp_1", active: 1 },
  })
  const run = (operation: RemoteRequest["operation"], input?: Record<string, unknown>, sessionID?: string) =>
    executeRemoteOperation({ request: request(operation, input, sessionID), local: fixture.local, sessions: fixture.registry, subscriptions: fixture.subscriptions })
  expect(valueOf(await run("coordination.settings"))).toEqual({ data: { enabled: true, categories: ["question"] } })
  expect(valueOf(await run("coordination.list"))).toEqual({ data: [{ id: "cgrp_1" }] })
  expect(valueOf(await run("coordination.get", { groupID: "cgrp_1" }))).toEqual({ data: group })
  expect(valueOf(await run("coordination.receipts", { groupID: "cgrp_1" }))).toEqual({ data: [{ id: "crcpt_1" }] })
  expect(valueOf(await run("coordination.capacity", { groupID: "cgrp_1" }))).toEqual({ data: { groupID: "cgrp_1", active: 1 } })
  expect(errorOf(await run("coordination.list", undefined, "ses_coord")).code).toBe("invalid_message")
  expect(errorOf(await run("coordination.get", { groupID: "cgrp_1", directory: "/tmp" })).code).toBe("invalid_message")
  expect(fixture.calls.map((call) => call.method)).toEqual(["coordinationSettings", "coordinationList", "coordinationGet", "coordinationReceipts", "coordinationCapacity"])
})

test("coordination create and roster changes verify member Sessions against the backend before any mutation", async () => {
  const fixture = await harness({ coordinationCreate: group, coordinationMembers: group })
  const run = (operation: RemoteRequest["operation"], input: Record<string, unknown>) =>
    executeRemoteOperation({ request: request(operation, input), local: fixture.local, sessions: fixture.registry, subscriptions: fixture.subscriptions })
  const members = [{ sessionID: "ses_coord", role: "coordinator" }, { sessionID: "ses_worker", role: "worker" }]
  expect(valueOf(await run("coordination.create", { name: "Project", policy: { concurrency: null, queueCapacity: 5 }, members }))).toEqual({ data: group })
  expect(fixture.calls.filter((call) => call.method === "coordinationCreate")).toEqual([{ method: "coordinationCreate", args: [{ name: "Project", policy: { concurrency: null, queueCapacity: 5 }, members }] }])
  expect(errorOf(await run("coordination.create", { name: "Project", policy: { concurrency: null, queueCapacity: 5 }, members: [{ sessionID: "ses_missing", role: "coordinator" }] })).code).toBe("session_not_allowed")
  expect(fixture.calls.filter((call) => call.method === "coordinationCreate")).toHaveLength(1)
  expect(valueOf(await run("coordination.members", { groupID: "cgrp_1", revision: 3, name: "Renamed", members }))).toEqual({ data: group })
  expect(fixture.calls.filter((call) => call.method === "coordinationMembers")).toEqual([{ method: "coordinationMembers", args: [{ groupID: "cgrp_1", revision: 3, name: "Renamed", members }] }])
  for (const [operation, method] of [["coordination.arm", "coordinationArm"], ["coordination.stop", "coordinationStop"], ["coordination.complete", "coordinationComplete"]] as const) {
    const current = await harness({ [method]: group })
    expect(valueOf(await executeRemoteOperation({ request: request(operation, { groupID: "cgrp_1", revision: 3 }), local: current.local, sessions: current.registry, subscriptions: current.subscriptions }))).toEqual({ data: group })
    expect(current.calls).toEqual([{ method, args: [{ groupID: "cgrp_1", revision: 3 }] }])
  }
})

test("claim, dispatch, wait, cancelWait and release require the holder to be a current group coordinator", async () => {
  const fixture = await harness({
    coordinationClaim: { groupID: "cgrp_1", holderSessionID: "ses_coord" },
    coordinationDispatch: { id: "cdsp_1" },
    coordinationWait: { waitID: "cwait_1", observations: [] },
    coordinationCancelWait: { waitID: "cwait_1", status: "cancelled" },
    coordinationRelease: { groupID: "cgrp_1", status: "released" },
  })
  const run = (operation: RemoteRequest["operation"], input: Record<string, unknown>) =>
    executeRemoteOperation({ request: request(operation, input), local: fixture.local, sessions: fixture.registry, subscriptions: fixture.subscriptions })
  const claim = { groupID: "cgrp_1", revision: 3, targetSessionID: "ses_worker", holderSessionID: "ses_coord", leaseMs: 60_000 }
  expect(valueOf(await run("coordination.claim", claim))).toEqual({ data: { groupID: "cgrp_1", holderSessionID: "ses_coord" } })
  expect(errorOf(await run("coordination.claim", { ...claim, holderSessionID: "ses_worker" })).code).toBe("forbidden")
  const selection = { agent: "omoikane", model: { providerID: "muse", id: "muse-wonder", variant: "high" }, reason: "Transport boundaries need the systems agent" }
  expect(errorOf(await run("coordination.dispatch", { groupID: "cgrp_1", revision: 3, holderSessionID: "ses_coord", generation: 1, targetSessionID: "ses_worker", text: "Work" })).code).toBe("invalid_message")
  expect(errorOf(await run("coordination.dispatch", { groupID: "cgrp_1", revision: 3, holderSessionID: "ses_worker", generation: 1, targetSessionID: "ses_worker", text: "Work", selection })).code).toBe("forbidden")
  expect(valueOf(await run("coordination.dispatch", { groupID: "cgrp_1", revision: 3, holderSessionID: "ses_coord", generation: 1, targetSessionID: "ses_worker", text: "Work", selection }))).toEqual({ data: { id: "cdsp_1" } })
  expect(fixture.calls.filter((call) => call.method === "coordinationDispatch")).toEqual([{ method: "coordinationDispatch", args: [{ groupID: "cgrp_1", revision: 3, holderSessionID: "ses_coord", generation: 1, targetSessionID: "ses_worker", text: "Work", selection }] }])
  expect(valueOf(await run("coordination.wait", { groupID: "cgrp_1", revision: 3, holderSessionID: "ses_coord", targets: ["ses_worker"] }))).toEqual({ data: { waitID: "cwait_1", observations: [] } })
  expect(errorOf(await run("coordination.wait", { groupID: "cgrp_1", revision: 3, holderSessionID: "ses_missing" })).code).toBe("forbidden")
  expect(valueOf(await run("coordination.cancelWait", { groupID: "cgrp_1", revision: 3, waitID: "cwait_1", holderSessionID: "ses_coord" }))).toEqual({ data: { waitID: "cwait_1", status: "cancelled" } })
  expect(valueOf(await run("coordination.release", { groupID: "cgrp_1", revision: 3, targetSessionID: "ses_worker", holderSessionID: "ses_coord", generation: 1 }))).toEqual({ data: { groupID: "cgrp_1", status: "released" } })
  expect(fixture.calls.filter((call) => call.method === "coordinationClaim")).toHaveLength(1)
  expect(fixture.calls.filter((call) => call.method === "coordinationDispatch")).toHaveLength(1)
  expect(fixture.calls.filter((call) => call.method === "coordinationWait")).toHaveLength(1)
})

test("coordinator attribution maps only verified coordinator source Sessions, never workers or observers", async () => {
  const fixture = await harness({
    coordinationList: [{ id: "cgrp_1" }],
    coordinationGet: { ...group, members: [...group.members, { sessionID: "ses_observer", role: "observer", location: { directory: "/work" } }] },
  })
  const map = await coordinationCoordinatorMap(fixture.local)
  expect(map.get("ses_coord")).toEqual(["ses_coord"])
  expect(map.has("ses_worker")).toBe(false)
  expect(map.has("ses_observer")).toBe(false)
})

test("every coordination operation is exposed as a Relay MCP tool with bounded input and access hints", () => {
  const operations = tools.filter((tool) => tool.operation.startsWith("coordination."))
  expect(operations.map((tool) => tool.name).sort()).toEqual([
    "coordination_arm", "coordination_cancel_wait", "coordination_capacity", "coordination_claim", "coordination_complete",
    "coordination_create", "coordination_dispatch", "coordination_get", "coordination_list", "coordination_members",
    "coordination_receipts", "coordination_release", "coordination_settings", "coordination_stop", "coordination_wait",
  ])
  for (const tool of operations) {
    expect((excludedOperations as readonly string[]).includes(tool.operation)).toBe(false)
    const mutation = remoteOperationAccess[tool.operation as keyof typeof remoteOperationAccess] === "mutation"
    expect(tool.mutation).toBe(mutation)
    expect(tool.annotations.readOnlyHint).toBe(!mutation)
    expect(tool.description.length).toBeGreaterThan(20)
    expect(tool.inputSchema.additionalProperties).toBe(false)
    expect(JSON.stringify(tool.inputSchema)).not.toContain("directory")
  }
  const create = operations.find((tool) => tool.operation === "coordination.create")
  expect(JSON.stringify(create?.inputSchema)).toContain("queueCapacity")
  const dispatch = operations.find((tool) => tool.operation === "coordination.dispatch")
  expect(JSON.stringify(dispatch?.inputSchema)).toContain("selection")
  expect(dispatch && laneOf(dispatch, { input: { groupID: "cgrp_1" } })).toBe("coordination:cgrp_1")
})
