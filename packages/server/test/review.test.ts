import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Session } from "@ycoding-ai/core/session"
import { SessionReview } from "@ycoding-ai/core/session/review"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { Permission } from "@ycoding-ai/core/permission"
import { sessionHttp } from "./session-http"

const rootID = Session.ID.make("ses_review_root")
const missingID = Session.ID.make("ses_review_missing")
const itemID = SessionReview.ID.make("rvw_review_test")

type ReviewItem = Effect.Success<ReturnType<SessionReview.Interface["list"]>>[number]
const item: ReviewItem = {
  itemID,
  sessionID: rootID,
  rootSessionID: rootID,
  sessionTitle: "Root",
  created: 1,
  kind: "permission",
  reason: "sleep_entry",
  origin: { requestID: "per_review_test" },
  payload: {
    type: "permission",
    action: "edit",
    resources: ["outside.txt"],
    fingerprint: SessionReview.fingerprint({ action: "edit", resources: ["outside.txt"], workdir: "/project" }),
    requestID: Permission.ID.make("per_review_test"),
  },
}

test("review HTTP routes list family items and map decide outcomes to typed failures", async () => {
  const calls: unknown[] = []
  const locations: string[] = []
  const service = SessionReview.Service.of({
    open: () => Effect.die("unused"),
    withdraw: () => Effect.die("unused"),
    withdrawAfter: () => Effect.die("unused"),
    consume: () => Effect.die("unused"),
    hasOpen: () => Effect.die("unused"),
    reconcile: Effect.die("unused"),
    list: (sessionID) =>
      sessionID === missingID
        ? Effect.fail(new Session.NotFoundError({ sessionID }))
        : Effect.sync(() => {
            calls.push(["list", sessionID])
            return [item]
          }),
    decide: Effect.fn(function* (input: SessionReview.DecideInput) {
      calls.push(["decide", input])
      if (input.sessionID === missingID) return yield* new Session.NotFoundError({ sessionID: input.sessionID })
      if (input.itemID !== itemID) return yield* new SessionReview.NotFoundError({ itemID: input.itemID })
      if (input.decision.kind === "guardrail")
        return yield* new SessionReview.InvalidDecisionError({ itemID: input.itemID, message: "Decision kind does not match the review item" })
      if (input.decision.kind === "permission" && input.decision.reply === "always")
        return yield* new SessionReview.ConflictError({ itemID: input.itemID, message: "Review item already decided" })
    }),
  })

  await using http = sessionHttp({}, { review: service, onLocation: () => { locations.push("resolved") } })
  const listed = await http.request(`/api/session/${rootID}/review`)
  expect(listed.status).toBe(200)
  expect(await listed.json()).toEqual({ data: [item] })
  expect((await http.request(`/api/session/${missingID}/review`)).status).toBe(404)

  const decided = await http.json(`/api/session/${rootID}/review/${itemID}/decide`, "POST", {
    decision: { kind: "permission", reply: "once" },
  })
  expect(decided.status).toBe(204)
  expect(locations.length).toBeGreaterThan(0)
  expect(calls).toContainEqual([
    "decide",
    { sessionID: rootID, itemID, decision: { kind: "permission", reply: "once" } },
  ])
  const missingItem = await http.json(`/api/session/${rootID}/review/rvw_missing/decide`, "POST", {
    decision: { kind: "permission", reply: "once" },
  })
  expect(missingItem.status).toBe(404)
  expect(
    (
      await http.json(`/api/session/${rootID}/review/${itemID}/decide`, "POST", {
        decision: { kind: "guardrail", reply: "always" },
      })
    ).status,
  ).toBe(400)
  expect(
    (
      await http.json(`/api/session/${rootID}/review/${itemID}/decide`, "POST", {
        decision: { kind: "permission", reply: "always" },
      })
    ).status,
  ).toBe(409)
  expect(
    (
      await http.json(`/api/session/${missingID}/review/${itemID}/decide`, "POST", {
        decision: { kind: "permission", reply: "once" },
      })
    ).status,
  ).toBe(404)
  const beforeInvalid = calls.length
  for (const body of [{ decision: { kind: "guardrail", reply: "escalate" } }, { decision: { reply: "once" } }, {}])
    expect((await http.json(`/api/session/${rootID}/review/${itemID}/decide`, "POST", body)).status).toBe(400)
  expect(calls).toHaveLength(beforeInvalid)
})

test("a deferred Session shell reports the review item without an unhandled HTTP failure", async () => {
  const error = new SessionGuardrail.DeferredError({
    requestID: SessionGuardrail.RequestID.make("grq_shell_review"),
    itemID,
    ruleIDs: ["standard.review.git-destructive"],
  })
  await using http = sessionHttp({ shell: () => Effect.fail(error) })
  const response = await http.json(`/api/session/${rootID}/shell`, "POST", { command: "git reset --hard" })
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ _tag: "InvalidRequestError", kind: "guardrail", message: error.message })
})
