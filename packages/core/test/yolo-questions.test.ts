import { expect } from "bun:test"
import { LLMClient, LLMEvent, Model, type LLMRequest } from "@ycoding-ai/ai"
import { OpenAIChat } from "@ycoding-ai/ai/protocols/openai-chat"
import { Effect, Layer, Stream } from "effect"
import { Agent } from "@ycoding-ai/core/agent"
import { Config } from "@ycoding-ai/core/config"
import { Database } from "@ycoding-ai/core/database/database"
import { Decision } from "@ycoding-ai/core/decision"
import { DecisionAgent } from "@ycoding-ai/core/decision-agent"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { llmClient } from "@ycoding-ai/core/effect/app-node-platform"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Form } from "@ycoding-ai/core/form"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { Question } from "@ycoding-ai/core/question"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SessionHelperPolicy } from "@ycoding-ai/core/session/helper-policy"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const model = Model.make({ id: "question-fixture", provider: "test", route: OpenAIChat.route })
const requests: LLMRequest[] = []
let outputs: string[] = []
const client = Layer.mock(LLMClient.Service, {
  stream: (request) => {
    requests.push(request)
    return Stream.make(
      LLMEvent.textDelta({ id: "answer", text: outputs.shift() ?? "" }),
      LLMEvent.stepFinish({ index: 0, reason: "stop" }),
      LLMEvent.finish({ reason: "stop" }),
    )
  },
})
const helpers = Layer.mock(SessionHelperPolicy.Service, {
  settings: { titleMode: "local", models: {} },
  localTitle: (input) => input,
  resolveRef: () => Effect.succeed(SessionRunnerModel.resolved(model)),
  resolveModel: () => Effect.succeed(SessionRunnerModel.resolved(model)),
})
const it = testEffect(AppNodeBuilder.build(LayerNode.group([
  Agent.node, Database.node, Decision.node, DecisionAgent.node, EventRuntime.node, SessionAutonomy.node, Form.node, Question.node,
]), [
  [llmClient, client],
  [SessionHelperPolicy.node, helpers],
  [Config.node, Layer.mock(Config.Service, { entries: () => Effect.succeed([]) })],
]))

const seed = Effect.fnUntraced(function* (name: string, goal: string, reply: ReadonlyArray<string>) {
  outputs = [...reply]
  requests.length = 0
  const database = yield* Database.Service
  yield* database.db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).onConflictDoNothing().run().pipe(Effect.orDie)
  const sessionID = SessionSchema.ID.make(`ses_questions_${name}`)
  yield* database.db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global, directory: "/project", title: name }).run().pipe(Effect.orDie)
  const autonomy = yield* SessionAutonomy.Service
  yield* autonomy.setYolo({ sessionID, yolo: true })
  yield* autonomy.set({ sessionID, sleep: true })
  yield* autonomy.setGoal({ sessionID, text: goal })
  const agents = yield* Agent.Service
  yield* agents.transform((draft) => {
    for (const id of ["decision", "yolo-answer"])
      draft.update(Agent.ID.make(id), (agent) => {
        agent.mode = "primary"
        agent.hidden = true
        agent.permissions.push({ action: "*", resource: "*", effect: "deny" })
      })
  })
  return sessionID
})

function answer(name: string, text?: string) {
  return JSON.stringify({ decisions: { version: 1, answers: [{
    name, type: text === undefined ? "refusal" : "text", text: text ?? null,
    answer: null, choice: null, score: null, confidence: text === undefined ? 0 : 0.9,
  }] } })
}

it.effect("YOLO resolves a free-text question without recommendations using the active goal", () => Effect.gen(function* () {
  const sessionID = yield* seed("free_text", "Prepare the offline release candidate", [answer("question_0", "Local release candidate")])
  const questions = yield* Question.Service
  expect(yield* questions.ask({ sessionID, questions: [{ header: "Title", question: "What title fits the deliverable?", options: [] }] })).toEqual({
    status: "answered", answers: [["Local release candidate"]], automatic: true, via: "yolo", confidence: 0.9,
  })
  expect(JSON.stringify(requests[0]?.messages)).toContain("Prepare the offline release candidate")
  expect(yield* questions.list()).toEqual([])
}))

it.effect("YOLO repairs a malformed reply before resolving a required free-text form", () => Effect.gen(function* () {
  const sessionID = yield* seed("repair", "Create a local summary named review", ["malformed", answer("title", "review")])
  const forms = yield* Form.Service
  expect(yield* forms.ask({ sessionID, title: "Summary", fields: [{ key: "title", type: "string", required: true }] })).toMatchObject({
    status: "answered", answer: { title: "review" }, automatic: true, via: "yolo",
  })
  expect(requests).toHaveLength(2)
  expect(JSON.stringify(requests[1]?.messages)).toContain("previous response was not a valid JSON")
  expect(yield* forms.list({ sessionID })).toEqual([])
}))

it.effect("a genuinely missing factual input stays a review without fabricated data or human attribution", () => Effect.gen(function* () {
  const sessionID = yield* seed("missing", "Prepare the approved transfer when a valid reservation is supplied", [answer("reservation")])
  const forms = yield* Form.Service
  const events = yield* EventRuntime.Service
  const replied: unknown[] = []
  const unsubscribe = yield* events.listen((event) => Effect.sync(() => { if (event.type === Form.Event.Replied.type) replied.push(event.data) }))
  yield* Effect.addFinalizer(() => unsubscribe)
  const result = yield* forms.ask({ sessionID, title: "Transfer reservation", fields: [{ key: "reservation", type: "string", required: true }] })
  expect(result).toMatchObject({ status: "deferred" })
  expect(result).not.toHaveProperty("automatic")
  expect(replied).toEqual([])
  expect(requests).toHaveLength(1)
}))
