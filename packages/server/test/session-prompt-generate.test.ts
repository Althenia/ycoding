import { expect, test } from "bun:test"
import { Location } from "@ycoding-ai/core/location"
import { Project } from "@ycoding-ai/core/project"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionPromptGenerator } from "@ycoding-ai/core/session/prompt-generator"
import { Context, DateTime, Effect, Schema } from "effect"
import { sessionHttp } from "./session-http"

const sessionID = Session.ID.make("ses_prompt_http")
const missingID = Session.ID.make("ses_prompt_missing")
const info = Session.Info.make({
  id: sessionID,
  projectID: Project.ID.global,
  title: "Prompt",
  cost: Schema.decodeUnknownSync(Session.Info.fields.cost)(0),
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
})

test("unknown Session prompt generation is a typed 404", async () => {
  const seen: unknown[] = []
  await using http = sessionHttp({
    get: () => Effect.fail(new Session.NotFoundError({ sessionID: missingID })),
  }, {
    location: Context.make(SessionPromptGenerator.Service, SessionPromptGenerator.Service.of({
      request: (id, input) => Effect.sync(() => {
        seen.push({ id, input })
        return { status: "unavailable" as const }
      }),
    })),
  })
  const response = await http.json(`/api/session/${missingID}/prompt-generate`, "POST", {
    mode: "start", intent: "Open the task", memory: ["repository"],
  })

  expect(response.status).toBe(404)
  expect(await response.json()).toMatchObject({ _tag: "SessionNotFoundError", sessionID: missingID })
  expect(seen).toEqual([])
})

test("prompt generation returns the generated and unavailable shapes through the handler", async () => {
  const seen: Array<{ id: Session.ID; input: { mode: string; intent: string; memory: ReadonlyArray<"repository" | "knowledge"> } }> = []
  await using http = sessionHttp({
    get: () => Effect.succeed(info),
  }, {
    location: Context.make(SessionPromptGenerator.Service, SessionPromptGenerator.Service.of({
      request: (id, input) => Effect.sync(() => {
        seen.push({ id, input })
        if (input.mode === "goal") return { status: "unavailable" as const }
        return { status: "generated" as const, text: "Fix the build and verify it." }
      }),
    })),
  })

  const generated = await http.json(`/api/session/${sessionID}/prompt-generate`, "POST", {
    mode: "steer", intent: "Cover the regression", memory: ["knowledge"],
  })
  expect(generated.status).toBe(200)
  expect(await generated.json()).toEqual({ data: { status: "generated", text: "Fix the build and verify it." } })

  const unavailable = await http.json(`/api/session/${sessionID}/prompt-generate`, "POST", {
    mode: "goal", intent: "Ship it", memory: [],
  })
  expect(unavailable.status).toBe(200)
  expect(await unavailable.json()).toEqual({ data: { status: "unavailable" } })
  expect(seen).toEqual([
    { id: sessionID, input: { mode: "steer", intent: "Cover the regression", memory: ["knowledge"] } },
    { id: sessionID, input: { mode: "goal", intent: "Ship it", memory: [] } },
  ])
})
