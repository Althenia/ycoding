import { expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionOrchestration } from "../src/session-orchestration.js"
import { Model } from "../src/model.js"
import { Provider } from "../src/provider.js"
import { Session } from "../src/session.js"

const model = Model.Ref.make({ providerID: Provider.ID.make("openai"), id: Model.ID.make("gpt-6.1-sol-ultrafast"), variant: Model.VariantID.make("high"), profile: "Work" })
const input: SessionOrchestration.Control = { action: "switch_model", sessionID: Session.ID.make("ses_child"), expectedModel: model, model }

test("child model control requires an exact target and expected selection", () => {
  const decode = Schema.decodeUnknownSync(SessionOrchestration.Control, { onExcessProperty: "error" })
  expect(decode(input)).toEqual(input)
  for (const value of [
    { ...input, expectedModel: undefined }, { ...input, model: undefined },
    { ...input, parentID: "ses_foreign" }, { ...input, origin: "human" },
    { ...input, directory: "/tmp" }, { ...input, force: true },
  ]) expect(() => decode(value)).toThrow()
})
