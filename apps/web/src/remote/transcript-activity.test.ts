import { describe, expect, test } from "bun:test"
import type { AssistantPart, RemoteMessageView } from "./projection"
import { reasoningSummary, transcriptActivity, userMessageDisplay } from "./view-model"

const prompt = (state: "pending" | "promoted" | "consumed", delivery?: "steer" | "queue"): RemoteMessageView => ({ kind: "user", id: `msg_${state}_${delivery ?? "none"}`, text: "Check the light theme", state, created: 1, ...(delivery ? { delivery } : {}) })
const reply = (parts: readonly AssistantPart[], extra: { readonly completed?: number; readonly error?: string } = {}): RemoteMessageView => ({ kind: "assistant", id: "msg_reply", parts, created: 2, ...extra })
const text = (value: string): AssistantPart => ({ kind: "text", ordinal: 0, text: value })
const base = { status: "running" as const, connection: "connected" as const, transport: "open" as const, requests: 0, sending: false }

describe("transcript activity", () => {
  test("a turn that started shows the typing indicator until output appears", () => {
    expect(transcriptActivity({ ...base, messages: [prompt("consumed")] })).toEqual({ kind: "typing" })
  })
  test("an accepted message shows typing before the Session reports running", () => {
    expect(transcriptActivity({ ...base, status: "idle", messages: [reply([text("Done")], { completed: 3 }), prompt("pending", "steer")] })).toEqual({ kind: "typing" })
    expect(transcriptActivity({ ...base, status: "idle", sending: true, messages: [reply([text("Done")], { completed: 3 })] })).toEqual({ kind: "typing" })
  })
  test("a message queued behind a running turn shows typing below it", () => {
    expect(transcriptActivity({ ...base, messages: [prompt("consumed"), reply([text("Streaming answer")]), prompt("pending", "queue")] })).toEqual({ kind: "typing" })
  })
  test("the first visible streamed text removes the indicator", () => {
    expect(transcriptActivity({ ...base, messages: [prompt("consumed"), reply([text("")])] })).toEqual({ kind: "typing" })
    expect(transcriptActivity({ ...base, messages: [prompt("consumed"), reply([text("First words")])] })).toBeUndefined()
  })
  test("a live reasoning or tool row is never duplicated by the indicator", () => {
    expect(transcriptActivity({ ...base, messages: [prompt("consumed"), reply([{ kind: "reasoning", ordinal: 0, text: "Planning", started: 1 }])] })).toBeUndefined()
    for (const status of ["running", "streaming"] as const)
      expect(transcriptActivity({ ...base, messages: [prompt("consumed"), reply([{ kind: "tool", callID: "call_1", name: "shell", status, content: [] }])] })).toBeUndefined()
  })
  test("between steps of a running turn the indicator returns", () => {
    expect(transcriptActivity({ ...base, messages: [prompt("consumed"), reply([text("Reading"), { kind: "tool", callID: "call_1", name: "read", status: "completed", content: [] }])] })).toEqual({ kind: "typing" })
  })
  test("a finished turn and an idle Session show nothing", () => {
    expect(transcriptActivity({ ...base, status: "idle", messages: [prompt("consumed"), reply([text("Done")], { completed: 3 })] })).toBeUndefined()
    expect(transcriptActivity({ ...base, status: "interrupted", messages: [prompt("consumed")] })).toBeUndefined()
    expect(transcriptActivity({ ...base, status: "idle", messages: [] })).toBeUndefined()
  })
  test("a disconnected or reconnecting busy Session shows a status row instead of typing", () => {
    expect(transcriptActivity({ ...base, connection: "offline", messages: [prompt("consumed")] })).toEqual({ kind: "status", tone: "attention", label: "Disconnected · Sending resumes when the machine is connected." })
    expect(transcriptActivity({ ...base, transport: "reconnecting", messages: [prompt("consumed")] })).toEqual({ kind: "status", tone: "attention", label: "Reconnecting · Sending resumes when the machine is connected." })
    expect(transcriptActivity({ ...base, status: "idle", connection: "offline", messages: [prompt("consumed"), reply([text("Done")], { completed: 3 })] })).toBeUndefined()
  })
  test("a provider error shows a danger row unless the reply already shows it", () => {
    expect(transcriptActivity({ ...base, status: "failed", lastError: "Rate limit reached", messages: [prompt("consumed")] })).toEqual({ kind: "status", tone: "danger", label: "Provider error · Rate limit reached" })
    expect(transcriptActivity({ ...base, status: "failed", messages: [prompt("consumed")] })).toEqual({ kind: "status", tone: "danger", label: "Provider error" })
    expect(transcriptActivity({ ...base, status: "failed", lastError: "Rate limit reached", messages: [prompt("consumed"), reply([], { error: "Rate limit reached", completed: 3 })] })).toBeUndefined()
  })
  test("a pending decision shows an attention row", () => {
    expect(transcriptActivity({ ...base, requests: 1, messages: [prompt("consumed")] })).toEqual({ kind: "status", tone: "attention", label: "Waiting for your decision" })
  })
})

describe("user message display", () => {
  const png = (name: string, digest: string) => ({ name, mime: "image/png", bytes: 2_048, digest })
  test("image tokens that refer to attached images are hidden from the shown text", () => {
    const attachments = [png("layout-1.png", "a"), png("layout-2.png", "b")]
    const message = { text: "Compare [Image 1] with [Image 2] and keep the spacing.", attachments }
    expect(userMessageDisplay(message)).toEqual({ text: "Compare with and keep the spacing.", images: attachments, files: [] })
    expect(message.text).toBe("Compare [Image 1] with [Image 2] and keep the spacing.")
  })
  test("an image-only message has no text and keeps non-image files as chips", () => {
    const file = { name: "notes.txt", mime: "text/plain", bytes: 512, digest: "d" }
    expect(userMessageDisplay({ text: "[Image 1]", attachments: [png("screenshot.png", "c"), file] })).toEqual({ text: "", images: [png("screenshot.png", "c")], files: [file] })
  })
  test("tokens without a matching image and messages without images stay as written", () => {
    expect(userMessageDisplay({ text: "See [Image 3]", attachments: [png("one.png", "a")] }).text).toBe("See [Image 3]")
    expect(userMessageDisplay({ text: "Line one\n\n[Image 1] stays", attachments: [] })).toEqual({ text: "Line one\n\n[Image 1] stays", images: [], files: [] })
  })
  test("removing a token keeps line breaks", () => {
    expect(userMessageDisplay({ text: "First line [Image 1]\nSecond line", attachments: [png("one.png", "a")] }).text).toBe("First line\nSecond line")
  })
})

describe("reasoning summary", () => {
  test("a finished thought names its duration and the details hint follows the open state", () => {
    expect(reasoningSummary({ started: 1_000, completed: 5_000, open: false })).toEqual({ label: "Thought · 4s", hint: "Show details", done: true })
    expect(reasoningSummary({ started: 1_000, completed: 5_000, open: true })).toEqual({ label: "Thought · 4s", hint: "Hide details", done: true })
  })
  test("a live thought reads Thinking", () => {
    expect(reasoningSummary({ started: 1_000, open: false })).toEqual({ label: "Thinking", hint: "Show details", done: false })
  })
})
