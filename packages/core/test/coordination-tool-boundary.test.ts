import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { Tool } from "@ycoding-ai/plugin/effect/tool"
import { CoordinationTool } from "../src/tool/coordination"

const decode: (input: unknown) => unknown = Schema.decodeUnknownSync(CoordinationTool.Input, { onExcessProperty: "error" })
const record = Schema.Record(Schema.String, Schema.Unknown)
const model = { providerID: "fixture", id: "target", profile: "work" }

const definition = () => Tool.definition("project", Tool.make({
  description: CoordinationTool.description,
  input: CoordinationTool.Input,
  output: Schema.Unknown,
  execute: () => Effect.succeed({}),
}))

const records = (value: unknown): Record<string, unknown>[] => {
  if (Array.isArray(value)) return value.flatMap(records)
  if (!Schema.is(record)(value)) return []
  return [value, ...Object.values(value).flatMap(records)]
}

test("native project definition requires kind and fingerprint for every escalation", () => {
  const branches = records(definition().inputSchema).filter((branch) => {
    const properties = branch.properties
    if (!Schema.is(record)(properties)) return false
    return records(properties.action).some((item) => item.const === "escalate" || (Array.isArray(item.enum) && item.enum.includes("escalate")))
  })
  expect(branches).toHaveLength(1)
  expect(branches[0]?.required).toEqual(expect.arrayContaining(["action", "sessionID", "requestID", "kind", "fingerprint", "reason"]))
  expect(Object.keys(Schema.decodeUnknownSync(record)(branches[0]?.properties))).toEqual(expect.arrayContaining(["kind", "fingerprint"]))
  for (const kind of ["permission", "review", "question"]) {
    const input = { action: "escalate", sessionID: "ses_member", requestID: "request_one", kind, fingerprint: "fingerprint_one", reason: "Needs a human decision" }
    expect(decode(input)).toEqual(input)
    for (const missing of ["fingerprint", "kind"])
      expect(() => decode(Object.fromEntries(Object.entries(input).filter(([key]) => key !== missing)))).toThrow()
  }
})

test("project create accepts a canonical repository project or an explicit worktree but never mixes them", () => {
  const root = { action: "create", projectID: "repository-project", ownerSessionID: "ses_owner", title: "Root member", prompt: "Inspect the project", model }
  const worktree = { action: "create", name: "member-lane", repository: "/synthetic/repository", model }
  expect(decode(root)).toEqual(root)
  expect(decode(worktree)).toEqual(worktree)
  expect(decode({ action: "create", projectID: "repository-project" })).toEqual({ action: "create", projectID: "repository-project" })
  for (const extra of [{ name: "member-lane" }, { repository: "/synthetic/repository" }, { directory: "/synthetic/repository" }, { groupID: "cgrp_other" }, { caller: "ses_other" }, { id: "ses_injected" }])
    expect(() => decode({ ...root, ...extra })).toThrow()
  expect(() => decode({ action: "create" })).toThrow()
})

test("project model reads a member and writes only with an exact expected selection", () => {
  const read = { action: "model", sessionID: "ses_member" }
  const write = { ...read, model, expectedModel: { providerID: "fixture", id: "old", profile: "work", variant: "high" } }
  expect(decode(read)).toEqual(read)
  expect(decode(write)).toEqual(write)
  expect(decode({ ...write, expectedModel: null })).toEqual({ ...write, expectedModel: null })
  for (const invalid of [
    { ...read, model },
    { ...read, expectedModel: null },
    { ...write, model: null },
    { ...write, model: "fixture/target" },
    { ...write, expectedModel: "fixture/old" },
    { ...write, caller: "ses_other" },
    { ...read, sessionID: "msg_other" },
  ]) expect(() => decode(invalid)).toThrow()
})

test("project answer guidance reserves hard and custom-rule approvals for humans", () => {
  expect(CoordinationTool.description).toContain("Hard and custom-rule reviews require a human approval")
  expect(CoordinationTool.description).toContain("Requests marked requireExplicitDecision require a human approval")
  expect(CoordinationTool.description).not.toContain("every explicit-decision class, hard and custom-rule guardrail reviews")
})

test("native project definition exposes remove with exactly action and sessionID", () => {
  const branches = records(definition().inputSchema).filter((branch) => {
    const properties = branch.properties
    if (!Schema.is(record)(properties)) return false
    return records(properties.action).some((item) => item.const === "remove" || (Array.isArray(item.enum) && item.enum.includes("remove")))
  })
  expect(branches).toHaveLength(1)
  expect(branches[0]?.required).toEqual(["action", "sessionID"])
  expect(Object.keys(Schema.decodeUnknownSync(record)(branches[0]?.properties)).sort()).toEqual(["action", "sessionID"])
  expect(branches[0]?.additionalProperties).toBe(false)
  const input = { action: "remove", sessionID: "ses_member" }
  expect(decode(input)).toEqual(input)
  for (const extra of [{ actor: { kind: "human" } }, { groupID: "cgrp_other" }, { caller: "ses_other" }, { reason: "released" }, { ownerSessionID: "ses_owner" }])
    expect(() => decode({ ...input, ...extra })).toThrow()
  expect(() => decode({ action: "remove" })).toThrow()
})

test("project description distinguishes settled history-preserving removal from release parking", () => {
  expect(CoordinationTool.description).toContain("remove: Master only. Detach a settled, verified-complete member whose delivery is integrated or finished: this ends its recorded ownership and its Project membership. It never deletes the Session and preserves the Session and Project histories; release only parks ownership and keeps the member attached.")
})
