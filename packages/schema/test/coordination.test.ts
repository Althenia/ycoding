import { describe, expect, test } from "bun:test"
import { Schema, SchemaAST } from "effect"
import { Coordination } from "../src/coordination.js"

const decode = <S extends Schema.Decoder<unknown>>(schema: S, input: unknown) =>
  Schema.decodeUnknownSync(schema as never)(input) as S["Type"]
const encode = <S extends Schema.Encoder<unknown>>(schema: S, input: unknown) =>
  Schema.encodeUnknownSync(schema as never)(input) as S["Encoded"]
const rejects = (schema: Schema.Top, input: unknown) =>
  expect(() => Schema.decodeUnknownSync(schema as never)(input)).toThrow()
const strict = (schema: Schema.Top, input: unknown) =>
  Schema.decodeUnknownSync(schema as never, { onExcessProperty: "error" })(input)

const member = { sessionID: "ses_worker", role: "worker" as const }
const coordinator = { sessionID: "ses_coord", role: "coordinator" as const }
const policy = { concurrency: 2, queueCapacity: 10 }

describe("Coordination", () => {
  test("creates prefixed identifiers for every durable identity", () => {
    expect(Coordination.GroupID.create().startsWith("cgrp_")).toBe(true)
    expect(Coordination.DispatchID.create().startsWith("cdsp_")).toBe(true)
    expect(Coordination.WaitID.create().startsWith("cwait_")).toBe(true)
    expect(Coordination.ReceiptID.create().startsWith("crcpt_")).toBe(true)
    expect(decode(Coordination.GroupID, "cgrp_one")).toBe("cgrp_one" as never)
    rejects(Coordination.GroupID, "ses_one")
    rejects(Coordination.GroupID, "cgrp")
    rejects(Coordination.DispatchID, "cgrp_one")
    rejects(Coordination.WaitID, "cdsp_one")
    rejects(Coordination.ReceiptID, "cwait_one")
  })

  test("closes roles, group statuses, and record statuses", () => {
    for (const role of ["coordinator", "worker", "observer"]) expect(decode(Coordination.Role, role)).toBe(role as never)
    rejects(Coordination.Role, "admin")
    for (const status of ["disarmed", "armed", "waiting", "stopped", "completed", "needs-rearm"])
      expect(decode(Coordination.GroupStatus, status)).toBe(status as never)
    rejects(Coordination.GroupStatus, "running")
    for (const status of ["queued", "pending", "admitted", "failed", "cancelled", "completed"])
      expect(decode(Coordination.DispatchStatus, status)).toBe(status as never)
    rejects(Coordination.DispatchStatus, "running")
    for (const status of ["active", "cancelled", "expired"]) expect(decode(Coordination.WaitStatus, status)).toBe(status as never)
    for (const status of ["active", "released", "revoked", "expired"])
      expect(decode(Coordination.ClaimStatus, status)).toBe(status as never)
    for (const reason of ["capacity", "hard-limit", "dependency", "budget"])
      expect(decode(Coordination.QueueReason, reason)).toBe(reason as never)
    rejects(Coordination.QueueReason, "later")
  })

  test("policy requires positive or null concurrency and a bounded queue", () => {
    expect(decode(Coordination.Policy, policy)).toEqual(policy as never)
    expect(decode(Coordination.Policy, { concurrency: null, queueCapacity: 1 }).concurrency).toBeNull()
    rejects(Coordination.Policy, { concurrency: 0, queueCapacity: 10 })
    rejects(Coordination.Policy, { concurrency: -1, queueCapacity: 10 })
    rejects(Coordination.Policy, { concurrency: 1.5, queueCapacity: 10 })
    rejects(Coordination.Policy, { concurrency: 2, queueCapacity: 0 })
    rejects(Coordination.Policy, { concurrency: 2, queueCapacity: 1001 })
    rejects(Coordination.Policy, { queueCapacity: 10 })
    rejects(Coordination.Policy, { concurrency: 2 })
    rejects(Coordination.Policy, { ...policy, budget: 0 })
    rejects(Coordination.Policy, { ...policy, budget: -5 })
    expect(encode(Coordination.Policy, decode(Coordination.Policy, { ...policy, budget: 12.5 }))).toEqual({
      ...policy,
      budget: 12.5,
    })
  })

  test("delegated decisions are bounded, categorized, and absent by default", () => {
    const delegated = { categories: ["question", "permission"], actions: ["read"], resources: ["src/*"], expiresAt: 100 } as const
    const decoded = decode(Coordination.Policy, { ...policy, delegatedDecisions: delegated })
    expect(encode(Coordination.Policy, decoded)).toEqual({ ...policy, delegatedDecisions: delegated })
    expect(encode(Coordination.Policy, decode(Coordination.Policy, policy))).toEqual(policy)
    expect(decode(Coordination.Policy, { ...policy, delegatedDecisions: { categories: [] } }).delegatedDecisions).toEqual({
      categories: [],
    })
    rejects(Coordination.Policy, { ...policy, delegatedDecisions: { categories: ["shell"] } })
    rejects(Coordination.Policy, { ...policy, delegatedDecisions: { categories: ["review"], expiresAt: -1 } })
    rejects(Coordination.Policy, {
      ...policy,
      delegatedDecisions: { categories: ["review"], actions: Array.from({ length: 33 }, (_, index) => `a${index}`) },
    })
  })

  test("settings is a bounded resolved view with an explicit enabled flag", () => {
    const enabled = { enabled: true, categories: ["question", "permission", "review"], actions: ["read"], expiresAt: 50 } as const
    expect(encode(Coordination.Settings, decode(Coordination.Settings, enabled))).toEqual(enabled)
    expect(encode(Coordination.Settings, decode(Coordination.Settings, { enabled: false, categories: [] }))).toEqual({
      enabled: false,
      categories: [],
    })
    rejects(Coordination.Settings, { categories: ["question"] })
    rejects(Coordination.Settings, { enabled: true, categories: ["shell"] })
    rejects(Coordination.Settings, { enabled: true, categories: ["question"], resources: Array.from({ length: 33 }, (_, i) => `r${i}`) })
    rejects(Coordination.Settings, { enabled: true, categories: ["question"], expiresAt: -1 })
  })

  test("create input bounds name, roster, and member scopes and rejects excess keys strictly", () => {
    const input = { name: "Team", policy, members: [coordinator, member] }
    expect(strict(Coordination.CreateInput, input)).toEqual(input as never)
    rejects(Coordination.CreateInput, { ...input, name: "" })
    rejects(Coordination.CreateInput, { ...input, name: "x".repeat(121) })
    rejects(Coordination.CreateInput, { ...input, members: [] })
    rejects(Coordination.MemberInput, { sessionID: "ses_a", role: "owner" })
    rejects(Coordination.MemberInput, { ...member, allowedTools: Array.from({ length: 65 }, (_, index) => `t${index}`) })
    rejects(Coordination.MemberInput, { ...member, resourceScopes: Array.from({ length: 33 }, (_, index) => `r${index}`) })
    rejects(Coordination.MemberInput, { ...member, allowedTools: [""] })
    expect(() => strict(Coordination.CreateInput, { ...input, actor: "human" })).toThrow()
    expect(() => strict(Coordination.MemberInput, { ...member, human: true })).toThrow()
  })

  test("dispatch selection requires an agent, an exact model reference, and a one-line reason", () => {
    const selection = {
      agent: "occam",
      model: { providerID: "fixture", id: "fixture-model", variant: "medium" },
      reason: "A small parser change with settled behavior",
    }
    expect(encode(Coordination.DispatchSelection, decode(Coordination.DispatchSelection, selection))).toEqual(selection)
    const plain = { agent: "god", model: { providerID: "fixture", id: "plain" }, reason: "Coordination only" }
    expect(encode(Coordination.DispatchSelection, decode(Coordination.DispatchSelection, plain))).toEqual(plain)
    rejects(Coordination.DispatchSelection, { model: selection.model, reason: "x" })
    rejects(Coordination.DispatchSelection, { agent: "occam", reason: "x" })
    rejects(Coordination.DispatchSelection, { agent: "occam", model: selection.model })
    for (const reason of ["", " ", "Routine work\nUse medium", "Routine work\u2028Use medium", "Routine work\u2029Use medium", "x".repeat(501)])
      rejects(Coordination.DispatchSelection, { ...selection, reason })
    rejects(Coordination.DispatchSelection, { ...selection, model: { providerID: "fixture" } })
  })

  test("dispatch and wait inputs bound text, dependencies, targets, batch, and timeout", () => {
    const selection = { agent: "occam", model: { providerID: "fixture", id: "fixture-model", variant: "medium" }, reason: "Bounded work" }
    const dispatch = { targetSessionID: "ses_worker", text: "do it", dependsOn: ["cdsp_one"], selection }
    expect(decode(Coordination.DispatchInput, dispatch)).toEqual(dispatch as never)
    rejects(Coordination.DispatchInput, { targetSessionID: "ses_worker", text: "do it" })
    rejects(Coordination.DispatchInput, { ...dispatch, text: "" })
    rejects(Coordination.DispatchInput, { ...dispatch, text: "x".repeat(32001) })
    rejects(Coordination.DispatchInput, { ...dispatch, dependsOn: Array.from({ length: 33 }, (_, index) => `cdsp_${index}`) })
    rejects(Coordination.DispatchInput, { ...dispatch, dispatchID: "cgrp_one" })
    expect(() => strict(Coordination.DispatchInput, { ...dispatch, origin: "coordination" })).toThrow()

    expect(decode(Coordination.WaitInput, {})).toEqual({} as never)
    rejects(Coordination.WaitInput, { batch: 0 })
    rejects(Coordination.WaitInput, { batch: 201 })
    rejects(Coordination.WaitInput, { timeoutMs: -1 })
    rejects(Coordination.WaitInput, { timeoutMs: 300001 })
    rejects(Coordination.WaitInput, { waitID: "cdsp_one" })
  })

  test("capacity reports unreported hard limits as null instead of inventing a bound", () => {
    const unreported = {
      groupID: "cgrp_one",
      concurrency: null,
      hardLimit: null,
      effectiveLimit: null,
      active: 1,
      waiting: 0,
      queued: 2,
      queueCapacity: 10,
      available: null,
      spent: 0,
    }
    expect(encode(Coordination.Capacity, decode(Coordination.Capacity, unreported))).toEqual(unreported)
    const bounded = { ...unreported, concurrency: 4, hardLimit: 3, effectiveLimit: 3, available: 2, runtimeUsed: 1, budget: 5, spent: 1.25, budgetRemaining: 3.75 }
    expect(encode(Coordination.Capacity, decode(Coordination.Capacity, bounded))).toEqual(bounded)
    rejects(Coordination.Capacity, { ...unreported, hardLimit: 0 })
    rejects(Coordination.Capacity, { ...unreported, active: -1 })
  })

  test("observations carry event identity and gap observations are explicit", () => {
    const seen = { sessionID: "ses_worker", eventID: "evt_one", seq: 4, type: "session.agent.selected", time: 9 }
    expect(encode(Coordination.Observation, decode(Coordination.Observation, seen))).toEqual(seen)
    const gap = { sessionID: "ses_worker", seq: 4, type: "coordination.gap", time: 9, gap: true as const }
    expect(encode(Coordination.Observation, decode(Coordination.Observation, gap))).toEqual(gap)
    rejects(Coordination.Observation, { ...seen, seq: -1 })
    rejects(Coordination.Observation, { ...seen, eventID: "cgrp_one" })
  })

  test("role access carries revision, scopes, fence, and live delegation only", () => {
    const access = {
      groupID: "cgrp_one",
      revision: 3,
      status: "armed" as const,
      role: "worker" as const,
      allowedTools: ["read"],
      fencingGeneration: 2,
      delegatedDecisions: { categories: ["question" as const] },
    }
    expect(encode(Coordination.RoleAccess, decode(Coordination.RoleAccess, access))).toEqual(access)
    rejects(Coordination.RoleAccess, { ...access, revision: -1 })
    rejects(Coordination.RoleAccess, { ...access, fencingGeneration: 1.5 })
  })

  test("assignment access keeps the dispatch resource scope separate from member scopes", () => {
    const access = {
      groupID: "cgrp_one",
      revision: 4,
      status: "stopped" as const,
      role: "worker" as const,
      dispatchID: "cdsp_one",
      coordinatorSessionID: "ses_coord",
      generation: 2,
      selection: { agent: "occam", model: { providerID: "fixture", id: "fixture-model", variant: "medium" }, reason: "Bounded work" },
      allowedTools: ["edit"],
      resourceScopes: ["src/*"],
      assignmentResourceScope: "src/api/*",
    }
    expect(encode(Coordination.AssignmentAccess, decode(Coordination.AssignmentAccess, access))).toEqual(access)
    rejects(Coordination.AssignmentAccess, { ...access, role: "observer" })
    rejects(Coordination.AssignmentAccess, { ...access, dispatchID: "cgrp_one" })
  })

  test("group info round-trips with member locations and omits absent optionals", () => {
    const info = {
      id: "cgrp_one",
      name: "Team",
      status: "disarmed" as const,
      revision: 0,
      policy,
      fencingGeneration: 0,
      members: [{ ...coordinator, location: { directory: "/tmp" } }],
      time: { created: 1, updated: 2 },
    }
    expect(encode(Coordination.Info, decode(Coordination.Info, info))).toEqual(info)
    rejects(Coordination.Info, { ...info, revision: -1 })
  })

  test("durable event definitions aggregate by group and Updated is a live invalidation", () => {
    const types = Coordination.DurableDefinitions.map((definition) => definition.type)
    expect(types).toEqual([
      "coordination.group.created",
      "coordination.group.roster-updated",
      "coordination.group.armed",
      "coordination.group.stopped",
      "coordination.group.completed",
      "coordination.group.needs-rearm",
      "coordination.claim.acquired",
      "coordination.claim.released",
      "coordination.claim.revoked",
      "coordination.dispatch.recorded",
      "coordination.dispatch.advanced",
      "coordination.dispatch.settled",
      "coordination.wait.started",
      "coordination.wait.cancelled",
      "coordination.wait.expired",
    ])
    for (const definition of Coordination.DurableDefinitions) {
      expect(definition.durability).toBe("durable")
      expect(definition.durable.aggregate).toBe("groupID")
      expect(definition.durable.version).toBe(1)
    }
    expect(Coordination.Event.Updated.type).toBe("coordination.updated")
    expect(Coordination.Event.Updated.durability).toBe("ephemeral")
    expect(decode(Coordination.Event.Updated.data, { groupID: "cgrp_one", revision: 2 })).toEqual({
      groupID: "cgrp_one",
      revision: 2,
    } as never)
  })

  test("uses unique stable Coordination identifiers", () => {
    const schemas = [
      Coordination.GroupID,
      Coordination.DispatchID,
      Coordination.WaitID,
      Coordination.ReceiptID,
      Coordination.Revision,
      Coordination.Role,
      Coordination.GroupStatus,
      Coordination.DispatchStatus,
      Coordination.WaitStatus,
      Coordination.ClaimStatus,
      Coordination.QueueReason,
      Coordination.DelegatedDecisions,
      Coordination.Settings,
      Coordination.Policy,
      Coordination.MemberInput,
      Coordination.Member,
      Coordination.CreateInput,
      Coordination.Info,
      Coordination.GroupSummary,
      Coordination.ClaimInfo,
      Coordination.DispatchInput,
      Coordination.DispatchInfo,
      Coordination.DispatchSelection,
      Coordination.WaitInput,
      Coordination.Observation,
      Coordination.WaitResult,
      Coordination.Capacity,
      Coordination.Receipt,
      Coordination.RoleAccess,
      Coordination.AssignmentAccess,
    ]
    const names = schemas.map((schema) => SchemaAST.resolveIdentifier((schema as Schema.Top).ast))
    expect(names.every((name) => name?.startsWith("Coordination."))).toBe(true)
    expect(new Set(names).size).toBe(names.length)
  })
})
