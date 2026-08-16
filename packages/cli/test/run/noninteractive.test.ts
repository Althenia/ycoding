import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { YCoding, type EventSubscribeOutput, type SessionMessageAssistantTool } from "@ycoding-ai/client/promise"
import { runNonInteractivePrompt } from "../../src/run/noninteractive"

type V2Event = EventSubscribeOutput
type FormInfo = Extract<V2Event, { type: "form.created" }>["data"]["form"]
const location = { directory: "/work tree", workspaceID: "wrk_1" }

function ok<T>(data: T) {
  return Promise.resolve(data)
}

function form(id: string, sessionID: string): FormInfo {
  return {
    id,
    sessionID,
    title: "Input requested",
    fields: [{ key: "authorization", type: "external", url: "https://example.com/form" }],
  }
}

function formCreated(info: FormInfo, eventLocation = location): V2Event {
  return { id: `evt_${info.id}`, created: 0, type: "form.created", location: eventLocation, data: { form: info } }
}

function prompted(inputID: string): V2Event {
  return {
    id: "evt_prompted",
    created: 0,
    type: "session.input.promoted",
    durable: { aggregateID: "ses_1", seq: 0, version: 1 },
    data: { sessionID: "ses_1", inputID },
  }
}

function settled(outcome: "success" | "interrupted" = "success"): V2Event {
  if (outcome === "interrupted")
    return {
      id: "evt_interrupted",
      created: 0,
      type: "session.execution.interrupted",
      durable: { aggregateID: "ses_1", seq: 1, version: 1 },
      data: { sessionID: "ses_1", reason: "user" },
    }
  return {
    id: "evt_succeeded",
    created: 0,
    type: "session.execution.succeeded",
    durable: { aggregateID: "ses_1", seq: 1, version: 1 },
    data: { sessionID: "ses_1" },
  }
}

function stepStarted(): V2Event {
  return {
    id: "evt_step_started",
    created: 1,
    type: "session.step.started",
    durable: { aggregateID: "ses_1", seq: 1, version: 1 },
    data: {
      sessionID: "ses_1",
      assistantMessageID: "msg_assistant",
      agent: "build",
      model: { providerID: "test", id: "test-model" },
    },
  }
}

function stepFailed(message: string): V2Event {
  return {
    id: "evt_step_failed",
    created: 2,
    type: "session.step.failed",
    durable: { aggregateID: "ses_1", seq: 2, version: 1 },
    data: {
      sessionID: "ses_1",
      assistantMessageID: "msg_assistant",
      error: { type: "provider.transport", message },
    },
  }
}

function executionFailed(message: string): V2Event {
  return {
    id: "evt_execution_failed",
    created: 3,
    type: "session.execution.failed",
    durable: { aggregateID: "ses_1", seq: 3, version: 1 },
    data: {
      sessionID: "ses_1",
      error: { type: "provider.transport", message },
    },
  }
}

function failedTool(inputID: string): V2Event[] {
  return [
    prompted(inputID),
    {
      id: "evt_failed_tool_input",
      created: 1,
      type: "session.tool.input.started",
      durable: { aggregateID: "ses_1", seq: 1, version: 1 },
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_failed_tool",
        callID: "call_failed_tool",
        name: "shell",
      },
    },
    {
      id: "evt_failed_tool_called",
      created: 2,
      type: "session.tool.called",
      durable: { aggregateID: "ses_1", seq: 2, version: 1 },
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_failed_tool",
        callID: "call_failed_tool",
        input: { command: "printf partial && false" },
        executed: true,
      },
    },
    {
      id: "evt_failed_tool_progress",
      created: 3,
      type: "session.tool.progress",
      durable: { aggregateID: "ses_1", seq: 3, version: 1 },
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_failed_tool",
        callID: "call_failed_tool",
        structured: { checkpoint: 1 },
        content: [{ type: "text", text: "partial output" }],
      },
    },
    {
      id: "evt_failed_tool_terminal",
      created: 4,
      type: "session.tool.failed",
      durable: { aggregateID: "ses_1", seq: 4, version: 1 },
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_failed_tool",
        callID: "call_failed_tool",
        error: { type: "unknown", message: "tool failed" },
        executed: true,
      },
    },
    settled(),
  ]
}

// Runs one non-interactive prompt against a mocked SDK. `turn` produces the
// live events the prompt admission triggers, keyed by the generated message ID.
async function run(input: {
  turn: (inputID: string) => V2Event[]
  files?: Array<{ url: string; filename: string; mime: string }>
  pendingForms?: FormInfo[]
  attached?: boolean
  format?: "default" | "json"
  cancel?: (input: { sessionID: string; formID: string }) => Promise<void>
  renderTool?: (part: SessionMessageAssistantTool) => Promise<void>
  renderToolError?: (part: SessionMessageAssistantTool) => Promise<void>
}) {
  const sdk = YCoding.make({ baseUrl: "https://ycoding.test" })
  const values: V2Event[] = [{ id: "evt_connected", type: "server.connected", data: {}, sourceEpoch: "1" }]
  let wake: (() => void) | undefined
  const stream = (async function* (): AsyncGenerator<V2Event, void, unknown> {
    while (true) {
      const value = values.shift()
      if (!value) {
        await new Promise<void>((resolve) => {
          wake = resolve
        })
        continue
      }
      yield value
    }
  })()
  spyOn(sdk.event, "subscribe").mockImplementation(() => stream)
  spyOn(sdk.permission, "list").mockImplementation(() => ok([]) as never)
  spyOn(sdk.question, "list").mockImplementation(() => ok([]) as never)
  spyOn(sdk.question, "reject").mockImplementation(() => ok(undefined) as never)
  spyOn(sdk.form, "list").mockImplementation(
    (request) => ok(input.pendingForms?.filter((item) => item.sessionID === request.sessionID) ?? []) as never,
  )
  spyOn(sdk.form.request, "list").mockImplementation(
    () =>
      ok({
        location: { ...location, project: { id: "proj_1", directory: location.directory } },
        data: input.pendingForms?.filter((item) => item.sessionID === "global") ?? [],
      }) as never,
  )
  spyOn(sdk.form, "cancel").mockImplementation((request) => (input.cancel?.(request) ?? ok(undefined)) as never)
  spyOn(sdk.session, "prompt").mockImplementation((request) => {
    const messageID = request.id ?? "msg_prompt"
    values.push(...input.turn(messageID))
    wake?.()
    wake = undefined
    return ok({ admittedSeq: 1, id: messageID, sessionID: "ses_1", timeCreated: 1 }) as never
  })
  await runNonInteractivePrompt({
    client: sdk,
    sessionID: "ses_1",
    location,
    message: "hello",
    files: input.files ?? [],
    thinking: false,
    format: input.format ?? "default",
    auto: false,
    attached: input.attached ?? false,
    renderTool: input.renderTool ?? (() => Promise.resolve()),
    renderToolError: input.renderToolError ?? (() => Promise.resolve()),
  })
  return sdk
}

async function capture(input: Parameters<typeof run>[0]) {
  const stdout: string[] = []
  const stderr: string[] = []
  const exitCode = process.exitCode
  const stdoutWrite = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk))
    return true
  })
  const stderrWrite = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk))
    return true
  })
  try {
    await run(input)
    return { stdout: stdout.join(""), stderr: stderr.join("") }
  } finally {
    process.exitCode = exitCode ?? 0
    stdoutWrite.mockRestore()
    stderrWrite.mockRestore()
  }
}

afterEach(() => {
  mock.restore()
})

describe("runNonInteractivePrompt", () => {
  test("forwards prepared file URIs without embedding file content in text", async () => {
    const files = [
      { url: "file:///tmp/note.txt", filename: "note.txt", mime: "text/plain" },
      { url: "file:///tmp/document.pdf", filename: "document.pdf", mime: "application/pdf" },
    ]
    const sdk = await run({ files, turn: (id) => [prompted(id), settled()] })

    expect(sdk.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "hello",
        files: files.map((file) => ({ uri: file.url, name: file.filename })),
      }),
      expect.anything(),
    )
  })

  test("cancels session and global form blockers and exits on pre-promotion interrupt", async () => {
    const sdk = await run({
      pendingForms: [form("frm_pending", "ses_1"), form("frm_pending_global", "global")],
      // No prompted event: the execution settles interrupted before promotion,
      // which must not leave the consume loop waiting forever.
      turn: () => [formCreated(form("frm_live", "global")), settled("interrupted")],
    })
    const globalOptions = {
      headers: {
        "x-ycoding-directory": "%2Fwork%20tree",
        "x-ycoding-workspace": "wrk_1",
      },
    }
    expect(sdk.form.cancel).toHaveBeenCalledWith({ sessionID: "global", formID: "frm_live" }, globalOptions)
    expect(sdk.form.cancel).toHaveBeenCalledWith({ sessionID: "ses_1", formID: "frm_pending" })
    expect(sdk.form.cancel).toHaveBeenCalledWith({ sessionID: "global", formID: "frm_pending_global" }, globalOptions)
    expect(sdk.form.request.list).toHaveBeenCalledWith({
      location: { directory: "/work tree", workspace: "wrk_1" },
    })
    expect(sdk.question.list).not.toHaveBeenCalled()
    expect(sdk.question.reject).not.toHaveBeenCalled()
  })

  test("attach mode cancels only session-owned forms", async () => {
    const sdk = await run({
      attached: true,
      pendingForms: [form("frm_pending", "ses_1"), form("frm_pending_global", "global")],
      turn: (messageID) => [formCreated(form("frm_live", "global")), prompted(messageID), settled()],
    })
    expect(sdk.form.cancel).toHaveBeenCalledWith({ sessionID: "ses_1", formID: "frm_pending" })
    expect(sdk.form.request.list).not.toHaveBeenCalled()
    expect(sdk.form.cancel).not.toHaveBeenCalledWith({ sessionID: "global", formID: "frm_live" }, expect.anything())
    expect(sdk.form.cancel).not.toHaveBeenCalledWith(
      { sessionID: "global", formID: "frm_pending_global" },
      expect.anything(),
    )
  })

  test("JSON output emits step_start before an unrelated step failure", async () => {
    const output = await capture({
      format: "json",
      turn: (messageID) => [
        prompted(messageID),
        stepStarted(),
        stepFailed("Provider request failed"),
        executionFailed("Provider request failed"),
      ],
    })

    expect(
      output.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    ).toEqual([
      expect.objectContaining({ type: "step_start", part: expect.objectContaining({ type: "step-start" }) }),
      expect.objectContaining({
        type: "error",
        error: { type: "provider.transport", message: "Provider request failed" },
      }),
    ])
    expect(output.stderr).toBe("")
  })

  test("default output emits step_start before an unrelated execution failure", async () => {
    const output = await capture({
      turn: (messageID) => [prompted(messageID), stepStarted(), executionFailed("Execution failed")],
    })

    expect(output.stdout).toBe("")
    expect(output.stderr).toContain("> build · test-model")
    expect(output.stderr).toContain("Error: \u001b[0mExecution failed")
    expect(output.stderr.indexOf("> build · test-model")).toBeLessThan(output.stderr.indexOf("Execution failed"))
  })

  test("reports a missing terminal finish as the current provider failure", async () => {
    const output = await capture({
      format: "json",
      turn: (messageID) => [
        prompted(messageID),
        stepStarted(),
        stepFailed("Provider stream ended without a terminal finish event"),
        executionFailed("Provider stream ended without a terminal finish event"),
      ],
    })

    expect(
      output.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    ).toEqual([
      expect.objectContaining({ type: "step_start" }),
      expect.objectContaining({
        type: "error",
        error: {
          type: "provider.transport",
          message: "Provider stream ended without a terminal finish event",
        },
      }),
    ])
    expect(output.stderr).toBe("")
  })

  test("renders native failed tool output before the terminal error", async () => {
    const rendered: SessionMessageAssistantTool[] = []
    const failed: SessionMessageAssistantTool[] = []
    await capture({
      turn: failedTool,
      renderTool: (part) => {
        rendered.push(part)
        return Promise.resolve()
      },
      renderToolError: (part) => {
        failed.push(part)
        return Promise.resolve()
      },
    })

    expect(rendered).toMatchObject([
      {
        id: "call_failed_tool",
        state: {
          status: "completed",
          structured: { checkpoint: 1 },
          content: [{ type: "text", text: "partial output" }],
        },
      },
    ])
    expect(failed).toMatchObject([
      {
        id: "call_failed_tool",
        state: {
          status: "error",
          structured: { checkpoint: 1 },
          content: [{ type: "text", text: "partial output" }],
          error: { message: "tool failed" },
        },
      },
    ])
  })

  test("keeps failed tool partial output out of the current JSON event shape", async () => {
    const output = await capture({ format: "json", turn: failedTool })
    const events = output.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "tool_use",
      part: {
        type: "tool",
        callID: "call_failed_tool",
        tool: "shell",
        state: {
          status: "error",
          input: { command: "printf partial && false" },
          error: "tool failed",
        },
      },
    })
    expect(events[0].part.state.output).toBeUndefined()
    expect(events[0].part.state.metadata.structured).toBeUndefined()
    expect(events[0].part.state.metadata.content).toBeUndefined()
    expect(output.stderr).toBe("")
  })
})
