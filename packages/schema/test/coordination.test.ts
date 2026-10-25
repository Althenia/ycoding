import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Coordination } from "../src/coordination.js"
import { EventManifest } from "../src/event-manifest.js"
import { Form } from "../src/form.js"
import { Guardrail } from "../src/guardrail.js"
import { Permission } from "../src/permission.js"
import { SessionReview } from "../src/session-review.js"

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

test("escalation chains carry one to four bounded per-Session reasons on live requests, review payloads, and the refresh event", () => {
  const chain = { reasons: [{ sessionID: "ses_driver", reason: "Needs the owner's choice." }, { sessionID: "ses_master", reason: "Outside the assignment." }] }
  const decode = Schema.decodeUnknownSync(Coordination.Escalation, { onExcessProperty: "error" })
  expect(decode(chain)).toEqual(chain as never)
  for (const invalid of [
    { reasons: [] },
    { reasons: Array(5).fill(chain.reasons[0]) },
    { reasons: [{ sessionID: "ses_driver", reason: " " }] },
    { reasons: [{ sessionID: "ses_driver", reason: "x".repeat(501) }] },
    { reasons: [{ sessionID: "per_one", reason: "Not a Session" }] },
  ]) expect(() => decode(invalid)).toThrow()

  const permission = { id: "per_one", sessionID: "ses_member", action: "read", resources: ["src/a"] }
  expect(Schema.decodeUnknownSync(Permission.Request)(permission)).toEqual(permission as never)
  expect(Schema.decodeUnknownSync(Permission.Request)({ ...permission, coordinationEscalation: chain }).coordinationEscalation).toEqual(chain as never)
  const review = { id: "grq_one", rootSessionID: "ses_member", sessionID: "ses_member", action: "edit", resources: [], ruleIDs: [], reason: "r", standard: true }
  expect(Schema.decodeUnknownSync(Guardrail.Request)({ ...review, coordinationEscalation: chain }).coordinationEscalation).toEqual(chain as never)
  const form = { id: "frm_one", sessionID: "ses_member", title: "Pick", fields: [{ key: "choice", type: "string" }] }
  expect(Schema.decodeUnknownSync(Form.Info)({ ...form, coordinationEscalation: chain }).coordinationEscalation).toEqual(chain as never)
  expect(Schema.encodeSync(Form.Info)(Schema.decodeUnknownSync(Form.Info)(form))).not.toHaveProperty("coordinationEscalation")

  const fingerprint = "a".repeat(64)
  for (const payload of [
    { type: "permission", action: "read", resources: [], fingerprint, requestID: "per_one" },
    { type: "guardrail", action: "edit", resources: [], ruleIDs: [], reason: "r", hardReview: false, directories: [], fingerprint, requestID: "grq_one" },
    { type: "form", title: "Pick", fields: form.fields },
  ]) {
    expect(Schema.decodeUnknownSync(SessionReview.Payload)(payload)).toEqual(payload as never)
    expect(Schema.decodeUnknownSync(SessionReview.Payload)({ ...payload, coordinationEscalation: chain })).toMatchObject({ coordinationEscalation: chain })
  }

  const refresh = { sessionID: "ses_member", kind: "permission", requestID: "per_one", coordinationEscalation: chain }
  expect(Schema.decodeUnknownSync(Coordination.Event.RequestEscalated.data)(refresh)).toEqual(refresh as never)
  expect(EventManifest.Server.get("coordination.request.escalated")).toBe(Coordination.Event.RequestEscalated)
  expect(EventManifest.Durable.has("coordination.request.escalated.1")).toBe(false)
})

test("Project IDs retain cgrp_ and only Project lifecycle and member ownership facts are in the event inventory", () => {
  expect(Coordination.GroupID.create()).toMatch(/^cgrp_/)
  expect(() => Schema.decodeUnknownSync(Coordination.GroupID)("ses_member")).toThrow()
  expect(Coordination.DurableDefinitions.map((event) => event.type)).toEqual([
    "coordination.group.created", "coordination.group.changed", "coordination.group.deleted", "coordination.member.owner.changed",
  ])
})
