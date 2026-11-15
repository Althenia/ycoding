import { expect, test } from "bun:test"
import { syntheticDesktop } from "./synthetic-desktop"

const question = {
  id: "que_synthetic",
  sessionID: "ses_synthetic",
  questions: [
    { header: "Route", question: "Which route?", options: [{ label: "Keep", description: "Keep the route" }, { label: "Change", description: "Change the route" }], custom: false },
    { header: "Details", question: "Which details?", options: [{ label: "Tests", description: "Include tests" }], multiple: true },
  ],
}

async function refused(operation: Promise<unknown>) {
  const result = await operation.then(() => false, (cause: unknown) => { expect(cause).toBeInstanceOf(Error); return true })
  expect(result).toBe(true)
}

test("active questions are read from their Session alongside pending requests", async () => {
  const app = await syntheticDesktop((call) => {
    if (call.route === "/api/session/ses_synthetic/question") return { data: [question] }
    if (call.route.endsWith("/permission") || call.route.endsWith("/form")) return { data: [] }
    return undefined
  })
  try {
    expect(await app.controller.requests("ses_synthetic")).toMatchObject({ sessionID: "ses_synthetic", permissions: [], forms: [], questions: [question] })
    expect(app.calls.filter((call) => call.route.includes("/question"))).toHaveLength(1)
  } finally { await app.close() }
})

test("active question replies preserve each selected label and custom answer in question order", async () => {
  const app = await syntheticDesktop((call) => call.route === "/api/session/ses_synthetic/question" ? { data: [question] } : undefined)
  try {
    const answers = [["Keep"], ["Tests", "Retain Unicode: 日本語"]]
    await app.controller.reply({ kind: "question", sessionID: question.sessionID, requestID: question.id, revision: app.revision, answers })
    expect(app.calls.filter((call) => call.method === "POST")).toEqual([expect.objectContaining({ route: "/api/session/ses_synthetic/question/que_synthetic/reply", body: { answers } })])
  } finally { await app.close() }
})

test("active question rejection is scoped to the still-pending request", async () => {
  const app = await syntheticDesktop((call) => call.route === "/api/session/ses_synthetic/question" ? { data: [question] } : undefined)
  try {
    await app.controller.reply({ kind: "question-reject", sessionID: question.sessionID, requestID: question.id, revision: app.revision })
    expect(app.calls.filter((call) => call.method === "POST")).toEqual([expect.objectContaining({ route: "/api/session/ses_synthetic/question/que_synthetic/reject" })])
  } finally { await app.close() }
})

test("active question replies refuse malformed selections, another Session, missing requests and stale connections without writes", async () => {
  const app = await syntheticDesktop((call) => call.route === "/api/session/ses_synthetic/question" ? { data: [question] } : { data: [] })
  const reply = { kind: "question", sessionID: question.sessionID, requestID: question.id, revision: app.revision, answers: [["Keep"], ["Tests"]] }
  try {
    for (const answers of [[], [["Keep"]], [["Missing"], ["Tests"]], [["Keep", "Change"], ["Tests"]], [["Keep"], ["Tests", "Tests"]], [["Keep"], [""]]]) {
      await refused(app.controller.reply({ ...reply, answers }))
    }
    await refused(app.controller.reply({ ...reply, sessionID: "ses_other" }))
    await refused(app.controller.reply({ ...reply, requestID: "que_missing" }))
    await app.controller.disconnect()
    await refused(app.controller.reply(reply))
    expect(app.calls.filter((call) => call.method === "POST")).toEqual([])
  } finally { await app.close() }
})
