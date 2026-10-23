import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Coordination } from "../src/coordination.js"

const create = { name: "Project", masterSessionID: "ses_master", memberSessionIDs: ["ses_member"] }
const decodeCreate = Schema.decodeUnknownSync(Coordination.CreateInput, { onExcessProperty: "error" })

test("Project creation requires exactly one Master field and a bounded member list", () => {
  expect(decodeCreate(create)).toEqual(create as never)
  expect(decodeCreate({ ...create, memberSessionIDs: [] }).memberSessionIDs).toEqual([])
  for (const input of [
    { name: "Project", memberSessionIDs: [] },
    { ...create, masterSessionIDs: ["ses_a", "ses_b"] },
    { ...create, members: [] },
    { ...create, name: "" },
    { ...create, name: "x".repeat(121) },
    { ...create, memberSessionIDs: Array(65).fill("ses_member") },
  ]) expect(() => decodeCreate(input)).toThrow()
})

test("Project settings expose only positive-or-null concurrency and decision narrowing", () => {
  const decode = Schema.decodeUnknownSync(Coordination.GroupSettings, { onExcessProperty: "error" })
  expect(decode({ concurrency: null })).toEqual({ concurrency: null })
  expect(decode({ concurrency: 2, delegatedDecisions: { categories: [] } })).toMatchObject({ concurrency: 2 })
  for (const value of [0, -1, 1.5]) expect(() => decode({ concurrency: value })).toThrow()
  for (const extra of [{ queueCapacity: 10 }, { budget: 1 }, { notifications: {} }])
    expect(() => decode({ concurrency: null, ...extra })).toThrow()
})

test("updates require a revision and omit fields to preserve their values", () => {
  const decode = Schema.decodeUnknownSync(Coordination.UpdateInput, { onExcessProperty: "error" })
  expect(decode({ revision: 3 })).toEqual({ revision: 3 } as never)
  expect(decode({ revision: 3, memberSessionIDs: [], settings: { concurrency: null } })).toMatchObject({ memberSessionIDs: [] })
  expect(() => decode({ name: "Rename" })).toThrow()
  expect(() => decode({ revision: -1 })).toThrow()
  expect(() => decode({ revision: 3, policy: {} })).toThrow()
})

test("participants expose live state, pending native identity, and an optional running driver", () => {
  const input = {
    sessionID: "ses_member", title: "Member", location: { directory: "/workspace" }, state: "waiting", lastActivity: 1,
    pending: [{ kind: "question", requestID: "frm_one", fingerprint: "fp", summary: "Select format" }],
    drivenBy: { sessionID: "ses_child", title: "Driver" },
  }
  expect(Schema.decodeUnknownSync(Coordination.Participant)(input)).toEqual(input as never)
  expect(() => Schema.decodeUnknownSync(Coordination.Participant)({ ...input, state: "armed" })).toThrow()
  expect(Schema.decodeUnknownSync(Coordination.PausedReason)("interrupted")).toBe("interrupted")
  expect(Schema.decodeUnknownSync(Coordination.PausedReason)("restart")).toBe("restart")
  expect(() => Schema.decodeUnknownSync(Coordination.PausedReason)("stopped")).toThrow()
})

test("Project IDs retain cgrp_ and only Project lifecycle facts remain in the event inventory", () => {
  expect(Coordination.GroupID.create()).toMatch(/^cgrp_/)
  expect(() => Schema.decodeUnknownSync(Coordination.GroupID)("ses_member")).toThrow()
  expect(Coordination.DurableDefinitions.map((event) => event.type)).toEqual([
    "coordination.group.created", "coordination.group.changed", "coordination.group.deleted",
  ])
})
