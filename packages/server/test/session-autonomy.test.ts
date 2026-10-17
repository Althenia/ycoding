import { expect, test } from "bun:test"
import { Session } from "@ycoding-ai/core/session"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SessionGoal } from "@ycoding-ai/core/session/goal"
import { Deferred, Effect } from "effect"
import { sessionHttp } from "./session-http"

const sessionID = Session.ID.make("ses_goal_http")
const effective = {
  yolo: 2 as const,
  asleep: false,
  guardrailsEnabled: true,
  ordinaryReviewsAuto: true,
  modelReviews: false,
  hardModelReviews: false,
}

function fixture(set: Session.Interface["autonomy"]["set"]) {
  const http = sessionHttp({
    autonomy: {
      get: () => Effect.succeed(SessionAutonomy.defaultState),
      effective: () => Effect.succeed(effective),
      set,
    },
  })
  return {
    request: (payload: Record<string, unknown>) => http.json(`/api/session/${sessionID}/autonomy`, "PUT", payload),
    read: () => http.request(`/api/session/${sessionID}/autonomy`),
    [Symbol.asyncDispose]: http[Symbol.asyncDispose],
  }
}

test("R7 goal route preserves explicit resume, replacement, and stop with YOLO", async () => {
  const received: unknown[] = []
  await using f = fixture(input => Effect.sync(() => {
    received.push(input)
    return SessionAutonomy.defaultState
  }))
  for (const goal of [true, "Ship the tested change\nPreserve existing data", null]) {
    const response = await f.request({ goal, yolo: 1 })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { ...SessionAutonomy.defaultState, effective } })
    expect(received.at(-1)).toEqual({ sessionID, goal, yolo: 1 })
  }
})

test("autonomy routes preserve effective settings and the independent answer toggle", async () => {
  const received: unknown[] = []
  await using f = fixture(input => Effect.sync(() => {
    received.push(input)
    return { ...SessionAutonomy.defaultState, autoAnswer: input.autoAnswer }
  }))
  const read = await f.read()
  expect(read.status).toBe(200)
  expect(await read.json()).toEqual({ data: { ...SessionAutonomy.defaultState, effective } })
  for (const autoAnswer of [true, false]) {
    const response = await f.request({ autoAnswer })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { ...SessionAutonomy.defaultState, autoAnswer, effective } })
    expect(received.at(-1)).toEqual({ sessionID, autoAnswer })
  }
})

test("reference autonomy rejects unsupported sleep and removed levels without mutation", async () => {
  const received: unknown[] = []
  await using f = fixture(input => Effect.sync(() => {
    received.push(input)
    return SessionAutonomy.defaultState
  }))
  for (const payload of [{ sleep: true }, { sleep: false }, { yolo: 3 }]) {
    const response = await f.request(payload)
    expect(response.status).toBe(400)
  }
  expect(received).toEqual([])
})

test("R7 goal route does not acknowledge before calculation settles", async () => {
  const entered = Deferred.makeUnsafe<void>()
  const settle = Deferred.makeUnsafe<void>()
  await using f = fixture(() => Effect.gen(function* () {
    yield* Deferred.succeed(entered, undefined)
    yield* Deferred.await(settle)
    return SessionAutonomy.defaultState
  }))
  const state = { settled: false }
  const pending = f.request({ goal: "Verify the release" }).then(response => {
    state.settled = true
    return response
  })
  await Effect.runPromise(Deferred.await(entered))
  expect(state.settled).toBe(false)
  await Effect.runPromise(Deferred.succeed(settle, undefined))
  expect((await pending).status).toBe(200)
})

test("R7 goal route retains the typed missing-Session failure", async () => {
  await using f = fixture(() => Effect.fail(new Session.NotFoundError({ sessionID })))
  const response = await f.request({ goal: true })
  expect(response.status).toBe(404)
  expect(await response.json()).toMatchObject({ _tag: "SessionNotFoundError", sessionID })
})

test("R7 goal route maps bounded calculation and resume failures", async () => {
  const cases = [
    { code: "goal.no_retained_goal", status: 400, tag: "InvalidRequestError" },
    { code: "goal.stale_calculation", status: 409, tag: "ConflictError" },
    { code: "goal.model_unavailable", status: 500, tag: "UnknownError" },
    { code: "goal.calculation_failed", status: 500, tag: "UnknownError" },
  ] as const
  for (const item of cases) {
    await using f = fixture(() => Effect.fail(new SessionGoal.Error({ code: item.code })))
    const response = await f.request({ goal: "Verify the release" })
    expect(response.status).toBe(item.status)
    const body = await response.json()
    expect(body).toMatchObject({ _tag: item.tag, message: expect.stringMatching(/goal/i) })
    expect(JSON.stringify(body)).not.toContain("SessionGoal.Error")
    if (item.status === 500) expect(body.ref).toMatch(/^err_[a-f0-9]{8}$/)
  }
})
