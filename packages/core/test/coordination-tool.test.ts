import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Agent } from "@ycoding-ai/schema/agent"
import { Coordination } from "@ycoding-ai/schema/coordination"
import { Model } from "@ycoding-ai/schema/model"
import { Provider } from "@ycoding-ai/schema/provider"
import { Session } from "@ycoding-ai/schema/session"
import { CoordinationTool } from "../src/tool/coordination"

const groupID = Coordination.GroupID.make("cgrp_one")
const targetSessionID = Session.ID.make("ses_target")

test("agent coordination controls expose no human lifecycle or arbitrary actor override", () => {
  const decode = Schema.decodeUnknownSync(CoordinationTool.Input, { onExcessProperty: "error" })
  expect(decode({ action: "list" })).toEqual({ action: "list" })
  expect(decode({ action: "get", groupID: "cgrp_one" })).toEqual({ action: "get", groupID })
  for (const action of ["create", "arm", "stop", "complete", "updateRoster", "setGoal", "setAutonomy"])
    expect(() => decode({ action, groupID: "cgrp_one" })).toThrow()
  expect(() => decode({ action: "get", groupID: "cgrp_one", actor: { kind: "human" } })).toThrow()
  expect(() => decode({ action: "claim", groupID: "cgrp_one", revision: 0, targetSessionID: "ses_target", holderSessionID: "ses_other" })).toThrow()
  expect(() => decode({ action: "get", groupID: "../group" })).toThrow()
})

test("coordinator decisions bind current requests and accept validated question answers without actor overrides", () => {
  const decode = Schema.decodeUnknownSync(CoordinationTool.Input, { onExcessProperty: "error" })
  const inspect = { action: "inspect" as const, groupID, targetSessionID }
  expect(decode(inspect)).toEqual(inspect)
  const decide = { action: "decide" as const, groupID, targetSessionID, kind: "question" as const, requestID: "frm_one", fingerprint: "fingerprint", answer: { format: "markdown" }, confidence: 0.95, rationale: "The assignment specifies a local Markdown report." }
  expect(decode(decide)).toEqual(decide)
  for (const invalid of [{ ...decide, coordinatorSessionID: "ses_other" }, { ...decide, rationale: "" }, { ...decide, confidence: 1.1 }])
    expect(() => decode(invalid)).toThrow()
})

test("dispatch requires an explicit execution choice and a single-line selection reason", () => {
  const decode = Schema.decodeUnknownSync(CoordinationTool.Input, { onExcessProperty: "error" })
  const input = { action: "dispatch" as const, groupID, revision: Coordination.Revision.make(1), generation: Coordination.Revision.make(1), targetSessionID, text: "Check the parser." }
  expect(() => decode(input)).toThrow()
  const selection = { agent: Agent.ID.make("occam"), model: Model.Ref.make({ providerID: Provider.ID.make("fixture"), id: Model.ID.make("fixture-model"), variant: Model.VariantID.make("medium") }), reason: "A small parser change with settled behavior" }
  expect(decode({ ...input, selection })).toEqual({ ...input, selection })
  for (const reason of ["", " ", "Routine work\nUse medium"]) {
    expect(() => decode({ ...input, selection: { ...selection, reason } })).toThrow()
  }
})
