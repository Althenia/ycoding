import { expect, test } from "bun:test"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { SessionV2 } from "@ycoding-ai/core/session"
import { Effect } from "effect"
import {
  GuardrailHandler,
  guardrailRequests,
  guardrailStatus,
  replyGuardrail,
} from "../src/handlers/guardrail"

const parentID = SessionV2.ID.make("ses_guardrail_parent")
const childID = SessionV2.ID.make("ses_guardrail_child")
const unrelatedID = SessionV2.ID.make("ses_guardrail_unrelated")
const requestID = SessionGuardrail.RequestID.create("grq_guardrail_test")

type GuardrailStatus = Effect.Success<ReturnType<SessionGuardrail.Interface["status"]>>
type GuardrailRequest = Effect.Success<ReturnType<SessionGuardrail.Interface["forSession"]>>[number]

const status: GuardrailStatus = {
  rootSessionID: parentID,
  profile: "standard",
  customRules: 1,
  approvals: 2,
  blocked: 3,
  counters: [{ id: "shell", current: 1, limit: 8, scope: "family" as const }],
  invalidFiles: [],
}

const request: GuardrailRequest = {
  id: requestID,
  rootSessionID: parentID,
  sessionID: childID,
  action: "shell",
  resources: ["git reset --hard"],
  ruleIDs: ["standard.git.destructive"],
  reason: "Destructive Git operation",
  standard: true,
}

test("guardrail handlers preserve family ownership and normalized output", async () => {
  const calls: unknown[] = []
  const service = SessionGuardrail.Service.of({
    evaluate: () => Effect.die("unused"),
    assert: () => Effect.die("unused"),
    status: (sessionID) =>
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

  expect(await Effect.runPromise(guardrailStatus(service, childID))).toEqual(status)
  expect(await Effect.runPromise(guardrailRequests(service, parentID))).toEqual([request])
  await Effect.runPromise(replyGuardrail(service, { sessionID: parentID, requestID, reply: "always" }))

  await expect(
    Effect.runPromise(replyGuardrail(service, { sessionID: unrelatedID, requestID, reply: "reject" })),
  ).rejects.toMatchObject({ _tag: "GuardrailRequestNotFoundError", requestID })
  expect(calls).toEqual([
    ["status", childID],
    ["list", parentID],
    ["reply", { sessionID: parentID, requestID, reply: "always" }],
    ["reply", { sessionID: unrelatedID, requestID, reply: "reject" }],
  ])
  expect(GuardrailHandler).toBeDefined()
})

test("guardrail handler registers every Session route", async () => {
  const source = await Bun.file(new URL("../src/handlers/guardrail.ts", import.meta.url)).text()
  expect(source).toContain('"session.guardrail.status"')
  expect(source).toContain('"session.guardrail.request.list"')
  expect(source).toContain('"session.guardrail.request.reply"')
})
