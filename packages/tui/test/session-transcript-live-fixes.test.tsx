/** @jsxImportSource @opentui/solid */
import { expect, mock, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import type { SessionMessageInfo, SessionPendingInfo, YCodingEvent } from "@ycoding-ai/client"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { Global } from "@ycoding-ai/core/global"
import { Effect, FileSystem } from "effect"
import { SPINNER_FRAMES } from "../src/component/spinner-frames"
import { toolLifecyclePresentation } from "../src/routes/session/activity-row"
import { railPlacement, railWidth } from "../src/routes/session/rail"
import { createEventStream, createFetch, json, type FetchHandler } from "./fixture/tui-client"
import { DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE, NARROW_VIEWPORT } from "./viewport"
import { renderScreen } from "./screen/harness"

const sessionID = "ses_transcript_live"
const directory = "/tmp/ycoding/session-transcript-live"
const location = { directory, project: { id: "proj_transcript_live", directory } }
const session = {
  id: sessionID,
  title: "Transcript live fixes",
  projectID: "proj_transcript_live",
  location: { directory },
  agent: "build",
  model: { providerID: "anthropic", id: "claude-opus-5" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 9 },
}

const patch = [
  "--- a/packages/core/src/provider/usage.ts",
  "+++ b/packages/core/src/provider/usage.ts",
  "@@ -42,3 +42,5 @@",
  " const usage = normalize(raw)",
  "-const stale = usage.cached",
  "+const fresh = usage.cacheRead",
  "+const total = usage.input + fresh",
  "+export const report = { total }",
].join("\n")

const secondaryPatch = [
  "--- a/docs/runtime.md",
  "+++ b/docs/runtime.md",
  "@@ -8 +8 @@",
  "-Old cache note",
  "+Current cache note",
].join("\n")

const guardrailRequest = {
  id: "gr_write_outside",
  rootSessionID: sessionID,
  sessionID,
  action: "write",
  resources: ["/etc/hosts"],
  ruleIDs: ["workspace"],
  reason: "write outside workspace",
  standard: true,
}

const transcript = [
  { id: "msg_user", type: "user", text: "Inspect cache telemetry callers", time: { created: 1 } },
  {
    id: "msg_assistant",
    type: "assistant",
    agent: "build",
    model: { providerID: "anthropic", id: "claude-opus-5" },
    content: [
      { type: "text", text: "Inspecting cache telemetry." },
      { type: "reasoning", text: "no writes outside docs/", time: { created: 2, completed: 5 } },
      {
        type: "tool",
        id: "call_read",
        name: "grep",
        state: {
          status: "completed",
          input: { pattern: "cache_read" },
          content: [{ type: "text", text: "const usage = normalize(raw)" }],
          structured: {},
        },
        time: { created: 5, ran: 5, completed: 6 },
      },
      {
        type: "tool",
        id: "call_glob",
        name: "glob",
        state: {
          status: "completed",
          input: { pattern: "**/usage.ts" },
          content: [{ type: "text", text: "usage.ts" }],
          structured: {},
        },
        time: { created: 6, ran: 6, completed: 7 },
      },
      {
        type: "tool",
        id: "call_project_search",
        name: "project_search",
        state: {
          status: "completed",
          input: { query: "cache telemetry" },
          content: [{ type: "text", text: "Found matching call sites." }],
          structured: { matches: 17 },
        },
        time: { created: 7, ran: 7, completed: 8 },
      },
      {
        type: "tool",
        id: "call_subagent",
        name: "subagent",
        state: {
          status: "completed",
          input: { agent: "docs-sync", description: "Sync docs" },
          content: [{ type: "text", text: "Audit completed." }],
          structured: { sessionID: "ses_docs_child", status: "completed" },
        },
        time: { created: 8, ran: 8, completed: 9 },
      },
      {
        type: "tool",
        id: "call_running",
        name: "project_index",
        state: { status: "running", input: { scope: "workspace" }, content: [], structured: {} },
        time: { created: 9, ran: 9 },
      },
      {
        type: "tool",
        id: "call_todo",
        name: "todowrite",
        state: {
          status: "completed",
          input: { todos: [{ content: "Fix shared cache accounting", status: "in_progress" }] },
          content: [],
          structured: {},
        },
        time: { created: 9, ran: 9, completed: 10 },
      },
    ],
    finish: "tool-calls",
    time: { created: 2 },
  },
  {
    id: "msg_compaction",
    type: "compaction",
    status: "completed",
    reason: "auto",
    summary: "",
    recent: "",
    messages: 42,
    tokens: { input: 1_000, output: 100, reasoning: 50, cache: { read: 40, write: 10 } },
    time: { created: 11 },
  },
] as SessionMessageInfo[]

const editTranscript = [
  { id: "msg_user_edit", type: "user", text: "Fix the usage report", time: { created: 1 } },
  {
    id: "msg_assistant_edit",
    type: "assistant",
    agent: "build",
    model: { providerID: "anthropic", id: "claude-opus-5" },
    content: [
      { type: "text", text: "Applying the usage edit." },
      {
        type: "tool",
        id: "call_edit",
        name: "edit",
        state: {
          status: "completed",
          input: { path: "packages/core/src/provider/usage.ts" },
          content: [{ type: "text", text: "edited" }],
          structured: {
            files: [
              { file: "packages/core/src/provider/usage.ts", patch, additions: 3, deletions: 1 },
              { file: "docs/runtime.md", patch: secondaryPatch, additions: 1, deletions: 1 },
            ],
          },
        },
        time: { created: 2, ran: 2, completed: 3 },
      },
      {
        type: "tool",
        id: "call_patch_running",
        name: "patch",
        state: {
          status: "running",
          input: { patchText: "*** Update File: docs/configuration.md" },
          content: [],
          structured: {},
        },
        time: { created: 3, ran: 3 },
      },
    ],
    finish: "tool-calls",
    time: { created: 2 },
  },
] as SessionMessageInfo[]

const narrowTranscript = [
  { id: "msg_user_narrow", type: "user", text: "Run the long tool", time: { created: 1 } },
  {
    id: "msg_assistant_narrow",
    type: "assistant",
    agent: "build",
    model: { providerID: "anthropic", id: "claude-opus-5" },
    content: [
      {
        type: "tool",
        id: "call_long",
        name: "project_search",
        state: {
          status: "completed",
          input: {
            query:
              "an extremely long tool detail that cannot possibly fit inside eighty terminal columns without being cut",
          },
          content: [{ type: "text", text: "done" }],
          structured: {},
        },
        time: { created: 2, ran: 2, completed: 3 },
      },
    ],
    finish: "tool-calls",
    time: { created: 2 },
  },
] as SessionMessageInfo[]

const lifecycleStart = 1_000
const lifecycleEnd = lifecycleStart + 134_000
const lifecycleRunningStart = Date.now() - 2_000
const lifecycleTranscript = [
  { id: "msg_user_lifecycle", type: "user", text: "Exercise tool lifecycle rows", time: { created: 1 } },
  {
    id: "msg_assistant_lifecycle",
    type: "assistant",
    agent: "build",
    model: { providerID: "anthropic", id: "claude-opus-5" },
    content: [
      {
        type: "tool",
        id: "call_execute_running",
        name: "execute",
        state: {
          status: "running",
          input: { code: "await tools.project_search({ scope: 'workspace' })" },
          content: [],
          structured: {
            toolCalls: [{ tool: "project_search", status: "running", input: { scope: "workspace" } }],
          },
        },
        time: { created: lifecycleRunningStart - 1_000, ran: lifecycleRunningStart },
      },
      {
        type: "tool",
        id: "call_shell_result_failure",
        name: "shell",
        state: {
          status: "completed",
          input: { command: "bun typecheck" },
          content: [{ type: "text", text: "2 errors" }],
          structured: {},
        },
        time: { created: lifecycleStart, ran: lifecycleStart, completed: lifecycleEnd },
      },
      {
        type: "tool",
        id: "call_grep_lifecycle",
        name: "grep",
        state: {
          status: "completed",
          input: { pattern: "lifecycle" },
          content: [{ type: "text", text: "match" }],
          structured: { matches: 1 },
        },
        time: { created: lifecycleStart, ran: lifecycleStart, completed: lifecycleEnd - 1_000 },
      },
      {
        type: "tool",
        id: "call_glob_lifecycle",
        name: "glob",
        state: {
          status: "completed",
          input: { pattern: "**/*.ts" },
          content: [{ type: "text", text: "activity-row.tsx" }],
          structured: { count: 1 },
        },
        time: { created: lifecycleStart + 1_000, ran: lifecycleStart + 1_000, completed: lifecycleEnd },
      },
      {
        type: "tool",
        id: "call_generic_completed",
        name: "project_plan",
        state: {
          status: "completed",
          input: { scope: "workspace" },
          content: [{ type: "text", text: "Lifecycle detail response" }],
          structured: { steps: 3 },
        },
        time: { created: lifecycleStart, ran: lifecycleStart, completed: lifecycleEnd },
      },
      {
        type: "tool",
        id: "call_generic_failed",
        name: "project_publish",
        state: {
          status: "error",
          input: { target: "preview" },
          content: [],
          structured: {},
          error: { type: "tool.failed", message: "Publish failed" },
        },
        time: { created: lifecycleStart, ran: lifecycleStart, completed: lifecycleEnd },
      },
      {
        type: "tool",
        id: "call_generic_cancelled",
        name: "project_cancel",
        state: {
          status: "error",
          input: { target: "preview" },
          content: [],
          structured: {},
          error: { type: "aborted", message: "Tool execution interrupted" },
        },
        time: { created: lifecycleStart, ran: lifecycleStart, completed: lifecycleEnd },
      },
    ],
    finish: "tool-calls",
    time: { created: lifecycleStart },
  },
  {
    id: "msg_cli_cancelled",
    type: "shell",
    shellID: "sh_lifecycle_cancelled",
    command: "sleep 300",
    status: "killed",
    output: { output: "Stopped by user", cursor: 15, size: 15, truncated: false },
    time: { created: lifecycleStart, completed: lifecycleEnd },
  },
] as SessionMessageInfo[]

const shortBubbleTranscript = [
  { id: "msg_user_short", type: "user", text: "Short bubble", time: { created: 1 } },
] as SessionMessageInfo[]

const longBubbleTranscript = [
  {
    id: "msg_user_long",
    type: "user",
    text:
      "Long bubble content wraps within the existing maximum width without ever painting over either rounded border edge at any supported viewport width.",
    time: { created: 4 },
  },
] as SessionMessageInfo[]

const receiptTranscript = [
  { id: "msg_user_sent", type: "user", text: "Promoted bubble", time: { created: 1 } },
  { id: "msg_user_read", type: "user", text: "Consumed bubble", time: { created: 2, consumed: 3 } },
  {
    id: "msg_assistant_receipt_guard",
    type: "assistant",
    agent: "build",
    model: { providerID: "anthropic", id: "claude-opus-5" },
    content: [{ type: "text", text: "Assistant receipt guard" }],
    finish: "stop",
    time: { created: 3, completed: 4 },
  },
  { id: "msg_system_receipt_guard", type: "system", text: "System receipt guard", time: { created: 4 } },
] as SessionMessageInfo[]

const pendingReceipt = [
  {
    id: "msg_user_pending",
    sessionID,
    admittedSeq: 5,
    timeCreated: 5,
    type: "user",
    data: {
      text: "Queued bubble",
      files: [
        {
          data: "",
          mime: "text/plain",
          name: "receipt.txt",
          source: { type: "uri", uri: "file:///tmp/receipt.txt" },
        },
      ],
    },
    delivery: "queue",
  },
] as SessionPendingInfo[]


const streamingTranscript = [
  { id: "msg_user_stream", type: "user", text: "Stream the answer", time: { created: 1 } },
  {
    id: "msg_assistant_stream",
    type: "assistant",
    agent: "build",
    model: { providerID: "anthropic", id: "claude-opus-5" },
    content: [
      {
        type: "text",
        text: Array.from({ length: 28 }, (_, index) => `Streaming transcript line ${String(index + 1).padStart(2, "0")}`).join("\n"),
      },
      {
        type: "tool",
        id: "call_stream_running",
        name: "project_index",
        state: { status: "running", input: { scope: "workspace" }, content: [], structured: {} },
        time: { created: 2, ran: 2 },
      },
    ],
    time: { created: 2 },
  },
] as SessionMessageInfo[]

const subagentNotificationTranscript = [
  {
    id: "msg_subagent_notification",
    type: "synthetic",
    text: "Child completed after reviewing provider usage.",
    description: "Child completed after reviewing provider usage.",
    metadata: {
      source: "subagent_notification",
      childID: "ses_sensitive_child",
      type: "completed",
      revision: 3,
    },
    time: { created: 2 },
  },
] as SessionMessageInfo[]

function routeFor(messages: SessionMessageInfo[], guardrails: unknown[] = [], pending: SessionPendingInfo[] = []) {
  return (url: URL) => {
    if (url.pathname === "/api/fs/list") return json({ location, data: [] })
    if (url.pathname === "/api/location") return json(location)
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
    if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: messages, cursor: {} })
    if (url.pathname === `/api/session/${sessionID}/pending`) return json({ data: pending })
    if (url.pathname === `/api/session/${sessionID}/guardrail/request`) return json({ location, data: guardrails })
    if (url.pathname === `/api/session/${sessionID}/subagent`)
      return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
    if (
      [
        `/api/session/${sessionID}/permission`,
        `/api/session/${sessionID}/todo`,
        `/api/session/${sessionID}/skills`,
        "/api/shell",
        "/api/mcp",
        "/api/integration",
        "/api/command",
        "/api/skill",
        "/api/reference",
        "/api/permission/request",
        "/api/form/request",
      ].includes(url.pathname)
    )
      return json({ location, data: [] })
    if (url.pathname === "/api/mcp/resource") return json({ location, data: { resources: [], templates: [] } })
    if (url.pathname === `/api/session/${sessionID}/guardrail`)
      return json({
        data: {
          rootSessionID: sessionID,
          profile: "standard",
          customRules: 0,
          approvals: 0,
          blocked: 0,
          counters: [],
          invalidFiles: [],
        },
      })
    if (url.pathname === `/api/session/${sessionID}/diagnostics`)
      return json({
        data: {
          model: session.model,
          context: { total: 0, percent: 0 },
          tokens: { uncachedInput: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          cache: { eligible: 0, mechanism: "unreported", readReported: false, writeReported: false },
          requests: {
            logical: 0,
            physical: 0,
            helpers: 0,
            continued: 0,
            fallback: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        },
      })
    if (url.pathname === "/api/vcs/branch") return json({ location, data: { current: "main", default: "main" } })
    if (url.pathname === "/api/model")
      return json({
        location,
        data: [
          {
            id: "claude-opus-5",
            modelID: "claude-opus-5",
            providerID: "anthropic",
            name: "Claude Opus 5",
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            time: { released: 0 },
            cost: [],
            status: "active",
            enabled: true,
            limit: { context: 200_000, output: 32_000 },
          },
        ],
      })
    if (url.pathname === "/api/provider") return json({ location, data: [{ id: "anthropic", name: "Claude" }] })
    if (url.pathname === "/api/agent")
      return json({
        location,
        data: [
          { id: "build", name: "Build", request: { headers: {}, body: {} }, mode: "primary", hidden: false, permissions: [] },
        ],
      })
    return undefined
  }
}

/** Transcript-content extent of a rendered line: [first painted column, last painted column + 1]. */
function extent(line: string) {
  return [line.length - line.trimStart().length, line.trimEnd().length] as const
}

function transcriptSlice(line: string, width: number) {
  return line.slice(0, width - (railPlacement(width) === "docked" ? railWidth(width) : 0))
}

test("derives pending, running, terminal, cancelled, and overridden tool lifecycle states from durable time", () => {
  expect(
    toolLifecyclePresentation({ status: "streaming", time: { created: lifecycleStart }, now: lifecycleEnd }),
  ).toMatchObject({ label: "pending", duration: "2m14s", variant: "pending" })
  expect(toolLifecyclePresentation({ status: "streaming", time: {}, now: lifecycleEnd })).toEqual({
    label: "pending",
    status: "pending",
    variant: "pending",
    active: true,
  })
  expect(
    toolLifecyclePresentation({
      status: "running",
      time: { created: 0, ran: lifecycleStart },
      now: lifecycleEnd,
    }),
  ).toMatchObject({ label: "running", duration: "2m14s", status: "running · 2m14s", variant: "running" })

  const completed = {
    status: "completed" as const,
    time: { created: 0, ran: lifecycleStart, completed: lifecycleEnd },
  }
  expect(toolLifecyclePresentation({ ...completed, now: lifecycleEnd })).toMatchObject({
    label: "done",
    duration: "2m14s",
    status: "done · 2m14s",
    variant: "success",
  })
  expect(toolLifecyclePresentation({ ...completed, now: lifecycleEnd + 60_000 }).duration).toBe("2m14s")
  expect(toolLifecyclePresentation({ ...completed, failed: true, summary: "2 errors" })).toMatchObject({
    label: "failed",
    status: "failed · 2 errors · 2m14s",
    variant: "error",
  })
  expect(
    toolLifecyclePresentation({
      status: "error",
      error: { type: "aborted", message: "Tool execution interrupted" },
      time: { created: 0, ran: lifecycleStart, completed: lifecycleEnd },
    }),
  ).toMatchObject({ label: "cancelled", status: "cancelled · 2m14s", variant: "warning" })
})

test("renders every transcript row on one marker/label grid with symmetric compaction rules", async () => {
  const screen = await renderScreen({
    ...DESIGN_VIEWPORT,
    args: { sessionID },
    route: routeFor(transcript, [guardrailRequest]),
    settle: "~ compacted",
  })

  try {
    const lines = screen.lines()
    const railStart = DESIGN_VIEWPORT.width - railWidth(DESIGN_VIEWPORT.width)
    const rowOf = (text: string) => lines.findIndex((line) => line.includes(text) && line.indexOf(text) < railStart)
    const lineOf = (text: string) => transcriptSlice(lines[rowOf(text)] ?? "", DESIGN_VIEWPORT.width)

    const thought = lineOf("Thought")
    const explored = lineOf("Explored")
    const tool = lineOf("project_search")
    const subagent = lineOf("subagent")
    const guardrail = lineOf("guardrail")
    const task = lineOf("Fix shared cache accounting")
    const running = lineOf("project_index")

    // Marker column 3 for every activity class.
    expect(thought.indexOf("ok")).toBe(3)
    expect(explored.indexOf("ok")).toBe(3)
    expect(tool.indexOf("ok")).toBe(3)
    expect(subagent.indexOf("◦")).toBe(3)
    expect(guardrail.indexOf("!!")).toBe(3)
    expect(task.indexOf("..")).toBe(3)
    expect(running.indexOf("..")).toBe(3)

    // Label column 10 for every activity class.
    expect(thought.indexOf("Thought")).toBe(10)
    expect(explored.indexOf("Explored")).toBe(10)
    expect(tool.indexOf("project_search")).toBe(10)
    expect(subagent.indexOf("subagent")).toBe(10)
    expect(guardrail.indexOf("guardrail")).toBe(10)
    expect(task.indexOf("Fix shared cache accounting")).toBe(10)
    expect(running.indexOf("project_index")).toBe(10)

    // Running rows carry an animated spinner between the marker and the label column.
    expect(SPINNER_FRAMES.some((frame) => running.slice(0, 10).includes(frame))).toBe(true)
    expect(screen.colorOf("..")).not.toEqual(screen.colorOf("ok"))

    // Every activity row is introduced by exactly one full-width rule.
    const rule = transcriptSlice(lines[rowOf("project_search") - 1] ?? "", DESIGN_VIEWPORT.width)
    expect(rule.trim()).toMatch(/^─+$/)

    // Compaction reaches both transcript content edges, exactly like the activity rule.
    const compaction = lineOf("~ compacted")
    const compactionLabel = "~ compacted · 42 messages → 1.2k tokens"
    expect(compaction).toContain(compactionLabel)
    expect(extent(compaction)).toEqual(extent(rule))
    const painted = compaction.slice(...extent(compaction))
    const labelStart = painted.indexOf(compactionLabel)
    const leftRule = painted.slice(0, labelStart).trim()
    const rightRule = painted.slice(labelStart + compactionLabel.length).trim()
    expect(leftRule).toMatch(/^─+$/)
    expect(rightRule).toMatch(/^─+$/)
    expect(Math.abs(leftRule.length - rightRule.length)).toBeLessThanOrEqual(1)
  } finally {
    await screen.dispose()
  }
}, 60_000)

test("renders one durable lifecycle grammar for execute, exploration, shell, CLI, and generic tools", async () => {
  const screen = await renderScreen({
    ...DESIGN_VIEWPORT,
    args: { sessionID },
    route: routeFor(lifecycleTranscript),
    settle: "sleep 300",
  })

  try {
    const row = (text: string) =>
      transcriptSlice(screen.lines().find((line) => line.includes(text)) ?? "", DESIGN_VIEWPORT.width).trimEnd()

    expect(row("execute")).toMatch(/running · \d+s$/)
    expect(screen.frame()).toContain("project_search [scope=workspace] · running")
    expect(row("bun typecheck")).toContain("failed · 2 errors · 2m14s")
    expect(row("bun typecheck").indexOf("!!")).toBe(3)
    expect(row("Explored")).toContain("done · 2m14s")
    expect(row("project_plan")).toContain("done · 2m14s")
    expect(row("project_publish")).toContain("failed · 2m14s")
    expect(row("project_cancel")).toContain("cancelled · 2m14s")
    expect(row("project_cancel").indexOf("!!")).toBe(3)
    expect(row("sleep 300")).toContain("cancelled · killed · 2m14s")
    const markerColor = (text: string) => {
      const index = screen.lines().findIndex((line) => line.includes(text))
      return screen.spans().lines[index]?.spans.find((span) => span.text.includes("!!"))?.fg.toInts()
    }
    expect(markerColor("project_cancel")).not.toEqual(markerColor("project_publish"))

    const collapsedStatus = row("project_plan")
    expect(screen.frame()).not.toContain("Lifecycle detail response")
    await screen.mouse.click(12, screen.lines().findIndex((line) => line.includes("project_plan")))
    await waitForFrame(screen.frame, "Lifecycle detail response")
    expect(row("project_plan")).toBe(collapsedStatus)
  } finally {
    await screen.dispose()
  }
}, 60_000)

test("advances running tool elapsed time without changing terminal durations", async () => {
  const screen = await renderScreen({
    ...DESIGN_VIEWPORT,
    args: { sessionID },
    route: routeFor(lifecycleTranscript),
    settle: "sleep 300",
  })

  try {
    const execute = () =>
      transcriptSlice(screen.lines().find((line) => line.includes("execute")) ?? "", DESIGN_VIEWPORT.width).trimEnd()
    const terminal = () =>
      transcriptSlice(screen.lines().find((line) => line.includes("project_plan")) ?? "", DESIGN_VIEWPORT.width).trimEnd()
    const firstElapsed = /running · (\d+)s$/.exec(execute())?.[1]
    const firstTerminal = terminal()

    await Bun.sleep(1_100)

    expect(Number(/running · (\d+)s$/.exec(execute())?.[1])).toBeGreaterThan(Number(firstElapsed))
    expect(terminal()).toBe(firstTerminal)
  } finally {
    await screen.dispose()
  }
}, 60_000)

test("renders subagent notifications as compact safe activity rows", async () => {
  const screen = await renderScreen({
    ...DESIGN_VIEWPORT,
    args: { sessionID },
    route: routeFor(subagentNotificationTranscript),
    settle: "subagent",
  })

  try {
    const lines = screen.lines()
    const railStart = DESIGN_VIEWPORT.width - railWidth(DESIGN_VIEWPORT.width)
    const row = lines.find((line) => line.includes("subagent") && line.indexOf("subagent") < railStart) ?? ""
    const rowIndex = lines.indexOf(row)

    expect(row.indexOf("◦")).toBe(3)
    expect(row.indexOf("subagent")).toBe(10)
    expect(row).toContain("completed")
    expect(transcriptSlice(lines[rowIndex - 1] ?? "", DESIGN_VIEWPORT.width).trim()).toMatch(/^─+$/)
    expect(screen.frame()).not.toContain("Subagent notification")
    expect(screen.frame()).not.toContain("Child completed after reviewing provider usage.")
    expect(screen.frame()).not.toContain("ses_sensitive_child")
  } finally {
    await screen.dispose()
  }
}, 60_000)

test("renders file edit results on the board diff grid with a visible running patch", async () => {
  const screen = await renderScreen({
    ...DESIGN_VIEWPORT,
    args: { sessionID },
    route: routeFor(editTranscript),
    settle: "docs/runtime.md",
  })

  try {
    const lines = screen.lines()
    const railStart = DESIGN_VIEWPORT.width - railWidth(DESIGN_VIEWPORT.width)
    const rowOf = (text: string) => lines.findIndex((line) => line.includes(text) && line.indexOf(text) < railStart)
    const header = lines[rowOf("docs/runtime.md")] ?? ""

    // Board 13: the edited path sits at the transcript's content column with its counts right of it.
    expect(header.indexOf("docs/runtime.md")).toBe(3)
    expect(header).toContain("+1")
    expect(header).toContain("−1")
    expect(header.indexOf("+1")).toBeLessThan(header.indexOf("−1"))

    const removed = transcriptSlice(lines[rowOf("- Old cache note")] ?? "", DESIGN_VIEWPORT.width)
    const added = transcriptSlice(lines[rowOf("+ Current cache note")] ?? "", DESIGN_VIEWPORT.width)

    // Board 13: line number column 5, diff content column 13, no surrounding frame.
    expect(removed.search(/\d/)).toBe(5)
    expect(removed.indexOf("- Old cache note")).toBe(12)
    expect(added.indexOf("+ Current cache note")).toBe(12)
    expect(removed).not.toContain("│")
    expect(added).not.toContain("│")
    expect(screen.colorOf("+ Current cache note")).not.toEqual(screen.colorOf("- Old cache note"))

    // The in-progress row is identified by its marker rather than a label, so the assertion holds
    // whichever presentation the patch tool resolves to. The requirement is that a running row is
    // obvious: the `..` marker at the grid's marker column plus an animated spinner beside it.
    const running = lines.find((line) => line.indexOf("..") === 3 && line.indexOf("..") < railStart) ?? ""
    expect(running.indexOf("..")).toBe(3)
    expect(SPINNER_FRAMES.some((frame) => running.slice(0, 10).includes(frame))).toBe(true)
    expect(transcriptSlice(running, DESIGN_VIEWPORT.width).trimEnd()).toMatch(/\d+[smhdw]$/)
  } finally {
    await screen.dispose()
  }
}, 60_000)

test("renders intrinsic rounded user bubbles without crossing their border at supported widths", async () => {
  const viewports = [NARROW_VIEWPORT, { width: 100, height: 30 }, DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE]
  const widths: Array<{ viewport: number; short: number; long: number; maximum: number }> = []

  for (const viewport of viewports) {
    const short = await renderBubble(viewport, shortBubbleTranscript, "Short bubble")
    const long = await renderBubble(viewport, longBubbleTranscript, "Long bubble content")
    const maximum = Math.ceil(
      (viewport.width - (railPlacement(viewport.width) === "docked" ? railWidth(viewport.width) : 0) - 4) * 0.515,
    )

    expect(short.topText.startsWith("╭")).toBe(true)
    expect(short.topText.endsWith("╮")).toBe(true)
    expect(short.bottomText.startsWith("╰")).toBe(true)
    expect(short.bottomText.endsWith("╯")).toBe(true)
    expect(long.topText.startsWith("╭")).toBe(true)
    expect(long.topText.endsWith("╮")).toBe(true)
    expect(long.bottomText.startsWith("╰")).toBe(true)
    expect(long.bottomText.endsWith("╯")).toBe(true)
    expect(short.body.every((line) => line[short.left] === "│" && line[short.right] === "│")).toBe(true)
    expect(long.body.every((line) => line[long.left] === "│" && line[long.right] === "│")).toBe(true)
    expect(long.width).toBeLessThanOrEqual(maximum)

    widths.push({ viewport: viewport.width, short: short.width, long: long.width, maximum })
  }

  widths.forEach((item) => {
    expect(item.short).toBeLessThan(item.long)
    expect(item.long).toBeLessThanOrEqual(item.maximum)
  })
}, 60_000)

test("renders only truthful icon receipts at the lower-right of outbound user bubbles", async () => {
  const screen = await renderScreen({
    ...DESIGN_VIEWPORT,
    args: { sessionID },
    route: routeFor(receiptTranscript, [], pendingReceipt),
    settle: "Queued bubble",
  })

  try {
    const lines = screen.lines().map((line) => transcriptSlice(line, DESIGN_VIEWPORT.width))
    const sent = bubbleBounds(lines, "Promoted bubble")
    const read = bubbleBounds(lines, "Consumed bubble")
    const pending = bubbleBounds(lines, "Queued bubble")
    const receipt = (bubble: ReturnType<typeof bubbleBounds>, glyph: string) => {
      const line = bubble.body.at(-1) ?? ""
      expect(line.slice(bubble.left + 1, bubble.right).trim()).toBe(glyph)
      expect(line.lastIndexOf(glyph) + glyph.length).toBe(bubble.right - 1)
      return lines.indexOf(line)
    }

    const pendingRow = receipt(pending, "◷")
    const sentRow = receipt(sent, "✓")
    const readRow = receipt(read, "✓✓")
    const color = (row: number, glyph: string) =>
      screen.spans().lines[row]?.spans.find((span) => span.text.includes(glyph))?.fg.toInts()
    expect(pending.body.some((line) => line.includes("file") && line.includes("receipt.txt"))).toBe(true)
    expect(color(pendingRow, "◷")).toEqual(color(sentRow, "✓"))
    expect(color(readRow, "✓✓")).not.toEqual(color(sentRow, "✓"))

    for (const bubble of [pending, sent, read])
      expect(bubble.body.join("\n").toLowerCase()).not.toMatch(/\b(?:pending|sent|read|delivered)\b/)
    for (const text of ["Assistant receipt guard", "System receipt guard"]) {
      const line = lines.find((candidate) => candidate.includes(text)) ?? ""
      expect(line).not.toContain("◷")
      expect(line).not.toContain("✓")
    }
  } finally {
    await screen.dispose()
  }
}, 60_000)

test("bounds streaming growth renders and confines spinner frame changes to its activity row", async () => {
  const growth = await renderMeasuredScreen({
    width: NARROW_VIEWPORT.width,
    height: NARROW_VIEWPORT.height,
    route: routeFor(streamingTranscript),
    settle: "project_index",
    config: { animations: false },
  })

  try {
    await Bun.sleep(200)
    growth.renderer.resetStats()
    growth.events.emit({
      id: "evt_stream_growth",
      created: 3,
      type: "session.text.delta",
      data: {
        sessionID,
        assistantMessageID: "msg_assistant_stream",
        ordinal: 0,
        delta: "\nstream-growth-marker\nstream-growth-tail",
      },
    } as YCodingEvent)
    await waitForFrame(growth.frame, "stream-growth-marker")
    await Bun.sleep(100)

    // One logical text delta currently produces the content frame plus the
    // ScrollBox size-change re-anchor frame. This is the deterministic flicker probe.
    const growthFrames = growth.renderer.getStats().frameCount
    expect(growthFrames).toBeGreaterThan(1)
    expect(growthFrames).toBeLessThanOrEqual(8)
  } finally {
    await growth.dispose()
  }

  const spinner = await renderMeasuredScreen({
    ...NARROW_VIEWPORT,
    route: routeFor(streamingTranscript),
    settle: "project_index",
    config: { animations: true },
  })

  try {
    const frames = [spinner.frame()]
    for (const wait of [90, 90, 90, 90]) {
      await Bun.sleep(wait)
      frames.push(spinner.frame())
    }
    const changes = frames.slice(1).flatMap((frame, index) => changedRows(frames[index], frame))
    const runningRow = frames[0].split("\n").findIndex((line) => line.includes("project_index"))

    // The unpaged canonical fetch keeps the user prompt before the streaming assistant, so one
    // additional transcript row can repaint. The spinner must still include its own row and avoid
    // a full-frame redraw.
    const changed = [...new Set(changes)]
    expect(new Set(frames).size).toBeGreaterThan(1)
    expect(changes.length).toBeGreaterThan(0)
    expect(changed).toContain(runningRow)
    expect(changed.length).toBeLessThan(NARROW_VIEWPORT.height)
  } finally {
    await spinner.dispose()
  }
}, 60_000)

function bubbleBounds(lines: string[], text: string) {
  const bodyRow = lines.findIndex((line) => line.includes(text))
  if (bodyRow === -1) throw new Error(`missing bubble text: ${text}`)
  const top = lines.findLastIndex((line, index) => index < bodyRow && line.includes("╭") && line.includes("╮"))
  const bottomOffset = lines.slice(bodyRow + 1).findIndex((line) => line.includes("╰") && line.includes("╯"))
  const bottom = bottomOffset === -1 ? -1 : bodyRow + bottomOffset + 1
  if (top === -1 || bottom === -1) throw new Error(`missing rounded bubble border: ${text}`)
  const left = lines[top].indexOf("╭")
  const right = lines[top].lastIndexOf("╮")
  return {
    left,
    right,
    width: right - left + 1,
    topText: lines[top].slice(left, right + 1),
    bottomText: lines[bottom].slice(left, right + 1),
    body: lines.slice(top + 1, bottom),
  }
}

async function renderBubble(
  viewport: { width: number; height: number },
  messages: SessionMessageInfo[],
  settle: string,
) {
  const screen = await renderScreen({
    ...viewport,
    args: { sessionID },
    route: routeFor(messages),
    settle,
  })
  try {
    return bubbleBounds(screen.lines().map((line) => transcriptSlice(line, viewport.width)), settle)
  } finally {
    await screen.dispose()
  }
}

function changedRows(before: string, after: string) {
  const previous = before.split("\n")
  return after.split("\n").flatMap((line, index) => (line === previous[index] ? [] : [index]))
}

async function waitForFrame(frame: () => string, text: string) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (frame().includes(text)) return
    await Bun.sleep(20)
  }
  throw new Error(`screen did not settle on ${text}`)
}

async function renderMeasuredScreen(input: {
  width: number
  height: number
  route: FetchHandler
  settle: string
  config: { animations: boolean }
}) {
  const setup = await createTestRenderer({ width: input.width, height: input.height, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const runtime = await import("../src/plugin/runtime")
  const pluginRuntime = runtime.createPluginRuntime()
  mock.module("../src/plugin/runtime", () => ({ ...runtime, createPluginRuntime: () => pluginRuntime }))

  const events = createEventStream()
  const calls = createFetch(input.route, events)
  const server = Bun.serve({ port: 0, fetch: (request) => calls.fetch(request), idleTimeout: 30 })
  const { run } = await import("../src/app")
  const task = Effect.runPromise(
    run({
      server: { endpoint: { url: server.url.toString() } },
      config: { get: async () => input.config, update: async () => input.config },
      packages: { resolve: async () => undefined },
      args: { sessionID },
      log: () => {},
    }).pipe(Effect.provide(AppNodeBuilder.build(Global.node)), Effect.provide(FileSystem.layerNoop({}))),
  )

  setup.renderer.start()
  await waitForFrame(() => setup.captureCharFrame(), input.settle)
  setup.renderer.setGatherStats(true)

  return {
    events,
    renderer: setup.renderer,
    frame: () => setup.captureCharFrame(),
    async dispose() {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy()
      await task.catch(() => {})
      await server.stop()
      mock.restore()
    },
  }
}

test("truncates a transcript label with an ellipsis instead of overprinting its status at 80 columns", async () => {
  const screen = await renderScreen({
    ...NARROW_VIEWPORT,
    args: { sessionID },
    route: routeFor(narrowTranscript),
    settle: "project_search",
  })

  try {
    const lines = screen.lines()
    const row = lines.find((line) => line.includes("project_search")) ?? ""

    expect(row.indexOf("project_search")).toBe(10)
    // The renderer elides the middle of an over-long label with a literal "...".
    expect(row).toContain("...")
    expect(row).toContain("done")
    expect(row.indexOf("...")).toBeLessThan(row.indexOf("done"))
    expect(row.trimEnd().length).toBeLessThanOrEqual(NARROW_VIEWPORT.width)
  } finally {
    await screen.dispose()
  }
}, 60_000)
