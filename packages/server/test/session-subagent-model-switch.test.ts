import { expect, test } from "bun:test"
import { Deferred, Effect } from "effect"
import { Agent } from "@ycoding-ai/core/agent"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Provider } from "@ycoding-ai/core/provider"
import { Session } from "@ycoding-ai/core/session"
import type { SessionOrchestration } from "@ycoding-ai/core/session/orchestration"
import { sessionHttp } from "./session-http"

const model = CatalogModel.Ref.make({ providerID: Provider.ID.make("openai"), id: CatalogModel.ID.make("gpt-6.1-sol-ultrafast"), variant: CatalogModel.VariantID.make("high") })
test("native child model HTTP endpoint returns authoritative task only after settlement", async () => {
  const entered = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  const expected: Parameters<SessionOrchestration.Interface["switchModel"]>[0] = { parentID: Session.ID.make("ses_parent"), childID: Session.ID.make("ses_child"), expectedModel: model, model, source: { type: "native" } }
  await using http = sessionHttp({}, { orchestration: { switchModel: input => Effect.gen(function* () {
    expect(input).toEqual(expected)
    yield* Deferred.succeed(entered, undefined)
    yield* Deferred.await(release)
    return { sessionID: Session.ID.make("ses_child"), parentID: Session.ID.make("ses_parent"), description: "Task", agent: Agent.ID.make("build"), model, background: true, state: "running" as const, revision: 2, time: { created: 1, updated: 2 } }
  }) } })
  let settled = false
  const request = http.json("/api/session/ses_parent/subagent/ses_child/model", "POST", { expectedModel: model, model }).then(value => { settled = true; return value })
  const first = await Promise.race([request, Effect.runPromise(Deferred.await(entered)).then(() => undefined)])
  expect(first).toBeUndefined()
  expect(settled).toBe(false)
  await Effect.runPromise(Deferred.succeed(release, undefined))
  expect(await (await request).json()).toMatchObject({ data: { model, sessionID: "ses_child" } })
})
