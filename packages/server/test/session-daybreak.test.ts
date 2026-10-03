import { expect, test } from "bun:test"
import { SessionV2 } from "@ycoding-ai/core/session"
import { ProjectV2 } from "@ycoding-ai/core/project"
import { Location } from "@ycoding-ai/core/location"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { DateTime, Effect, Schema } from "effect"
import { sessionHttp } from "./session-http"

const sessionID = SessionV2.ID.make("ses_daybreak_http")

function info(daybreak: SessionV2.Info["daybreak"]) {
  return SessionV2.Info.make({
    id: sessionID,
    projectID: ProjectV2.ID.global,
    title: "test",
    daybreak,
    cost: Schema.decodeUnknownSync(SessionV2.Info.fields.cost)(0),
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
  })
}

function fixture(set: SessionV2.Interface["daybreak"]["set"]) {
  const http = sessionHttp({ daybreak: { set } })
  return {
    request: (payload: Record<string, unknown>) => http.json(`/api/session/${sessionID}/daybreak`, "POST", payload),
    [Symbol.asyncDispose]: http[Symbol.asyncDispose],
  }
}

test("session.daybreak.set forwards set and clear payloads with the updated Session info", async () => {
  const received: unknown[] = []
  await using f = fixture(input => Effect.sync(() => {
    received.push(input)
    return info(input.daybreak ?? undefined)
  }))
  for (const daybreak of ["daybreak_blue", "daybreak_red", null] as const) {
    const response = await f.request({ daybreak })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.data).toMatchObject({ id: sessionID, title: "test" })
    expect(body.data.daybreak).toBe(daybreak ?? undefined)
    expect(received.at(-1)).toEqual({ sessionID, daybreak })
  }
})

test("session.daybreak.set maps the missing-Session failure", async () => {
  await using f = fixture(() => Effect.fail(new SessionV2.NotFoundError({ sessionID })))
  const response = await f.request({ daybreak: "daybreak_blue" })
  expect(response.status).toBe(404)
  expect(await response.json()).toMatchObject({ _tag: "SessionNotFoundError", sessionID })
})
