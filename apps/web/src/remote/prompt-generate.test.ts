import { expect, test } from "bun:test"
import type { RemoteWorkspaceInfo } from "@ycoding-ai/remote"
import { remoteKeys } from "./queries"
import { submission } from "./ui/composer-logic"
import { createRemoteHttp } from "./http"
import { createRemoteStore } from "./store"

const sessionID = "ses_prompt"
const workspace: RemoteWorkspaceInfo = { id: "work_one", projectID: "project_hash", directory: "/workspace/ycoding", name: "YCoding" }

test("an empty /prompt intent is a notice and sends nothing", async () => {
  const requests: { operation: string }[] = []
  const store = promptStore(requests, async () => ({ status: "ok", value: { status: "generated", text: "Do not send" } }))
  try {
    expect(await store.requestPromptGenerate({ mode: "start", intent: "   ", memory: ["repository"] })).toBe(false)
    store.connect("dev_1")
    await store.selectSession(sessionID)
    expect(await store.requestPromptGenerate({ mode: "goal", intent: "", memory: [] })).toBe(false)
    expect(requests.some((request) => request.operation === "session.promptGenerate" || request.operation === "session.create" || request.operation === "session.prompt")).toBe(false)
    expect(store.state().notice).toBe("Add what you want after /prompt")
  } finally { store.dispose() }
})

test("session.promptGenerate sends mode, trimmed intent, and memory without admitting a prompt", async () => {
  const requests: { operation: string; sessionID?: string; input?: Readonly<Record<string, unknown>> }[] = []
  const store = promptStore(requests, async () => ({ status: "ok", value: { status: "generated", text: "Write the focused tests" } }))
  try {
    store.connect("dev_1")
    await store.selectSession(sessionID)
    const messages = store.state().view?.messages
    expect(await store.requestPromptGenerate({ mode: "steer", intent: "  focus the tests  ", memory: ["repository", "knowledge"] })).toBe(true)
    expect(requests.filter((request) => request.operation === "session.promptGenerate")).toEqual([{
      operation: "session.promptGenerate",
      sessionID,
      input: { mode: "steer", intent: "focus the tests", memory: ["repository", "knowledge"] },
    }])
    expect(requests.some((request) => request.operation === "session.prompt")).toBe(false)
    expect(store.state().view?.messages).toEqual(messages)
    expect(store.state().drafts[sessionID]).toBe("Write the focused tests")
    expect(store.state().promptDraftFocus).toMatchObject({ sessionID })
    store.setDraft(sessionID, "")
    await store.requestPromptGenerate({ mode: "start", intent: "h".repeat(4001), memory: [] })
    const sent = requests.filter((request) => request.operation === "session.promptGenerate")
    expect(sent[1]?.input).toEqual({ mode: "start", intent: "h".repeat(4000), memory: [] })
  } finally { store.dispose() }
})

test("a generated prompt fills only an empty draft", async () => {
  const store = promptStore([], async () => ({ status: "ok", value: { status: "generated", text: "Replace nothing" } }))
  try {
    store.connect("dev_1")
    await store.selectSession(sessionID)
    store.setDraft(sessionID, "Keep this draft")
    expect(await store.requestPromptGenerate({ mode: "start", intent: "rewrite", memory: [] })).toBe(false)
    expect(store.state().drafts[sessionID]).toBe("Keep this draft")
    expect(store.state().notice).toBe("Draft not empty; generated prompt discarded")
    expect(store.state().promptDraftFocus).toBeUndefined()
  } finally { store.dispose() }
})

test("goal mode fills a /goal draft and queue mode sends delivery queue until the draft changes", async () => {
  const requests: { operation: string; input?: Readonly<Record<string, unknown>> }[] = []
  const store = promptStore(requests, async (operation) => operation === "session.promptGenerate"
    ? { status: "ok", value: { status: "generated", text: "Finish the migration" } }
    : undefined)
  try {
    store.connect("dev_1")
    await store.selectSession(sessionID)
    expect(await store.requestPromptGenerate({ mode: "goal", intent: "ship it", memory: ["knowledge"] })).toBe(true)
    expect(store.state().drafts[sessionID]).toBe("/goal Finish the migration")
    expect(store.state().queuedPromptDrafts?.[sessionID]).toBeUndefined()
    expect(submission(store.state().drafts[sessionID] ?? "", [], undefined, "steer")).toEqual({ kind: "goal", input: { goal: "Finish the migration" } })
    store.setDraft(sessionID, "")
    expect(await store.requestPromptGenerate({ mode: "queue", intent: "follow up", memory: [] })).toBe(true)
    expect(store.state().drafts[sessionID]).toBe("Finish the migration")
    expect(store.state().queuedPromptDrafts?.[sessionID]).toBe("Finish the migration")
    const { queuedDraftDelivery, queuedPromptIndicator } = await import("./ui/composer-logic")
    expect(queuedPromptIndicator("Finish the migration", "Finish the migration")).toBe("This message will be queued")
    expect(queuedDraftDelivery("Finish the migration", "Finish the migration", "steer")).toBe("queue")
    expect(await store.sendPrompt({ text: "Finish the migration", delivery: "steer" })).toBe(true)
    await Promise.resolve()
    expect(requests.find((request) => request.operation === "session.prompt")?.input).toMatchObject({ text: "Finish the migration", delivery: "queue" })
    expect(store.state().queuedPromptDrafts?.[sessionID]).toBeUndefined()
    store.setDraft(sessionID, "Finish the migration")
    await store.requestPromptGenerate({ mode: "queue", intent: "again", memory: [] })
    expect(store.state().notice).toBe("Draft not empty; generated prompt discarded")
    store.setDraft(sessionID, "")
    await store.requestPromptGenerate({ mode: "queue", intent: "again", memory: [] })
    store.setDraft(sessionID, "Edited")
    expect(store.state().queuedPromptDrafts?.[sessionID]).toBeUndefined()
    requests.length = 0
    expect(await store.sendPrompt({ text: "Edited", delivery: "steer" })).toBe(true)
    await Promise.resolve()
    expect(requests.find((request) => request.operation === "session.prompt")?.input).toMatchObject({ delivery: "steer" })
  } finally { store.dispose() }
})

test("an unavailable prompt is a notice, and failed or unknown outcomes stay mutation toasts", async () => {
  const answers: ({ status: "ok"; value: { status: "unavailable" } } | { status: "failed" | "unknown"; error: { code: "internal_error" | "outcome_unknown"; message: string } })[] = []
  const store = promptStore([], async (operation) => {
    if (operation !== "session.promptGenerate") return undefined
    const answer = answers.shift()
    if (!answer) throw new Error("missing prompt answer")
    return answer
  })
  try {
    store.connect("dev_1")
    await store.selectSession(sessionID)
    answers.push({ status: "ok", value: { status: "unavailable" } })
    expect(await store.requestPromptGenerate({ mode: "start", intent: "anything", memory: ["knowledge"] })).toBe(false)
    expect(store.state().notice).toBe("No prompt could be generated")
    expect(store.state().drafts[sessionID] ?? "").toBe("")
    expect(store.state().mutationToasts ?? []).toEqual([])
    answers.push({ status: "failed", error: { code: "internal_error", message: "prompt failed" } })
    expect(await store.requestPromptGenerate({ mode: "start", intent: "anything", memory: [] })).toBe(false)
    expect(store.state().mutationToasts).toMatchObject([{ label: "Generate prompt", state: "failed", detail: "prompt failed", sessionID }])
    answers.push({ status: "unknown", error: { code: "outcome_unknown", message: "prompt unsettled" } })
    expect(await store.requestPromptGenerate({ mode: "start", intent: "anything", memory: [] })).toBe(false)
    expect(store.state().mutationToasts?.some((toast) => toast.state === "unknown" && toast.detail === "Outcome unknown: prompt unsettled. Retry only if you want to send it again.")).toBe(true)
  } finally { store.dispose() }
})

test("a prompt settled after the Session changes does not publish that outcome", async () => {
  let release: (outcome: { status: "ok"; value: { status: "generated"; text: string } }) => void = () => {}
  const store = promptStore([], (operation) => operation === "session.promptGenerate"
    ? new Promise((resolve) => { release = resolve })
    : undefined)
  try {
    store.connect("dev_1")
    await store.selectSession(sessionID)
    const pending = store.requestPromptGenerate({ mode: "start", intent: "late", memory: [] })
    await store.selectSession("ses_other")
    release({ status: "ok", value: { status: "generated", text: "Too late" } })
    await pending
    expect(store.state().activeSessionID).toBe("ses_other")
    expect(store.state().drafts[sessionID] ?? "").toBe("")
    expect(store.state().notice).not.toBe("No prompt could be generated")
  } finally { store.dispose() }
})

test("a new Session is created from the backend workspace, selected, then generated", async () => {
  const requests: { operation: string; sessionID?: string; input?: Readonly<Record<string, unknown>> }[] = []
  const store = promptStore(requests, async (operation) => operation === "session.promptGenerate"
    ? { status: "ok", value: { status: "generated", text: "Start here" } }
    : undefined)
  try {
    store.connect("dev_1")
    store.queryClient.setQueryData(remoteKeys.workspaces({ deviceID: "dev_1", generation: store.state().generation }), [workspace])
    expect(await store.requestPromptGenerate({ mode: "steer", intent: "steer first", memory: [], workspaceID: workspace.id })).toBe(false)
    expect(requests.some((request) => request.operation === "session.create" || request.operation === "session.promptGenerate")).toBe(false)
    expect(await store.requestPromptGenerate({ mode: "start", intent: "open the task", memory: ["repository"], workspaceID: workspace.id })).toBe(true)
    expect(requests.find((request) => request.operation === "session.create")?.input).toEqual({ id: "ses_created", workspace: "work_one" })
    expect(JSON.stringify(requests.find((request) => request.operation === "session.create")?.input)).not.toContain(workspace.directory)
    expect(requests.find((request) => request.operation === "session.promptGenerate")).toMatchObject({
      sessionID: "ses_created",
      input: { mode: "start", intent: "open the task", memory: ["repository"] },
    })
    expect(store.state().activeSessionID).toBe("ses_created")
    expect(store.state().drafts.ses_created).toBe("Start here")
    expect(requests.some((request) => request.operation === "session.prompt")).toBe(false)
  } finally { store.dispose() }
})

test("Steer and Queue are hidden without a Session, and a queue draft shows its indicator", async () => {
  const { promptGenerateModes, queuedPromptIndicator } = await import("./ui/composer-logic")
  expect(promptGenerateModes(true).map((mode) => mode.label)).toEqual(["Start a task", "Steer", "Queue follow-up", "Goal objective"])
  expect(promptGenerateModes(false).map((mode) => mode.id)).toEqual(["start", "goal"])
  expect(queuedPromptIndicator("Queued work", undefined)).toBeUndefined()
  expect(queuedPromptIndicator("Queued work", "Queued work")).toBe("This message will be queued")
})

function promptStore(
  requests: { operation: string; sessionID?: string; input?: Readonly<Record<string, unknown>> }[],
  prompt: (operation: string) => Promise<{ status: "ok"; value: unknown } | { status: "failed" | "unknown"; error: { code: "internal_error" | "outcome_unknown"; message: string } } | undefined> | { status: "ok"; value: unknown } | { status: "failed" | "unknown"; error: { code: "internal_error" | "outcome_unknown"; message: string } } | undefined,
) {
  return createRemoteStore({
    http: createRemoteHttp(),
    batchMs: 0,
    createSessionID: () => "ses_created",
    createTransport: (_deviceID, callbacks) => ({
      connect: () => callbacks.onStatus?.({ kind: "open" }),
      close: () => {},
      setPriority: () => {},
      status: () => ({ kind: "open" as const }),
      request: async (operation, request) => {
        requests.push({ operation, sessionID: request?.sessionID, input: request?.input })
        const answered = await prompt(operation)
        if (answered) return answered
        if (operation === "session.create") {
          const id = typeof request?.input?.id === "string" ? request.input.id : "ses_created"
          return { status: "ok" as const, value: { data: { id, title: "Prompt", projectID: workspace.projectID, location: { directory: workspace.directory }, time: { created: 1, updated: 1 } } } }
        }
        if (operation === "session.snapshot") return { status: "ok" as const, value: { sourceEpoch: "epoch_prompt", session: { id: request?.sessionID, title: "Prompt", time: { created: 1, updated: 1 } }, messages: [], watermark: { type: "log.synced", aggregateID: request?.sessionID ?? sessionID, seq: 0 } } }
        if (operation === "session.autonomy.get") return { status: "ok" as const, value: { data: { mode: "normal", permissions: "manual", guardrails: "manual", answers: "manual", effective: { permissions: "manual", guardrails: "manual", answers: "manual", inherited: {}, asleep: false, guardrailsEnabled: true } } } }
        return { status: "ok" as const, value: { data: [] } }
      },
    }),
  })
}
