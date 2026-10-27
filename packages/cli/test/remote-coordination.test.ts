import { expect, test } from "bun:test"
import type { SessionInfo } from "@ycoding-ai/client/promise"
import type { RemoteRequest } from "@ycoding-ai/remote"
import { LocalFailure, type LocalServer } from "../src/remote-local"
import { coordinationCoordinatorMap, createSessionRegistry, createSubscriptions, executeRemoteOperation } from "../src/remote-operations"

const participant = (sessionID: string) => ({ sessionID, title: sessionID, state: "idle", lastActivity: 1, pending: [], location: { directory: "/work" } })
const group = { id: "cgrp_1", name: "Project", revision: 3, active: false, master: participant("ses_master"), members: [participant("ses_member")], settings: { concurrency: null }, time: { created: 1, updated: 2 } }

function sessionInfo(id: string): SessionInfo {
  return { id, projectID: "prj_1", model: { providerID: "test", id: "model" }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 }, title: id, location: { directory: "/work", workspaceID: undefined } }
}

async function harness(results: Record<string, unknown> = {}) {
  const infos = [sessionInfo("ses_master"), sessionInfo("ses_member")]
  results.listPage ??= () => ({ data: infos })
  results.getSession ??= (id: string) => infos.find((info) => info.id === id)
  results.coordinationGet ??= group
  const calls: { method: string; args: unknown[] }[] = []
  const local = new Proxy({} as LocalServer, { get(_target, property) {
    return (...args: unknown[]) => {
      calls.push({ method: String(property), args })
      const result = results[String(property)]
      if (result instanceof Error) return Promise.reject(result)
      return Promise.resolve(typeof result === "function" ? result(...args) : result)
    }
  } })
  const sessions = createSessionRegistry({ local })
  await sessions.refresh()
  calls.length = 0
  const run = (operation: RemoteRequest["operation"], input?: Record<string, unknown>, sessionID?: string) => executeRemoteOperation({
    request: { type: "request", id: "req_1", operation, ...(input === undefined ? {} : { input }), ...(sessionID === undefined ? {} : { sessionID }) },
    local, sessions, subscriptions: createSubscriptions(),
  })
  return { local, calls, run }
}

const success = (value: unknown) => [expect.objectContaining({ ok: true, value })]
const failure = (code: string) => [expect.objectContaining({ ok: false, error: expect.objectContaining({ code }) })]

test("Project reads are sessionless and preserve backend envelopes", async () => {
  const fixture = await harness({ coordinationSettings: { enabled: true, categories: ["question"] }, coordinationList: [{ id: "cgrp_1", masterSessionID: "ses_master" }] })
  expect(await fixture.run("coordination.settings")).toEqual(success({ data: { enabled: true, categories: ["question"] } }))
  expect(await fixture.run("coordination.list")).toEqual(success({ data: [{ id: "cgrp_1", masterSessionID: "ses_master" }] }))
  expect(await fixture.run("coordination.get", { groupID: "cgrp_1" })).toEqual(success({ data: group }))
  expect(await fixture.run("coordination.list", undefined, "ses_master")).toEqual(failure("invalid_message"))
  expect(await fixture.run("coordination.get", { groupID: "cgrp_1", directory: "/tmp" })).toEqual(failure("invalid_message"))
  expect(fixture.calls.map((call) => call.method)).toEqual(["coordinationSettings", "coordinationList", "coordinationGet"])
})

test("Project mutations verify supplied Session identities and preserve partial updates", async () => {
  const fixture = await harness({ coordinationCreate: group, coordinationUpdate: group })
  const create = { name: "Project", masterSessionID: "ses_master", memberSessionIDs: ["ses_member"] }
  expect(await fixture.run("coordination.create", create)).toEqual(success({ data: group }))
  for (const fields of [{ masterSessionID: "ses_missing" }, { memberSessionIDs: ["ses_missing"] }])
    expect(await fixture.run("coordination.create", { ...create, ...fields })).toEqual(failure("session_not_allowed"))
  const update = { groupID: "cgrp_1", revision: 3, name: "Renamed", memberSessionIDs: [], settings: { concurrency: null } }
  expect(await fixture.run("coordination.update", update)).toEqual(success({ data: group }))
  expect(await fixture.run("coordination.update", { groupID: "cgrp_1", revision: 3, masterSessionID: "ses_missing" })).toEqual(failure("session_not_allowed"))
  expect(fixture.calls.filter((call) => call.method === "coordinationCreate")).toEqual([{ method: "coordinationCreate", args: [create] }])
  expect(fixture.calls.filter((call) => call.method === "coordinationUpdate")).toEqual([{ method: "coordinationUpdate", args: [update] }])
  expect(await fixture.run("coordination.delete", { groupID: "cgrp_1" })).toEqual(success({}))
  expect(fixture.calls.at(-1)).toEqual({ method: "coordinationDelete", args: [{ groupID: "cgrp_1" }] })
})

test("Session deletion resolves its Location from backend inventory", async () => {
  const fixture = await harness()
  expect(await fixture.run("session.delete", undefined, "ses_member")).toEqual(success({}))
  expect(fixture.calls.at(-1)).toEqual({ method: "deleteSession", args: ["ses_member", { directory: "/work" }] })
  expect(await fixture.run("session.delete", { directory: "/tmp" }, "ses_member")).toEqual(failure("invalid_message"))
  expect(await fixture.run("session.delete", undefined, "ses_missing")).toEqual(failure("session_not_allowed"))
  expect(fixture.calls.filter((call) => call.method === "deleteSession")).toHaveLength(1)
})

test("master attribution comes from summaries without roster reads", async () => {
  const fixture = await harness({ coordinationList: [{ id: "cgrp_1", masterSessionID: "ses_master" }] })
  expect([...await coordinationCoordinatorMap(fixture.local)]).toEqual([["ses_master", ["ses_master"]]])
  expect(fixture.calls.map((call) => call.method)).toEqual(["coordinationList"])
})

test("unconfirmed Project and Session mutations are never replayed", async () => {
  for (const [operation, method, input, sessionID] of [
    ["coordination.create", "coordinationCreate", { name: "Project", masterSessionID: "ses_master", memberSessionIDs: [] }, undefined],
    ["coordination.update", "coordinationUpdate", { groupID: "cgrp_1", revision: 3 }, undefined],
    ["coordination.delete", "coordinationDelete", { groupID: "cgrp_1" }, undefined],
    ["session.delete", "deleteSession", undefined, "ses_member"],
  ] as const) {
    const fixture = await harness({ [method]: new LocalFailure("transport", "Socket closed") })
    expect(await fixture.run(operation, input, sessionID)).toEqual(failure("outcome_unknown"))
    expect(fixture.calls.filter((call) => call.method === method)).toHaveLength(1)
  }
})
