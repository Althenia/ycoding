import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import {
  YCoding,
  type EventSubscribeOutput,
  type SessionMessageAssistantTool,
  type YCodingClient,
} from "@ycoding-ai/client/promise"
import { runNonInteractivePrompt } from "../../src/run/noninteractive"

type ServerEvent = EventSubscribeOutput
type FormInfo = Extract<ServerEvent, { type: "form.created" }>["data"]["form"]
type GuardrailInfo = Extract<ServerEvent, { type: "guardrail.asked" }>["data"]
const location = { directory: "/work tree", workspaceID: "wrk_1" }
const hardGuardrail: GuardrailInfo = {
  id: "grq_1",
  rootSessionID: "ses_1",
  sessionID: "ses_1",
  action: "write",
  resources: ["secret.txt"],
  ruleIDs: ["hard-review"],
  reason: "Human review required",
  standard: false,
  hardReview: true,
}

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

function formCreated(info: FormInfo, eventLocation = location): ServerEvent {
  return { id: `evt_${info.id}`, created: 0, type: "form.created", location: eventLocation, data: { form: info } }
}

function permissionAsked(): ServerEvent {
  return {
    id: "evt_permission",
    created: 0,
    type: "permission.asked",
    data: { id: "per_1", sessionID: "ses_1", action: "shell", resources: ["git status"] },
  }
}

function questionAsked(): ServerEvent {
  return {
    id: "evt_question",
    created: 0,
    type: "question.asked",
    data: {
      id: "que_1",
      sessionID: "ses_1",
      questions: [
        {
          header: "Choice",
          question: "Continue?",
          options: [{ label: "Yes", description: "Continue execution" }],
        },
      ],
    },
  }
}

function guardrailAsked(): ServerEvent {
  return {
    id: "evt_guardrail",
    created: 0,
    type: "guardrail.asked",
    data: hardGuardrail,
  }
}

function prompted(inputID: string): ServerEvent {
  return {
    id: "evt_prompted",
    created: 0,
    type: "session.input.promoted",
    durable: { aggregateID: "ses_1", seq: 0, version: 1 },
    data: { sessionID: "ses_1", inputID },
  }
}

function settled(outcome: "success" | "interrupted" = "success"): ServerEvent {
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

function stepStarted(): ServerEvent {
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

function childDrain(sessionID: string, types: string[]): ServerEvent[] {
  return [
    "session.execution.started",
    ...types,
    "session.execution.succeeded",
  ].map((type, index) => ({ id: `evt_${sessionID}_${index}`, created: index, type, data: { sessionID } }) as unknown as ServerEvent)
}

const zeroTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const zeroMetrics = { logical: 0, physical: 0, helpers: 0, tokens: zeroTokens }

function stepEnded(seq: number, extra: Record<string, unknown> = {}): ServerEvent {
  return {
    id: `evt_step_ended_${seq}`,
    created: seq,
    type: "session.step.ended",
    durable: { aggregateID: "ses_1", seq, version: 1 },
    data: {
      sessionID: "ses_1",
      assistantMessageID: "msg_assistant",
      finish: "stop",
      cost: 0,
      tokens: zeroTokens,
      ...extra,
    },
  } as ServerEvent
}

function stepFailed(message: string): ServerEvent {
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

function executionFailed(message: string): ServerEvent {
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

function failedTool(inputID: string): ServerEvent[] {
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
  turn: (inputID: string) => ServerEvent[]
  files?: Array<{ url: string; filename: string; mime: string }>
  model?: { providerID: string; modelID: string }
  variant?: string
  profile?: string
  pendingForms?: FormInfo[]
  pendingGuardrails?: GuardrailInfo[]
  attached?: boolean
  format?: "default" | "json"
  close?: boolean
  cancel?: (input: { sessionID: string; formID: string }) => Promise<void>
  renderTool?: (part: SessionMessageAssistantTool) => Promise<void>
  renderToolError?: (part: SessionMessageAssistantTool) => Promise<void>
  /** Provider-request usage report for the run window; defaults to an empty report. */
  report?: Awaited<ReturnType<YCodingClient["session"]["usageReport"]>>
  usageFailure?: Error
  /** Managed subagent tasks keyed by parent Session. */
  tasks?: Record<string, Array<{ sessionID: string; agent: string; state: string }>>
  agents?: Record<string, string>
}) {
  const sdk = YCoding.make({ baseUrl: "https://ycoding.test" })
  const values: ServerEvent[] = [{ id: "evt_connected", type: "server.connected", data: {}, sourceEpoch: "1" }]
  let submitted = false
  let wake: (() => void) | undefined
  const stream = (async function* (): AsyncGenerator<ServerEvent, void, unknown> {
    while (true) {
      const value = values.shift()
      if (!value) {
        if (input.close && submitted) return
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
  spyOn(sdk.permission, "reply").mockImplementation(() => ok(undefined) as never)
  spyOn(sdk.question, "list").mockImplementation(() => ok([]) as never)
  spyOn(sdk.question, "reject").mockImplementation(() => ok(undefined) as never)
  spyOn(sdk.guardrail.request, "list").mockImplementation(() => ok(input.pendingGuardrails ?? []) as never)
  spyOn(sdk.guardrail.request, "reply").mockImplementation(() => ok(undefined) as never)
  spyOn(sdk.session, "interrupt").mockImplementation(() => ok(undefined) as never)
  spyOn(sdk.session, "switchModel").mockImplementation(() => ok(undefined) as never)
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
  spyOn(sdk.session, "usageReport").mockImplementation((() =>
    input.usageFailure
      ? Promise.reject(input.usageFailure)
      : ok(input.report ?? { group: "session", rows: [], total: { ...zeroMetrics }, rowCount: 0 })) as never)
  spyOn(sdk.session.subagent, "list").mockImplementation(((request: { parentID: string }) =>
    ok({
      data: input.tasks?.[request.parentID] ?? [],
      summary: { total: 0, active: 0, running: 0, waiting: 0 },
      cursor: {},
    })) as never)
  spyOn(sdk.session, "get").mockImplementation(((request: { sessionID: string }) =>
    ok({ id: request.sessionID, agent: input.agents?.[request.sessionID] })) as never)
  spyOn(sdk.session, "prompt").mockImplementation((request) => {
    submitted = true
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
    model: input.model,
    variant: input.variant,
    profile: input.profile,
    thinking: false,
    format: input.format ?? "default",
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
    const sdk = await run(input)
    return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode: process.exitCode, sdk }
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
  test("forwards explicit profile-qualified model selections to the Session", async () => {
    const sdk = await run({
      model: { providerID: "openai", modelID: "gpt-6-luna" },
      variant: "high",
      profile: "Work",
      turn: (messageID) => [prompted(messageID), settled()],
    })

    expect(sdk.session.switchModel).toHaveBeenCalledWith({
      sessionID: "ses_1",
      model: { providerID: "openai", id: "gpt-6-luna", variant: "high", profile: "Work" },
    })
  })

  test("reports skill-load execution failure before prompt promotion instead of waiting for a model", async () => {
    const output = await capture({
      format: "json",
      close: true,
      turn: () => [
        {
          id: "evt_skill_failed",
          created: 3,
          type: "session.execution.failed",
          durable: { aggregateID: "ses_1", seq: 3, version: 1 },
          data: {
            sessionID: "ses_1",
            error: { type: "skill.unavailable", message: "Skill unavailable: explicit-audit" },
          },
        },
      ],
    })
    expect(output.exitCode).toBe(1)
    expect(
      output.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    ).toEqual([
      expect.objectContaining({
        type: "error",
        error: { type: "skill.unavailable", message: "Skill unavailable: explicit-audit" },
      }),
      expect.objectContaining({ type: "run_finish", status: "failed", steps: 0 }),
    ])
    expect(output.stderr).toBe("")
  })

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
    const output = await capture({
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
    expect(output.sdk.form.cancel).toHaveBeenCalledWith({ sessionID: "global", formID: "frm_live" }, globalOptions)
    expect(output.sdk.form.cancel).toHaveBeenCalledWith({ sessionID: "ses_1", formID: "frm_pending" })
    expect(output.sdk.form.cancel).toHaveBeenCalledWith(
      { sessionID: "global", formID: "frm_pending_global" },
      globalOptions,
    )
    expect(output.sdk.form.request.list).toHaveBeenCalledWith({
      location: { directory: "/work tree", workspace: "wrk_1" },
    })
    expect(output.stderr).toContain("form requested")
    expect(output.exitCode).toBe(1)
  })

  test("attach mode cancels only session-owned forms", async () => {
    const output = await capture({
      attached: true,
      pendingForms: [form("frm_pending", "ses_1"), form("frm_pending_global", "global")],
      turn: (messageID) => [formCreated(form("frm_live", "global")), prompted(messageID), settled()],
    })
    expect(output.sdk.form.cancel).toHaveBeenCalledWith({ sessionID: "ses_1", formID: "frm_pending" })
    expect(output.sdk.form.request.list).not.toHaveBeenCalled()
    expect(output.sdk.form.cancel).not.toHaveBeenCalledWith(
      { sessionID: "global", formID: "frm_live" },
      expect.anything(),
    )
    expect(output.sdk.form.cancel).not.toHaveBeenCalledWith(
      { sessionID: "global", formID: "frm_pending_global" },
      expect.anything(),
    )
  })

  test("rejects a permission blocker without locally approving it", async () => {
    const output = await capture({
      turn: (messageID) => [permissionAsked(), prompted(messageID), settled("interrupted")],
    })

    expect(output.sdk.permission.reply).toHaveBeenCalledWith({
      sessionID: "ses_1",
      requestID: "per_1",
      reply: "reject",
    })
    expect(output.sdk.permission.reply).not.toHaveBeenCalledWith(expect.objectContaining({ reply: "once" }))
    expect(output.stderr).toContain("permission requested")
    expect(output.exitCode).toBe(1)
    expect(output.sdk.session.interrupt).toHaveBeenCalledTimes(1)
    expect(output.sdk.session.interrupt).toHaveBeenCalledWith({ sessionID: "ses_1" })
  })

  test("rejects a question blocker instead of choosing an answer locally", async () => {
    const output = await capture({
      turn: (messageID) => [questionAsked(), prompted(messageID), settled("interrupted")],
    })

    expect(output.sdk.question.reject).toHaveBeenCalledWith({ sessionID: "ses_1", requestID: "que_1" })
    expect(output.stderr).toContain("question requested")
    expect(output.exitCode).toBe(1)
    expect(output.sdk.session.interrupt).toHaveBeenCalledTimes(1)
    expect(output.sdk.session.interrupt).toHaveBeenCalledWith({ sessionID: "ses_1" })
  })

  test("rejects a hard guardrail blocker without locally approving it", async () => {
    const output = await capture({ turn: () => [guardrailAsked(), settled("interrupted")] })

    expect(output.sdk.guardrail.request.reply).toHaveBeenCalledWith({
      sessionID: "ses_1",
      requestID: "grq_1",
      reply: "reject",
    })
    expect(output.sdk.guardrail.request.reply).not.toHaveBeenCalledWith(expect.objectContaining({ reply: "once" }))
    expect(output.stderr).toContain("guardrail review required")
    expect(output.exitCode).toBe(1)
  })

  test("rejects an already-pending hard guardrail blocker after prompt admission", async () => {
    const output = await capture({
      pendingGuardrails: [hardGuardrail],
      turn: (messageID) => [prompted(messageID), settled()],
    })

    expect(output.sdk.guardrail.request.list).toHaveBeenCalledWith({ sessionID: "ses_1" })
    expect(output.sdk.guardrail.request.reply).toHaveBeenCalledWith({
      sessionID: "ses_1",
      requestID: "grq_1",
      reply: "reject",
    })
    expect(output.stderr).toContain("guardrail review required")
    expect(output.exitCode).toBe(1)
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
      expect.objectContaining({ type: "run_finish", status: "failed", steps: 1 }),
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
      expect.objectContaining({ type: "run_finish", status: "failed" }),
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

    expect(events.map((event) => event.type)).toEqual(["tool_use", "run_finish"])
    expect(events[1]).toMatchObject({ status: "succeeded" })
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

  describe("JSON run metrics", () => {
    const lines = (stdout: string) =>
      stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    const sessionRow = (key: string, tokens: typeof zeroTokens, extra: Record<string, unknown> = {}) => ({
      key,
      label: key,
      logical: 2,
      physical: 3,
      helpers: 0,
      tokens,
      ...extra,
    })

    test("reports step identity, context, cache, and exactly one run summary", async () => {
      const providerCache = { mechanism: "provider-reported", readReported: true, writeReported: false }
      const contextBreakdown = { system: 10, tools: 5, user: 3, assistant: 2, reasoning: 0, toolCalls: 1, other: 0 }
      const total = {
        logical: 3,
        physical: 4,
        helpers: 1,
        tokens: { input: 300, output: 40, reasoning: 5, cache: { read: 200, write: 10 } },
        cost: 0.9,
        costProvenance: "recorded",
      }
      const output = await capture({
        format: "json",
        report: { group: "session", rows: [], rowCount: 0, total } as never,
        turn: (messageID) => [
          prompted(messageID),
          stepStarted(),
          stepEnded(2, {
            cost: 0.5,
            tokens: { input: 100, output: 10, reasoning: 2, cache: { read: 50, write: 5 } },
            contextLimit: 1000,
            contextBreakdown,
            providerCache,
          }),
          stepStarted(),
          stepEnded(3, {
            cost: 0.25,
            tokens: { input: 20, output: 5, reasoning: 0, cache: { read: 300, write: 0 } },
          }),
          settled(),
        ],
      })

      const events = lines(output.stdout)
      expect(events.map((event) => event.type)).toEqual([
        "step_start",
        "step_finish",
        "step_start",
        "step_finish",
        "run_finish",
      ])
      expect(events[0].part).toMatchObject({ agent: "build", model: { providerID: "test", id: "test-model" } })
      expect(events[1].part).toMatchObject({ contextLimit: 1000, contextBreakdown, providerCache })
      for (const key of ["contextLimit", "contextBreakdown", "providerCache"])
        expect(events[3].part).not.toHaveProperty(key)
      expect(events[4]).toEqual({
        type: "run_finish",
        timestamp: expect.any(Number),
        sessionID: "ses_1",
        status: "succeeded",
        durationMs: expect.any(Number),
        steps: 2,
        turns: 1,
        tokens: { input: 120, output: 15, reasoning: 2, cache: { read: 350, write: 5 } },
        cost: 0.75,
        context: { limit: 1000, peakInput: 320 },
        models: [{ providerID: "test", id: "test-model" }],
        total: {
          tokens: total.tokens,
          cost: 0.9,
          costProvenance: "recorded",
          requests: { logical: 3, physical: 4, helpers: 1 },
          steps: 2,
          turns: 1,
        },
        children: [],
      })
      expect(events[4].durationMs).toBeGreaterThanOrEqual(0)
      expect(output.sdk.session.usageReport).toHaveBeenCalledWith(
        expect.objectContaining({ sessionID: "ses_1", group: "session", from: 1 }),
      )
      expect(output.exitCode).toBe(0)
    })

    test("lists subagents without usage and hidden helper Sessions beside the family total", async () => {
      const tokens = { input: 10, output: 2, reasoning: 0, cache: { read: 4, write: 1 } }
      const output = await capture({
        format: "json",
        report: {
          group: "session",
          rowCount: 3,
          total: { logical: 6, physical: 7, helpers: 2, tokens, cost: 0.3, costProvenance: "current_catalog" },
          rows: [
            sessionRow("ses_1", tokens),
            sessionRow("ses_sub", tokens, { cost: 0.1, costProvenance: "recorded" }),
            sessionRow("ses_compaction_1", tokens, { helpers: 2 }),
          ],
        } as never,
        tasks: {
          ses_1: [
            { sessionID: "ses_sub", agent: "reviewer", state: "running" },
            { sessionID: "ses_idle", agent: "reviewer", state: "starting" },
          ],
          ses_sub: [{ sessionID: "ses_nested", agent: "reviewer", state: "completed" }],
        },
        agents: { ses_compaction_1: "compaction" },
        turn: (messageID) => [
          prompted(messageID),
          stepEnded(2),
          ...childDrain("ses_sub", ["session.input.promoted", "session.step.ended", "session.input.promoted", "session.step.failed"]),
          ...childDrain("ses_sub", ["session.input.promoted", "session.step.ended"]),
          ...childDrain("ses_nested", ["session.input.promoted", "session.step.ended"]),
          ...childDrain("ses_compaction_1", ["session.step.ended"]),
          ...childDrain("ses_unrelated", ["session.input.promoted", "session.step.ended"]),
          settled(),
        ],
      })

      const summary = lines(output.stdout).at(-1)
      expect(summary.turns).toBe(1)
      expect(summary.total).toMatchObject({
        cost: 0.3,
        costProvenance: "current_catalog",
        steps: 1 + 3 + 1,
        turns: 1 + 2 + 1,
      })
      expect(summary.children).toEqual([
        {
          sessionID: "ses_sub",
          kind: "subagent",
          agent: "reviewer",
          status: "running",
          tokens,
          cost: 0.1,
          costProvenance: "recorded",
          requests: { logical: 2, physical: 3, helpers: 0 },
          steps: 3,
          turns: 2,
        },
        {
          sessionID: "ses_idle",
          kind: "subagent",
          agent: "reviewer",
          status: "starting",
          tokens: zeroTokens,
          requests: { logical: 0, physical: 0, helpers: 0 },
          steps: 0,
          turns: 0,
        },
        {
          sessionID: "ses_nested",
          kind: "subagent",
          agent: "reviewer",
          status: "completed",
          tokens: zeroTokens,
          requests: { logical: 0, physical: 0, helpers: 0 },
          steps: 1,
          turns: 1,
        },
        {
          sessionID: "ses_compaction_1",
          kind: "helper",
          agent: "compaction",
          tokens,
          requests: { logical: 2, physical: 3, helpers: 2 },
          steps: 1,
        },
      ])
      expect(summary.children[1]).not.toHaveProperty("cost")
      expect(summary.children[3]).not.toHaveProperty("cost")
    })

    test("reports an interrupted run and a blocker-stopped run without a second summary", async () => {
      const interrupted = await capture({
        format: "json",
        turn: (messageID) => [prompted(messageID), stepStarted(), stepEnded(2), settled("interrupted")],
      })
      expect(lines(interrupted.stdout).map((event) => event.type)).toEqual(["step_start", "step_finish", "run_finish"])
      expect(lines(interrupted.stdout).at(-1)).toMatchObject({ status: "interrupted", steps: 1 })

      const blocked = await capture({
        format: "json",
        turn: (messageID) => [permissionAsked(), prompted(messageID), settled("interrupted")],
      })
      expect(lines(blocked.stdout).filter((event) => event.type === "run_finish")).toEqual([
        expect.objectContaining({ status: "failed" }),
      ])
      expect(blocked.exitCode).toBe(1)
    })

    test("counts a failed step with usage and keeps the summary when the usage read fails", async () => {
      const output = await capture({
        format: "json",
        usageFailure: new Error("usage unavailable"),
        turn: (messageID) => [
          prompted(messageID),
          stepStarted(),
          {
            ...stepFailed("Provider request failed"),
            data: {
              sessionID: "ses_1",
              assistantMessageID: "msg_assistant",
              error: { type: "provider.transport", message: "Provider request failed" },
              cost: 0.5,
              tokens: { input: 7, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            },
          } as ServerEvent,
          executionFailed("Provider request failed"),
        ],
      })

      const events = lines(output.stdout)
      expect(events.map((event) => event.type)).toEqual(["step_start", "error", "run_finish"])
      expect(events[2]).toMatchObject({
        status: "failed",
        steps: 1,
        cost: 0.5,
        tokens: { input: 7 },
        usageError: "usage unavailable",
      })
      expect(events[2]).not.toHaveProperty("total")
      expect(events[2]).not.toHaveProperty("children")
      expect(output.exitCode).toBe(1)
    })

    test("default output prints no metrics and reads no usage", async () => {
      const output = await capture({
        turn: (messageID) => [prompted(messageID), stepStarted(), stepEnded(2), settled()],
      })
      expect(output.stdout).toBe("")
      expect(output.sdk.session.usageReport).not.toHaveBeenCalled()
    })
  })
})
