import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Model } from "@ycoding-ai/schema/model"
import { ModelGroup } from "../src/groups/model.js"

test("default model responses preserve model info and explicit variant/profile selection", () => {
  const success = [...ModelGroup.endpoints["model.default"].success][0]
  if (!success) throw new Error("Missing model.default success contract")
  const ref = Model.Ref.parse("openai/gpt-6.1-sol#high")
  const model = Model.Info.empty(ref.providerID, ref.id)
  const response = Schema.decodeUnknownSync(Schema.make<Schema.Codec<unknown, unknown>>(success.ast))({
    location: { directory: "/fixture", project: { id: "global", directory: "/fixture" } },
    data: { ...model, selection: { ...ref, profile: "Work", credentialID: "cred_private" } },
  })
  expect(response).toMatchObject({
    data: {
      id: ref.id,
      providerID: ref.providerID,
      selection: { ...ref, profile: "Work" },
    },
  })
  expect(JSON.stringify(response)).not.toContain("cred_private")
})
