import { expect, test } from "bun:test"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { SessionV2 } from "@ycoding-ai/core/session"
import { Effect } from "effect"
import { sessionHttp } from "./session-http"
import { Guardrail } from "../../schema/src/guardrail"

const parentID = SessionV2.ID.make("ses_guardrail_parent")
const childID = SessionV2.ID.make("ses_guardrail_child")
const unrelatedID = SessionV2.ID.make("ses_guardrail_unrelated")
const requestID = SessionGuardrail.RequestID.create("grq_guardrail_test")

type GuardrailStatus = Effect.Success<ReturnType<SessionGuardrail.Interface["status"]>>
type GuardrailRequest = Effect.Success<ReturnType<SessionGuardrail.Interface["forSession"]>>[number]

const status: GuardrailStatus = new Guardrail.Status({
  rootSessionID: parentID,
  profile: "standard",
  customRules: 1,
  approvals: 2,
  blocked: 3,
  counters: [new Guardrail.Counter({ id: "shell", current: 1, limit: 8, scope: "family" })],
  invalidFiles: [],
})

const request: GuardrailRequest = new Guardrail.Request({
  id: requestID,
  rootSessionID: parentID,
  sessionID: childID,
  action: "shell",
  resources: ["git reset --hard"],
  ruleIDs: ["standard.git.destructive"],
  reason: "Destructive Git operation",
  standard: true,
})

test("guardrail HTTP routes preserve family ownership, normalized output, and typed failures", async () => {
  const calls: unknown[] = []
  const snapshot = (sessionID: SessionV2.ID) =>
    Effect.succeed({ sequence: 0, digest: sessionID === childID ? parentID : sessionID })
  const service = SessionGuardrail.Service.of({
    evaluate: () => Effect.die("unused"),
    assert: () => Effect.die("unused"),
    snapshot,
    withSnapshot: (sessionID, use) => snapshot(sessionID).pipe(Effect.flatMap(use)),
    status: (sessionID) => sessionID === unrelatedID
      ? Effect.fail(new SessionV2.NotFoundError({ sessionID }))
      :
      Effect.sync(() => {
        calls.push(["status", sessionID])
        return status
      }),
    forSession: (sessionID) =>
      Effect.sync(() => {
        calls.push(["list", sessionID])
        return [request]
      }),
    reply: (input) =>
      Effect.sync(() => calls.push(["reply", input])).pipe(
        Effect.andThen(
          input.sessionID === unrelatedID
            ? Effect.fail(new SessionGuardrail.RequestNotFoundError({ requestID: input.requestID }))
            : Effect.void,
        ),
      ),
  })

  await using http = sessionHttp({}, { guardrail: service })
  const current = await http.request(`/api/session/${childID}/guardrail`)
  expect(current.status).toBe(200)
  expect(await current.json()).toEqual({ data: status })
  const reviews = await http.request(`/api/session/${parentID}/guardrail/request`)
  expect(reviews.status).toBe(200)
  expect(await reviews.json()).toEqual({ data: [request] })
  expect((await http.json(`/api/session/${parentID}/guardrail/request/${requestID}/reply`, "POST", { reply: "always" })).status).toBe(204)
  const denied = await http.json(`/api/session/${unrelatedID}/guardrail/request/${requestID}/reply`, "POST", { reply: "reject" })
  expect(denied.status).toBe(404)
  expect(await denied.json()).toMatchObject({ _tag: "GuardrailRequestNotFoundError", requestID })
  const missing = await http.request(`/api/session/${unrelatedID}/guardrail`)
  expect(missing.status).toBe(404)
  expect(await missing.json()).toMatchObject({ _tag: "SessionNotFoundError", sessionID: unrelatedID })
  expect(calls).toEqual([
    ["status", childID],
    ["list", parentID],
    ["reply", { sessionID: parentID, requestID, reply: "always" }],
    ["reply", { sessionID: unrelatedID, requestID, reply: "reject" }],
  ])
})
