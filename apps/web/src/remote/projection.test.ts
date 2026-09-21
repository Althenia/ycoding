import { describe, expect, test } from "bun:test"
import {
  appendShellOutputPage,
  applySessionEvent,
  boundedText,
  createSessionView,
  mergeFileChanges,
  mergeShellOutputSnapshot,
  previewText,
  readAutonomy,
  readFileChangeEvent,
  readFileChangeList,
  readMessageList,
  readForms,
  readShellOutputPage,
  readSnapshotParts,
  shellOutputFetchFor,
  shellOutputFor,
  shellOutputNotice,
  toolShellID,
  withShellOutputFetch,
  withShellOutputPage,
  type ShellOutputView,
  type SessionView,
} from "./projection"

const event = (type: string, data: Record<string, unknown>) => ({ id: `evt_${type}`, type, data })

function apply(view: SessionView, type: string, data: Record<string, unknown>, now = 1) {
  return applySessionEvent(view, event(type, data), now)
}

describe("assistant streaming", () => {
  test("accumulates text deltas and replaces them with the durable boundary", () => {
    let view = createSessionView("ses_a")
    view = apply(view, "session.step.started", { assistantMessageID: "msg_1", agent: "god", model: "openai/gpt-5" })
    view = apply(view, "session.text.started", { assistantMessageID: "msg_1", ordinal: 0 })
    view = apply(view, "session.text.delta", { assistantMessageID: "msg_1", ordinal: 0, delta: "Hel" })
    view = apply(view, "session.text.delta", { assistantMessageID: "msg_1", ordinal: 0, delta: "lo" })
    view = apply(view, "session.text.ended", { assistantMessageID: "msg_1", ordinal: 0, text: "Hello there", phase: "final_answer" })
    view = apply(view, "session.step.ended", { assistantMessageID: "msg_1", finish: "stop" }, 5)

    expect(view.messages).toHaveLength(1)
    const message = view.messages[0]
    if (message?.kind !== "assistant") throw new Error("expected an assistant message")
    expect(message.agent).toBe("god")
    expect(message.parts).toEqual([{ kind: "text", ordinal: 0, text: "Hello there", phase: "final_answer" }])
    expect(message.completed).toBe(5)
  })

  test("keeps reasoning and tool parts separate and tracks the tool lifecycle", () => {
    let view = createSessionView("ses_a")
    view = apply(view, "session.reasoning.started", { assistantMessageID: "msg_1", ordinal: 0 })
    view = apply(view, "session.reasoning.delta", { assistantMessageID: "msg_1", ordinal: 0, delta: "thinking" })
    view = apply(view, "session.tool.input.started", { assistantMessageID: "msg_1", callID: "call_1", name: "execute" })
    view = apply(view, "session.tool.input.delta", { assistantMessageID: "msg_1", callID: "call_1", delta: '{"code"' })
    view = apply(view, "session.tool.input.ended", { assistantMessageID: "msg_1", callID: "call_1", text: '{"code":"1"}' })
    view = apply(view, "session.tool.success", {
      assistantMessageID: "msg_1",
      callID: "call_1",
      content: [{ type: "text", text: "done" }],
    })

    const message = view.messages[0]
    if (message?.kind !== "assistant") throw new Error("expected an assistant message")
    expect(message.parts).toEqual([
      { kind: "reasoning", ordinal: 0, text: "thinking" },
      {
        kind: "tool",
        callID: "call_1",
        name: "execute",
        status: "completed",
        inputText: '{"code":"1"}',
        content: [{ kind: "text", text: "done" }],
      },
    ])
  })
})

describe("user input lifecycle", () => {
  test("marks admitted, promoted, and consumed states", () => {
    let view = createSessionView("ses_a")
    view = apply(view, "session.input.admitted", {
      inputID: "msg_9",
      input: { type: "user", data: { text: "Run the tests" }, delivery: "queue" },
    })
    expect(view.messages[0]).toMatchObject({ kind: "user", text: "Run the tests", delivery: "queue", state: "pending" })
    view = apply(view, "session.input.promoted", { inputID: "msg_9" })
    expect(view.messages[0]).toMatchObject({ state: "promoted" })
    view = apply(view, "session.input.consumed", { inputIDs: ["msg_9"] })
    expect(view.messages[0]).toMatchObject({ state: "consumed" })
  })
})

describe("requests", () => {
  test("reads native question-tool Form.Info fields", () => {
    expect(
      readForms([
        {
          id: "frm_question",
          sessionID: "ses_a",
          title: "Question",
          metadata: { kind: "question" },
          fields: [
            { key: "q0", type: "string", title: "Which module?", required: true, options: [{ value: "core", label: "Core" }] },
            { key: "followup", type: "boolean", title: "Continue?", when: [{ key: "q0", op: "eq", value: "core" }] },
          ],
        },
      ]),
    ).toEqual([
      {
        id: "frm_question",
        sessionID: "ses_a",
        title: "Question",
        metadata: { kind: "question" },
        fields: [
          { key: "q0", type: "string", title: "Which module?", required: true, options: [{ value: "core", label: "Core" }] },
          { key: "followup", type: "boolean", title: "Continue?", when: [{ key: "q0", op: "eq", value: "core" }] },
        ],
      },
    ])
  })

  test("tracks permission, guardrail, and native form asks and their replies", () => {
    let view = createSessionView("ses_a")
    view = apply(view, "permission.v2.asked", { id: "per_1", action: "edit", resources: ["src/**"] })
    view = apply(view, "guardrail.asked", {
      id: "grq_1",
      action: "rm -rf build",
      resources: ["build"],
      reason: "Deletion needs review",
      hardReview: true,
    })
    view = apply(view, "form.created", {
      form: {
        id: "frm_1",
        sessionID: "ses_a",
        title: "Question",
        metadata: { kind: "question" },
        fields: [{ key: "q0", type: "string", title: "Which module?", options: [{ value: "core", label: "Core" }] }],
      },
    })
    expect(view.requests.map((request) => request.kind)).toEqual(["permission", "guardrail", "form"])
    const guardrail = view.requests.find((request) => request.kind === "guardrail")
    expect(guardrail).toMatchObject({ hardReview: true, reason: "Deletion needs review" })

    view = apply(view, "permission.v2.replied", { requestID: "per_1", reply: "once" })
    view = apply(view, "guardrail.replied", { requestID: "grq_1", reply: "reject" })
    view = apply(view, "form.replied", { id: "frm_1", sessionID: "ses_a", answer: { q0: "core" } })
    expect(view.requests).toHaveLength(0)
    expect(view.activity.some((item) => item.kind === "approval")).toBe(true)
  })

  test("ignores a reply for an unknown request instead of inventing one", () => {
    const view = apply(createSessionView("ses_a"), "permission.v2.replied", { requestID: "per_missing", reply: "once" })
    expect(view.requests).toHaveLength(0)
  })
})

describe("session state", () => {
  test("tracks execution status, retries, and errors", () => {
    let view = createSessionView("ses_a")
    view = apply(view, "session.execution.started", {})
    expect(view.status).toBe("running")
    view = apply(view, "session.retry.scheduled", { assistantMessageID: "msg_1", attempt: 2, at: 10, error: { code: "rate_limited", message: "slow down" } })
    expect(view.retry).toEqual({ attempt: 2, at: 10, code: "rate_limited" })
    view = apply(view, "session.execution.failed", { error: { code: "provider_error", message: "boom" } })
    expect(view.status).toBe("failed")
    expect(view.lastError).toEqual({ code: "provider_error", message: "boom" })
  })

  test("records tool calls in the activity stream with their lifecycle status", () => {
    let view = createSessionView("ses_a")
    view = apply(view, "session.tool.input.started", { assistantMessageID: "msg_1", callID: "call_1", name: "shell" })
    view = apply(view, "session.tool.success", {
      assistantMessageID: "msg_1",
      callID: "call_1",
      content: [{ type: "text", text: "ok" }],
    })
    const tool = view.activity.find((item) => item.id === "tool-call_1")
    expect(tool).toMatchObject({ kind: "tool", title: "shell", status: "completed" })

    view = apply(view, "session.tool.failed", { assistantMessageID: "msg_1", callID: "call_2", error: { message: "no" } })
    expect(view.activity.find((item) => item.id === "tool-call_2")).toMatchObject({ status: "failed" })
  })

  test("records shell output bounded and file changes as activity", () => {
    let view = createSessionView("ses_a")
    view = apply(view, "session.shell.started", {
      shell: { id: "sh_1", status: "running", command: "bun test", cwd: "/repo" },
    })
    view = apply(view, "session.shell.ended", {
      shell: { id: "sh_1", status: "exited", command: "bun test", exit: 0 },
      output: { output: "ok", cursor: 2, size: 2 },
    })
    const shell = view.messages.find((message) => message.kind === "shell")
    expect(shell).toMatchObject({
      command: "bun test",
      status: "exited",
      exit: 0,
      output: { text: "ok", cursor: 2, size: 2, truncated: false },
    })
    view = apply(view, "session.file-change.recorded", { change: { path: "src/a.ts", patch: "@@", additions: 3, deletions: 1 } })
    expect(view.activity.find((item) => item.kind === "file")).toMatchObject({ title: "src/a.ts", detail: "+3 −1" })
  })
})

describe("unknown and ignored events", () => {
  test("counts genuinely unknown events", () => {
    const view = apply(createSessionView("ses_a"), "session.future.thing", { value: 1 })
    expect(view.unhandledEvents).toBe(1)
  })

  test("does not count events the client intentionally does not project", () => {
    let view = createSessionView("ses_a")
    view = apply(view, "session.context.observed", { source: "session-state", text: "…" })
    view = apply(view, "session.instructions.updated", { delta: {} })
    expect(view.unhandledEvents).toBe(0)
  })

  test("counts malformed payloads rather than guessing fields", () => {
    const view = applySessionEvent(createSessionView("ses_a"), { type: "session.text.delta", data: {} }, 1)
    expect(view.unhandledEvents).toBe(1)
    expect(view.messages).toHaveLength(0)
  })
})

describe("snapshot readers", () => {
  test("reads projected messages and rejects unknown shapes", () => {
    const messages = readMessageList({
      data: [
        { id: "msg_1", type: "user", text: "hello", time: { created: 3 } },
        { id: "msg_2", type: "system", text: "notice", time: { created: 4 } },
        { id: "msg_3", type: "assistant", content: [{ type: "text", text: "hi" }], time: { created: 5, completed: 6 }, agent: "god" },
        { id: "msg_4", type: "unknown-future-type" },
        { type: "user", text: "no id" },
      ],
    })
    expect(messages.map((message) => message.id)).toEqual(["msg_1", "msg_2", "msg_3"])
    expect(messages[2]).toMatchObject({ kind: "assistant", agent: "god", completed: 6 })
    expect(readMessageList(undefined)).toHaveLength(0)
    // A bare array is not the Protocol envelope, so it is refused rather than guessed.
    expect(readMessageList([{ id: "msg_1", type: "user", text: "bare" }])).toHaveLength(0)
  })

  test("reads assistant snapshot parts including tool completion", () => {
    const parts = readSnapshotParts([
      { type: "reasoning", text: "why" },
      { type: "text", text: "answer" },
      { type: "tool", id: "call_1", name: "read", state: { status: "completed", input: { path: "a" }, content: [{ type: "text", text: "file body" }] } },
      { type: "tool", id: "call_2", name: "edit", state: { status: "error", error: { message: "denied" } } },
    ])
    expect(parts[0]).toEqual({ kind: "reasoning", ordinal: 0, text: "why" })
    expect(parts[2]).toMatchObject({ kind: "tool", callID: "call_1", status: "completed" })
    expect(parts[3]).toMatchObject({ kind: "tool", callID: "call_2", status: "failed", error: "denied" })
  })

  test("reads autonomy from a set response", () => {
    expect(
      readAutonomy({
        data: { mode: "normal", yolo: 3, goal: { text: "Ship it", status: "active", iteration: 2, noProgress: 1, maxNoProgress: 5 } },
      }),
    ).toEqual({ mode: "goal", yolo: 3, goal: { text: "Ship it", status: "active", iteration: 2, noProgress: 1, maxNoProgress: 5 } })
    expect(readAutonomy({ data: { mode: "normal", yolo: false } })).toEqual({ mode: "normal", yolo: 0 })
    expect(readAutonomy({ data: {} })).toEqual({ mode: "normal", yolo: 0 })
    expect(readAutonomy(null)).toBeUndefined()
  })

  test("drops malformed Form.Info values", () => {
    expect(
      readForms([
        { id: "frm_bad_option", sessionID: "ses_a", title: "Question", fields: [{ key: "q0", type: "string", options: [{ value: "a", label: "A" }, { nope: true }] }] },
        { id: "frm_bad_fields", sessionID: "ses_a", title: "Missing fields" },
      ]),
    ).toEqual([])
  })
})

describe("boundedText", () => {
  test("keeps short values intact and truncates long ones", () => {
    expect(boundedText("short")).toEqual({ text: "short", truncated: false })
    const long = boundedText("x".repeat(10), 4)
    expect(long).toEqual({ text: "xxxx", truncated: true })
  })
})

describe("shell output contract", () => {
  test("keeps the device's available page and its source cursor metadata", () => {
    const page = "line\n".repeat(1_500)
    let view = createSessionView("ses_a")
    view = apply(view, "session.shell.started", {
      shell: { id: "sh_1", status: "running", command: "bun test", cwd: "/repo" },
    })
    view = apply(view, "session.shell.ended", {
      shell: { id: "sh_1", status: "exited", command: "bun test", exit: 0 },
      output: { output: page, cursor: 8_192, size: 65_536, truncated: false },
    })

    const shell = view.messages.find((message) => message.kind === "shell")
    if (shell?.kind !== "shell") throw new Error("expected a shell message")
    // The 6 000-character page survives intact: no local display cap drops device output.
    expect(shell.output).toEqual({ text: page, cursor: 8_192, size: 65_536, truncated: false })
  })

  test("keeps the source metadata from a snapshot message and refuses a page without it", () => {
    const messages = readMessageList({
      data: [
        {
          id: "msg_shell",
          type: "shell",
          shellID: "sh_1",
          command: "bun test",
          status: "exited",
          output: { output: "ok", cursor: 2, size: 10, truncated: true },
          time: { created: 1, completed: 2 },
        },
        {
          id: "msg_shell_incomplete",
          type: "shell",
          shellID: "sh_2",
          command: "bun test",
          status: "exited",
          output: { output: "no metadata" },
          time: { created: 1 },
        },
      ],
    })
    expect(messages[0]).toMatchObject({ kind: "shell", output: { text: "ok", cursor: 2, size: 10, truncated: true } })
    const incomplete = messages[1]
    if (incomplete?.kind !== "shell") throw new Error("expected a shell message")
    expect(incomplete.output).toBeUndefined()
  })

  test("states the device limit separately from the collapsed preview", () => {
    expect(shellOutputNotice({ text: "ok", cursor: 2, size: 2, truncated: false })).toBeUndefined()
    expect(shellOutputNotice({ text: "ok", cursor: 2, size: 10, truncated: false })).toContain("2 of 10 bytes")
    expect(shellOutputNotice({ text: "ok", cursor: 10, size: 10, truncated: true })).toContain("truncated")
  })
})

describe("shell output paging", () => {
  const page = (text: string, cursor: number, size: number): ShellOutputView => ({ text, cursor, size, truncated: false })
  const shellView = (...shellIDs: readonly string[]): SessionView =>
    shellIDs.reduce(
      (view, shellID, index) =>
        apply(view, "session.shell.ended", {
          shell: { id: shellID, status: "exited", command: `command ${index}` },
          output: { output: "", cursor: 0, size: 0, truncated: false },
        }),
      createSessionView("ses_a"),
    )

  test("appends a fetched continuation page to the text already held", () => {
    const first = mergeShellOutputSnapshot(undefined, page("first", 5, 11))
    expect(appendShellOutputPage(first, page("second", 11, 11), 5)).toEqual(page("firstsecond", 11, 11))
  })

  test("keeps the longer text when a device page only repeats a fetched prefix", () => {
    const held = appendShellOutputPage(
      mergeShellOutputSnapshot(undefined, page("first", 5, 11)),
      page("second", 11, 11),
      5,
    )
    // The re-sent durable page covers bytes [0, 5) only, so the fetched text stays.
    expect(mergeShellOutputSnapshot(held, page("first", 5, 11))).toEqual(page("firstsecond", 11, 11))
  })

  test("drops a fetched page whose bytes a durable update already covered", () => {
    const held = mergeShellOutputSnapshot(undefined, page("first", 5, 20))
    // The durable page advanced the client to 12 while the page still described bytes from 5.
    const durable = mergeShellOutputSnapshot(held, page("firstsecond", 12, 20))
    expect(durable).toEqual(page("firstsecond", 12, 20))
    expect(appendShellOutputPage(durable, page("cond", 15, 20), 5)).toEqual(durable)
  })

  test("never rewinds the cursor when a page reports a smaller device capture", () => {
    const held = page("firstsecond", 11, 11)
    // The service clamps a cursor past its own capture, so a late page can name fewer bytes.
    expect(appendShellOutputPage(held, page("", 4, 4), 11)).toEqual(page("firstsecond", 11, 11))
  })

  test("reads a page from the operation response envelope and refuses an unreadable one", () => {
    expect(readShellOutputPage({ data: { output: "ok", cursor: 2, size: 9, truncated: false } })).toEqual(page("ok", 2, 9))
    expect(readShellOutputPage({ data: { output: "ok", cursor: 2, size: 9, truncated: true } })).toMatchObject({
      truncated: true,
    })
    expect(readShellOutputPage({ data: { output: "ok" } })).toBeUndefined()
    expect(readShellOutputPage(null)).toBeUndefined()
  })

  test("finds one shell's capture in the transcript and in the tool call that ran it", () => {
    const view = shellView("sh_1", "sh_2")
    const paged = withShellOutputPage(view, "sh_1", page("hello", 5, 5), 0, { state: "idle" })
    expect(shellOutputFor(paged, "sh_1")).toEqual(page("hello", 5, 5))
    expect(shellOutputFor(paged, "sh_2")).toEqual(page("", 0, 0))

    const toolView = apply(createSessionView("ses_a"), "session.tool.success", {
      assistantMessageID: "msg_1",
      callID: "call_1",
      name: "shell",
      content: [{ type: "text", text: "The command was moved to the background." }],
      structured: { shellID: "sh_9", truncated: false },
    })
    expect(shellOutputFor(toolView, "sh_9")).toBeUndefined()
    const toolPaged = withShellOutputPage(toolView, "sh_9", page("tail", 4, 40), 0, { state: "idle" })
    expect(shellOutputFor(toolPaged, "sh_9")).toEqual(page("tail", 4, 40))
  })

  test("applies a fetched page only to the shell it names", () => {
    const view = shellView("sh_1", "sh_2")
    const paged = withShellOutputPage(view, "sh_2", page("only two", 8, 8), 0, { state: "idle" })
    expect(shellOutputFor(paged, "sh_1")).toEqual(page("", 0, 0))
    expect(shellOutputFor(paged, "sh_2")).toEqual(page("only two", 8, 8))
    // The untouched shell keeps its identity, so nothing else in the transcript is rebuilt.
    expect(paged.messages[0]).toBe(view.messages[0])
  })

  test("records the client page-request state without touching device data", () => {
    const view = shellView("sh_1")
    const loading = withShellOutputFetch(view, "sh_1", { state: "loading" })
    expect(shellOutputFor(loading, "sh_1")).toEqual(page("", 0, 0))
    const message = loading.messages[0]
    if (message?.kind !== "shell") throw new Error("expected a shell message")
    expect(message.outputFetch).toEqual({ state: "loading" })

    // A running shell has no page yet, so the request state is all the client holds.
    const running = apply(createSessionView("ses_a"), "session.shell.started", {
      shell: { id: "sh_3", status: "running", command: "tail -f log" },
    })
    const loadingRunning = withShellOutputFetch(running, "sh_3", { state: "loading" })
    const runningMessage = loadingRunning.messages.find((entry) => entry.kind === "shell")
    if (runningMessage?.kind !== "shell") throw new Error("expected a shell message")
    expect(runningMessage.output).toBeUndefined()
    expect(runningMessage.outputFetch).toEqual({ state: "loading" })
  })

  test("leaves a view with no such shell unchanged", () => {
    const view = shellView("sh_1")
    expect(withShellOutputFetch(view, "sh_missing", { state: "loading" })).toBe(view)
    expect(withShellOutputPage(view, "sh_missing", page("x", 1, 1), 0, { state: "idle" })).toBe(view)
  })

  test("reads back the client request state wherever the client holds that shell", () => {
    const view = shellView("sh_1")
    expect(shellOutputFetchFor(view, "sh_1")).toBeUndefined()
    const loading = withShellOutputFetch(view, "sh_1", { state: "loading" })
    expect(shellOutputFetchFor(loading, "sh_1")).toEqual({ state: "loading" })
    expect(shellOutputFetchFor(loading, "sh_missing")).toBeUndefined()

    const toolView = apply(createSessionView("ses_a"), "session.tool.success", {
      assistantMessageID: "msg_1",
      callID: "call_1",
      name: "shell",
      content: [{ type: "text", text: "The command was moved to the background." }],
      structured: { shellID: "sh_9", truncated: false },
    })
    expect(shellOutputFetchFor(withShellOutputFetch(toolView, "sh_9", { state: "stalled" }), "sh_9")).toEqual({
      state: "stalled",
    })
  })

  test("accepts only a device-reported shell id on a tool part", () => {
    const part = { kind: "tool" as const, callID: "call_1", name: "shell", status: "completed" as const, content: [] }
    expect(toolShellID({ ...part, structured: { shellID: "sh_abc123" } })).toBe("sh_abc123")
    expect(toolShellID({ ...part, structured: { shellID: "/tmp/shell.out" } })).toBeUndefined()
    expect(toolShellID({ ...part, structured: { shellID: "sh_1/../../etc" } })).toBeUndefined()
    expect(toolShellID({ ...part, structured: {} })).toBeUndefined()
    expect(toolShellID(part)).toBeUndefined()
  })

  test("keeps the fetched text when a durable page arrives while it is held", () => {
    const paged = withShellOutputPage(shellView("sh_1"), "sh_1", page("firstsecond", 11, 20), 0, { state: "idle" })
    const durable = apply(paged, "session.shell.ended", {
      shell: { id: "sh_1", status: "exited", command: "command 0" },
      output: { output: "first", cursor: 5, size: 20, truncated: false },
    })
    expect(shellOutputFor(durable, "sh_1")).toEqual(page("firstsecond", 11, 20))
  })
})

describe("previewText", () => {
  test("returns text that already fits unchanged", () => {
    expect(previewText("short", { lines: 12, chars: 2_000 })).toEqual({ text: "short", hasMore: false })
    expect(previewText("x".repeat(2_000), { lines: 12, chars: 2_000 })).toEqual({
      text: "x".repeat(2_000),
      hasMore: false,
    })
  })

  test("cuts to the line budget and reports that more is available", () => {
    const text = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n")
    const preview = previewText(text, { lines: 3, chars: 10_000 })
    expect(preview.text).toBe("line 1\nline 2\nline 3")
    expect(preview.hasMore).toBe(true)
  })

  test("cuts a single long line to the character budget", () => {
    const preview = previewText("y".repeat(5_000), { lines: 12, chars: 2_000 })
    expect(preview.text.length).toBe(2_000)
    expect(preview.hasMore).toBe(true)
  })

  test("keeps the default collapsed preview small", () => {
    const preview = previewText(Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join("\n"))
    expect(preview.hasMore).toBe(true)
    expect(preview.text.split("\n").length).toBeLessThanOrEqual(12)
    expect(previewText("z".repeat(50_000)).text.length).toBeLessThanOrEqual(2_000)
  })
})

describe("tool structured metadata", () => {
  test("keeps the structured record the device sent, live and from a snapshot", () => {
    let view = createSessionView("ses_a")
    view = apply(view, "session.tool.success", {
      assistantMessageID: "msg_1",
      callID: "call_1",
      content: [{ type: "text", text: "ok" }],
      structured: { shellID: "sh_1", truncated: true, exit: 1 },
    })
    const message = view.messages[0]
    if (message?.kind !== "assistant") throw new Error("expected an assistant message")
    const tool = message.parts.find((part) => part.kind === "tool")
    expect(tool).toMatchObject({ structured: { shellID: "sh_1", truncated: true, exit: 1 } })
    // The bounded text stays exactly what the device sent: no rewriting, no path stripping.
    expect(tool).toMatchObject({ content: [{ kind: "text", text: "ok" }] })

    const parts = readSnapshotParts([
      {
        type: "tool",
        id: "call_2",
        name: "shell",
        state: { status: "completed", input: {}, content: [], structured: { shellID: "sh_2", truncated: false } },
      },
    ])
    expect(parts[0]).toMatchObject({ kind: "tool", structured: { shellID: "sh_2", truncated: false } })
  })
})

describe("recorded file changes", () => {
  test("keeps a patch per path and replaces the same path on a later record", () => {
    let view = createSessionView("ses_a")
    view = apply(view, "session.file-change.recorded", {
      change: { path: "src/a.ts", patch: "@@ one", additions: 3, deletions: 1 },
    })
    view = apply(view, "session.file-change.recorded", {
      change: { path: "src/a.ts", patch: "@@ two", additions: 5, deletions: 2 },
    })
    view = apply(view, "session.file-change.recorded", {
      change: { path: "src/b.ts", patch: "@@ b", additions: 1, deletions: 0 },
    })
    expect(view.fileChanges).toEqual([
      { path: "src/a.ts", patch: "@@ two", additions: 5, deletions: 2 },
      { path: "src/b.ts", patch: "@@ b", additions: 1, deletions: 0 },
    ])
    expect(view.activity.filter((item) => item.kind === "file").map((item) => item.id)).toEqual(["file-src/a.ts", "file-src/b.ts"])
  })

  test("reads the ledger envelope and drops entries without a path", () => {
    expect(
      readFileChangeList({
        data: [
          { path: "src/a.ts", patch: "@@", additions: 1, deletions: 1 },
          { patch: "no path", additions: 0, deletions: 0 },
        ],
      }),
    ).toEqual([{ path: "src/a.ts", patch: "@@", additions: 1, deletions: 1 }])
    expect(readFileChangeList(null)).toHaveLength(0)
  })

  test("merges latest per path with the live record winning", () => {
    expect(
      mergeFileChanges(
        [
          { path: "src/a.ts", patch: "ledger", additions: 1, deletions: 0 },
          { path: "src/b.ts", patch: "b", additions: 2, deletions: 0 },
        ],
        [{ path: "src/a.ts", patch: "live", additions: 3, deletions: 1 }],
      ),
    ).toEqual([
      { path: "src/a.ts", patch: "live", additions: 3, deletions: 1 },
      { path: "src/b.ts", patch: "b", additions: 2, deletions: 0 },
    ])
  })

  test("reads a live record from its event envelope only", () => {
    expect(
      readFileChangeEvent({ type: "session.file-change.recorded", data: { change: { path: "src/a.ts", patch: "@@" } } }),
    ).toEqual({ path: "src/a.ts", patch: "@@", additions: 0, deletions: 0 })
    expect(readFileChangeEvent({ type: "session.tool.success", data: { change: { path: "src/a.ts" } } })).toBeUndefined()
    expect(readFileChangeEvent({ type: "session.file-change.recorded", data: {} })).toBeUndefined()
  })

  test("counts a record without a path instead of inventing one", () => {
    const view = apply(createSessionView("ses_a"), "session.file-change.recorded", { change: { patch: "@@" } })
    expect(view.unhandledEvents).toBe(1)
    expect(view.fileChanges).toHaveLength(0)
    expect(view.activity).toHaveLength(0)
  })
})
