import { expect, test } from "bun:test"
import { Location } from "@ycoding-ai/core/location"
import { Project } from "@ycoding-ai/core/project"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionPrediction } from "@ycoding-ai/core/session/prediction"
import { Context, DateTime, Effect, Schema } from "effect"
import { sessionHttp } from "./session-http"

const sessionID = Session.ID.make("ses_prediction_http")
const missingID = Session.ID.make("ses_prediction_missing")
const info = Session.Info.make({
  id: sessionID,
  projectID: Project.ID.global,
  title: "Prediction",
  cost: Schema.decodeUnknownSync(Session.Info.fields.cost)(0),
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
})

test("unknown Session prediction is a typed 404", async () => {
  const seen: unknown[] = []
  await using http = sessionHttp({
    get: () => Effect.fail(new Session.NotFoundError({ sessionID: missingID })),
  }, {
    location: Context.make(SessionPrediction.Service, SessionPrediction.Service.of({
      request: (id, input) => Effect.sync(() => {
        seen.push({ id, input })
        return { status: "unavailable" as const }
      }),
    })),
  })
  const response = await http.json(`/api/session/${missingID}/prediction`, "POST", { memory: ["repository"], hint: "tests" })

  expect(response.status).toBe(404)
  expect(await response.json()).toMatchObject({ _tag: "SessionNotFoundError", sessionID: missingID })
  expect(seen).toEqual([])
})

test("prediction returns the suggested and unavailable shapes through the handler", async () => {
  const seen: Array<{ id: Session.ID; input: { memory: ReadonlyArray<"repository" | "knowledge">; hint?: string } }> = []
  await using http = sessionHttp({
    get: () => Effect.succeed(info),
  }, {
    location: Context.make(SessionPrediction.Service, SessionPrediction.Service.of({
      request: (id, input) => Effect.sync(() => {
        seen.push({ id, input })
        if (input.hint === undefined) return { status: "unavailable" as const }
        return { status: "suggested" as const, text: "Run the focused tests" }
      }),
    })),
  })

  const suggested = await http.json(`/api/session/${sessionID}/prediction`, "POST", { memory: ["knowledge"], hint: "tests" })
  expect(suggested.status).toBe(200)
  expect(await suggested.json()).toEqual({ data: { status: "suggested", text: "Run the focused tests" } })

  const unavailable = await http.json(`/api/session/${sessionID}/prediction`, "POST", { memory: [] })
  expect(unavailable.status).toBe(200)
  expect(await unavailable.json()).toEqual({ data: { status: "unavailable" } })
  expect(seen).toEqual([
    { id: sessionID, input: { memory: ["knowledge"], hint: "tests" } },
    { id: sessionID, input: { memory: [] } },
  ])
})
