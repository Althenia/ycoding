import { expect, test } from "bun:test"
import { parentAnswer, questionAnswerState, questionHistory } from "./question-history"
import type { AssistantPart, RemoteMessageView } from "./projection"

const part: Extract<AssistantPart, { kind: "tool" }> = { kind: "tool", callID: "call_question", name: "question", status: "completed", content: [], input: { questions: [{ header: "Scope", question: "Which tests?", options: [] }, { header: "Notes", question: "What must stay?", options: [] }] }, structured: { answers: [["Focused tests", "Adjacent tests"], []] } }

test("reads ordered human questions and typed recorded answers from the actual tool shapes", () => {
  expect(questionHistory(part)).toEqual([{ title: "Scope", text: "Which tests?", answer: "Focused tests, Adjacent tests" }, { title: "Notes", text: "What must stay?", answer: "Unanswered" }])
  expect(questionHistory({ ...part, name: "subagent_report", input: { action: "question", text: "Which scope?" } })).toEqual([{ title: "Question for parent", text: "Which scope?", answer: undefined }])
  expect(questionHistory({ ...part, name: "shell" })).toEqual([])
  expect(questionHistory({ ...part, input: { questions: [null, { question: 1 }] } })).toEqual([])
})

test("missing or malformed answers never become a recorded answer and failure stays truthful", () => {
  expect(questionHistory({ ...part, structured: { answers: [[2], null] } }).map((row) => row.answer)).toEqual([undefined, undefined])
  expect(questionAnswerState(part)).toBe("Answer not reported")
  expect(questionAnswerState({ ...part, status: "running" })).toBe("Awaiting answer")
  expect(questionAnswerState({ ...part, status: "failed", error: "The user dismissed this question" })).toBe("Question cancelled")
  expect(questionAnswerState({ ...part, status: "failed", error: "Permission denied: question" })).toBe("Question failed")
})

test("reads a durable parent answer only with its producer metadata and matching question identity", () => {
  const message: RemoteMessageView = { kind: "synthetic", id: "msg_answer", created: 1, description: "Parent subagent answer", metadata: { source: "subagent_parent", kind: "answer", questionID: "qst_1" }, text: 'Parent answer:\n{"questionID":"qst_1","text":"Keep the scope narrow"}' }
  expect(parentAnswer(message)).toBe("Keep the scope narrow")
  expect(parentAnswer({ ...message, text: 'Parent answer:\n{"questionID":"qst_other","text":"Wrong identity"}' })).toBeUndefined()
  expect(parentAnswer({ ...message, text: "Parent answer:\ninvalid" })).toBeUndefined()
  expect(parentAnswer({ ...message, metadata: {} })).toBeUndefined()
  expect(parentAnswer({ ...message, text: 'Parent answer:\n{"questionID":"qst_1","data":{"approved":true}}' })).toBe('```json\n{\n  "approved": true\n}\n```')
  expect(parentAnswer({ ...message, text: 'Parent answer:\n{"questionID":"qst_1","text":"Keep the scope narrow","data":{"approved":true}}' })).toBe('Keep the scope narrow\n\n```json\n{\n  "approved": true\n}\n```')
})
