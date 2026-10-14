import { expect, test } from "bun:test"
import { REMOTE_SCENARIOS } from "../verify/remote-scenarios"
import { typedFixtureOutcome } from "./wire-fixture"

const scenarios = [...new Map(REMOTE_SCENARIOS.map((scenario) => [scenario.name, scenario])).values()].filter(
  (scenario) => scenario.sessions.length > 0,
)

test.each(scenarios)("public scenario $name retains its transcript through the v5 snapshot contract", (scenario) => {
  const outcome = typedFixtureOutcome("session.snapshot", {
    status: "ok",
    value: {
      sourceEpoch: "fixture-epoch",
      session: scenario.sessions[0],
      messages: scenario.messages,
      watermark: { type: "log.synced", aggregateID: scenario.sessions[0]!.id, seq: 1 },
    },
  })
  expect(outcome).toMatchObject({ status: "ok", value: { data: { messages: scenario.messages } } })
})
