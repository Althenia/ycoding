import { expect, test } from "bun:test"
import { AgentV2 } from "@ycoding-ai/core/agent"
import { ModelV2 } from "@ycoding-ai/core/model"
import { ProviderV2 } from "@ycoding-ai/core/provider"
import { renderTeamObservation, renderTeamView } from "@ycoding-ai/core/session/orchestration-view"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { QuestionID, Task } from "@ycoding-ai/schema/session-orchestration"

const task = Task.make({
  sessionID: SessionSchema.ID.make("ses_review"),
  parentID: SessionSchema.ID.make("ses_parent"),
  description: "Review changes",
  agent: AgentV2.ID.make("build"),
  model: ModelV2.Ref.make({ providerID: ProviderV2.ID.make("fake"), id: ModelV2.ID.make("fake-model") }),
  background: true,
  state: "running",
  progress: { text: "Checking tests", time: 1 },
  revision: 1,
  time: { created: 1, updated: 2 },
})

test("automatic observations omit operational metadata without changing explicit inspection", () => {
  const original = renderTeamView([task])
  const observation = renderTeamObservation([task])
  expect(observation.view.children).toEqual([{
    sessionID: task.sessionID,
    parentID: task.parentID,
    description: "Review changes",
    agent: task.agent,
    model: task.model,
    background: true,
    state: "running",
    progress: { text: "Checking tests" },
    question: undefined,
  }])
  expect(observation.text).not.toContain('"revision"')
  expect(observation.text).not.toContain('"time"')
  expect(Buffer.byteLength(observation.text)).toBeLessThan(Buffer.byteLength(original.text))
  expect(renderTeamView([task])).toEqual(original)
  expect(original.view.children[0]).toEqual(task)
})

test("observation ordering and serialization ignore clocks, revisions, input order, and JSON key order", () => {
  const waiting = Task.make({
    ...task,
    sessionID: SessionSchema.ID.make("ses_waiting"),
    state: "waiting",
    question: { id: QuestionID.make("qst_review"), text: "Choose scope", data: { first: 1, second: 2 }, time: 1 },
  })
  const tasks = [task, waiting, { ...task, sessionID: SessionSchema.ID.make("ses_another") }]
  const before = renderTeamObservation(tasks)
  const after = renderTeamObservation(tasks.toReversed().map((item, index) => ({
    ...item,
    revision: 20 + index,
    time: { created: 100, updated: 200 + index },
    progress: item.progress ? { ...item.progress, time: 300 } : undefined,
    question: item.question ? { ...item.question, time: 400, data: { second: 2, first: 1 } } : undefined,
  })))
  expect(after.text).toBe(before.text)
  expect(after.view.children.map((child) => child.sessionID)).toEqual([
    waiting.sessionID, SessionSchema.ID.make("ses_another"), task.sessionID,
  ])
  expect(after.view.children[0]!.question).toEqual({
    id: QuestionID.make("qst_review"), text: "Choose scope", data: { first: 1, second: 2 },
  })
})

test("bounded observations retain questions and active children before terminal children", () => {
  const tasks = Array.from({ length: 40 }, (_, index) => Task.make({
    ...task,
    sessionID: SessionSchema.ID.make(`ses_${String(index).padStart(2, "0")}`),
    state: index === 38 ? "running" : index === 39 ? "waiting" : "completed",
    description: "€".repeat(1365),
    progress: { text: "€".repeat(1365), time: index },
    question: index === 39 ? { id: QuestionID.make("qst_scope"), text: "Choose scope", time: index } : undefined,
  }))
  const observation = renderTeamObservation(tasks)
  expect(Buffer.byteLength(observation.text)).toBeLessThanOrEqual(32 * 1024)
  expect(observation.view.children.slice(0, 2).map((child) => child.state)).toEqual(["waiting", "running"])
  expect(observation.view.omitted).toBe(tasks.length - observation.view.children.length)
  expect(observation.view.omitted).toBeGreaterThan(0)
  expect(observation.text).not.toContain("�")
  expect(renderTeamObservation(tasks.map((item) => ({ ...item, time: { created: 999, updated: 999 } }))).text)
    .toBe(observation.text)
})

test("empty observations explicitly clear a previous team", () => {
  expect(renderTeamObservation([]).view).toEqual({ children: [], omitted: 0 })
  expect(renderTeamObservation([]).text).toBe(renderTeamView([]).text)
})
