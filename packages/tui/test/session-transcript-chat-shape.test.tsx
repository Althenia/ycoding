/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@ycoding-ai/client"
import { railPlacement, railWidth } from "../src/routes/session/rail"
import { json } from "./fixture/tui-client"
import { DESIGN_VIEWPORT } from "./viewport"
import { renderScreen } from "./screen/harness"

const sessionID = "ses_chat_shape"
const directory = "/tmp/ycoding/session-chat-shape"
const location = { directory, project: { id: "proj_chat_shape", directory } }
const model = { providerID: "anthropic", id: "claude-opus-5" }
const session = {
  id: sessionID,
  title: "Chat shape",
  projectID: "proj_chat_shape",
  location: { directory },
  agent: "build",
  model,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 9 },
}

const usagePatch = [
  "--- a/packages/core/src/provider/usage.ts",
  "+++ b/packages/core/src/provider/usage.ts",
  "@@ -42,2 +42,4 @@",
  " const usage = normalize(raw)",
  "-const stale = usage.cached",
  "+const fresh = usage.cacheRead",
  "+const total = usage.input + fresh",
  "+export const report = { total }",
].join("\n")

const runtimePatch = [
  "--- a/docs/runtime.md",
  "+++ b/docs/runtime.md",
  "@@ -8 +8 @@",
  "-Old cache note",
  "+Current cache note",
].join("\n")

const configurationPatch = [
  "--- a/docs/configuration.md",
  "+++ b/docs/configuration.md",
  "@@ -3 +3,2 @@",
  "-Old option",
  "+New option",
  "+Second option",
].join("\n")

/** (a) A normal completed exchange: the assistant answered and the step finished. */
const completedTranscript = [
  { id: "msg_user_completed", type: "user", text: "Summarise the cache work", time: { created: 1 } },
  {
    id: "msg_assistant_completed",
    type: "assistant",
    agent: "build",
    model,
    content: [{ type: "text", text: "Cache accounting is now normalised." }],
    finish: "stop",
    time: { created: 2_000, completed: 4_000 },
  },
] as SessionMessageInfo[]

/** (b) An interrupted turn: the tool aborted and the step carries the interruption. */
const interruptedTranscript = [
  { id: "msg_user_interrupted", type: "user", text: "Start the provider audit", time: { created: 1 } },
  {
    id: "msg_assistant_interrupted",
    type: "assistant",
    agent: "build",
    model,
    content: [
      { type: "text", text: "Starting the provider audit." },
      {
        type: "tool",
        id: "call_interrupted",
        name: "project_audit",
        state: {
          status: "error",
          input: { scope: "providers" },
          content: [],
          structured: {},
          error: { type: "aborted", message: "Tool execution interrupted" },
        },
        time: { created: 2_000, ran: 2_000, completed: 3_000 },
      },
    ],
    error: { type: "aborted", message: "Step interrupted" },
    finish: "error",
    time: { created: 2_000, completed: 3_000 },
  },
] as SessionMessageInfo[]

/** (c) A turn whose last step produced a tool call and no assistant text. */
const toolOnlyTranscript = [
  { id: "msg_user_tool_only", type: "user", text: "Run the provider suite", time: { created: 1 } },
  {
    id: "msg_assistant_tool_only",
    type: "assistant",
    agent: "build",
    model,
    content: [
      {
        type: "tool",
        id: "call_tool_only",
        name: "project_audit",
        state: {
          status: "completed",
          input: { scope: "providers" },
          content: [{ type: "text", text: "Audit finished." }],
          structured: {},
        },
        time: { created: 2_000, ran: 2_000, completed: 3_000 },
      },
    ],
    finish: "tool-calls",
    time: { created: 2_000, completed: 3_000 },
  },
] as SessionMessageInfo[]

const receiptTranscript = [
  { id: "msg_user_receipt", type: "user", text: "Promoted bubble", time: { created: 1 } },
  {
    id: "msg_assistant_receipt",
    type: "assistant",
    agent: "build",
    model,
    content: [{ type: "text", text: "Receipt guard." }],
    finish: "stop",
    time: { created: 2, completed: 3 },
  },
] as SessionMessageInfo[]

const skillTranscript = [
  {
    id: "msg_skill_loaded",
    type: "skill",
    name: "focus-test",
    text: "Named skill details must be hidden",
    time: { created: 1 },
  },
] as SessionMessageInfo[]

const markdownTranscript = [
  { id: "msg_user_markdown", type: "user", text: "Report the cache findings", time: { created: 1 } },
  {
    id: "msg_assistant_markdown",
    type: "assistant",
    agent: "build",
    model,
    content: [
      {
        type: "text",
        text: [
          "# Cache findings",
          "",
          "The **normalised** total is reported by `usage.report`.",
          "The **[Image 1]** placeholder remains Markdown content.",
        ].join("\n"),
      },
    ],
    finish: "stop",
    time: { created: 2, completed: 3 },
  },
] as SessionMessageInfo[]

const restoredInstructionTranscript = [
  {
    id: "msg_restored_instruction",
    type: "system",
    text: ["# Restored instruction", "", "Use **Markdown** for `configuration` notes."].join("\n"),
    time: { created: 1 },
  },
] as SessionMessageInfo[]

const editTranscript = [
  { id: "msg_user_edit", type: "user", text: "Fix the usage report", time: { created: 1 } },
  {
    id: "msg_assistant_edit",
    type: "assistant",
    agent: "build",
    model,
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
              { file: "packages/core/src/provider/usage.ts", patch: usagePatch, additions: 3, deletions: 1 },
              { file: "docs/runtime.md", patch: runtimePatch, additions: 1, deletions: 1 },
              { file: "docs/configuration.md", patch: configurationPatch, additions: 2, deletions: 1 },
            ],
          },
        },
        time: { created: 2, ran: 2, completed: 3 },
      },
    ],
    finish: "stop",
    time: { created: 2, completed: 4 },
  },
] as SessionMessageInfo[]

function routeFor(messages: SessionMessageInfo[]) {
  return (url: URL) => {
    if (url.pathname === "/api/fs/list") return json({ location, data: [] })
    if (url.pathname === "/api/location") return json(location)
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
    if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: messages, cursor: {} })
    if (url.pathname === `/api/session/${sessionID}/pending`) return json({ data: [] })
    if (url.pathname === `/api/session/${sessionID}/guardrail/request`) return json({ location, data: [] })
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
    if (url.pathname === `/api/session/${sessionID}/usage`)
      return json({
        data: {
          logical: 0,
          physical: 0,
          helpers: 0,
          continued: 0,
          fallback: 0,
          cost: 0,
          tokens: session.tokens,
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
          {
            id: "build",
            name: "Build",
            request: { headers: {}, body: {} },
            mode: "primary",
            hidden: false,
            permissions: [],
          },
        ],
      })
    return undefined
  }
}

function transcriptSlice(line: string, width: number) {
  return line.slice(0, width - (railPlacement(width) === "docked" ? railWidth(width) : 0))
}

/** Transcript column band of the design viewport, with the docked rail removed. */
function transcriptLines(lines: string[]) {
  return lines.map((line) => transcriptSlice(line, DESIGN_VIEWPORT.width))
}

/**
 * Last transcript row the user sees above the composer. The composer's own
 * full-width rule starts at column 0, while every transcript rule is indented,
 * so the rule is excluded by its indentation rather than by its glyphs.
 */
function lastTranscriptRow(lines: string[]) {
  const composer = lines.findIndex((line) => line.includes("Message YCoding"))
  const rows = transcriptLines(lines.slice(0, composer === -1 ? lines.length : composer))
  return rows.findLast((line) => line.trim().length > 0 && !line.startsWith("─")) ?? ""
}

function bubbleBounds(lines: string[], text: string) {
  const bodyRow = lines.findIndex((line) => line.includes(text))
  if (bodyRow === -1) throw new Error(`missing bubble text: ${text}`)
  const top = lines.findLastIndex((line, index) => index < bodyRow && line.includes("╭") && line.includes("╮"))
  const bottomOffset = lines.slice(bodyRow + 1).findIndex((line) => line.includes("╰") && line.includes("╯"))
  const bottom = bottomOffset === -1 ? -1 : bodyRow + bottomOffset + 1
  if (top === -1 || bottom === -1) throw new Error(`missing rounded bubble border: ${text}`)
  return {
    top,
    bottom,
    left: lines[top].indexOf("╭"),
    right: lines[top].lastIndexOf("╮"),
    body: lines.slice(top + 1, bottom),
  }
}

async function transcriptScreen(messages: SessionMessageInfo[], settle: string) {
  return renderScreen({ ...DESIGN_VIEWPORT, args: { sessionID }, route: routeFor(messages), settle })
}

test("renders the delivery receipt below the user bubble", async () => {
  const screen = await transcriptScreen(receiptTranscript, "Promoted bubble")

  try {
    const lines = transcriptLines(screen.lines())
    const bubble = bubbleBounds(lines, "Promoted bubble")

    const receipt = lines[bubble.bottom + 1] ?? ""
    expect(receipt).toContain("✓")
    expect(bubble.body.join("\n")).not.toContain("✓")
  } finally {
    await screen.dispose()
  }
}, 60_000)

test("keeps a loaded skill row without rendering its following content", async () => {
  const screen = await transcriptScreen(skillTranscript, 'Skill "focus-test"')

  try {
    expect(screen.frame()).toContain('Skill "focus-test"')
    expect(screen.frame()).not.toContain("Skill content")
    expect(screen.frame()).not.toContain("Named skill details must be hidden")
  } finally {
    await screen.dispose()
  }
}, 60_000)

test("ends a completed idle exchange with the assistant block", async () => {
  const screen = await transcriptScreen(completedTranscript, "Cache accounting is now normalised.")

  try {
    // The model label resolves to its catalogue name only once /api/model has loaded, so the
    // assertion pins the assistant footer's shape rather than that race.
    expect(lastTranscriptRow(screen.lines()).trim()).toMatch(/^Build · .+ · 2s$/)
  } finally {
    await screen.dispose()
  }
}, 60_000)

test("ends an interrupted idle turn with the assistant block", async () => {
  const screen = await transcriptScreen(interruptedTranscript, "Starting the provider audit.")

  try {
    expect(lastTranscriptRow(screen.lines()).trim()).toMatch(/^Build · .+ · 1s · interrupted$/)
  } finally {
    await screen.dispose()
  }
}, 60_000)

test("ends an idle tool-only turn with the assistant block rather than a dangling tool row", async () => {
  const screen = await transcriptScreen(toolOnlyTranscript, "project_audit")

  try {
    const last = lastTranscriptRow(screen.lines())
    expect(last).not.toContain("project_audit")
    expect(last.trim()).toMatch(/^Build · .+ · 1s$/)
  } finally {
    await screen.dispose()
  }
}, 60_000)

test("renders assistant chat text only through the markdown path", async () => {
  const screen = await transcriptScreen(markdownTranscript, "Cache findings")

  try {
    const lines = transcriptLines(screen.lines())
    const heading = lines.find((line) => line.includes("Cache findings")) ?? ""
    const body = lines.find((line) => line.includes("normalised")) ?? ""
    const image = lines.find((line) => line.includes("[Image 1]")) ?? ""

    // Rendered markdown conceals its own syntax, and no second plain-text copy is painted.
    expect(heading).not.toContain("#")
    expect(body).not.toContain("**")
    expect(body).not.toContain("`")
    expect(image).not.toContain("**")
    expect(lines.filter((line) => line.includes("Cache findings"))).toHaveLength(1)
    expect(lines.filter((line) => line.includes("normalised"))).toHaveLength(1)
    expect(lines.filter((line) => line.includes("[Image 1]"))).toHaveLength(1)
  } finally {
    await screen.dispose()
  }
}, 60_000)

test("renders restored instruction notices through the markdown path", async () => {
  const screen = await transcriptScreen(restoredInstructionTranscript, "Restored instruction")

  try {
    const lines = transcriptLines(screen.lines())
    const heading = lines.find((line) => line.includes("Restored instruction")) ?? ""
    const body = lines.find((line) => line.includes("Markdown")) ?? ""

    expect(heading).not.toContain("#")
    expect(body).not.toContain("**")
    expect(body).not.toContain("`")
  } finally {
    await screen.dispose()
  }
}, 60_000)

test("collapses file edit results into a summary block that expands to the diff view", async () => {
  const screen = await transcriptScreen(editTranscript, "docs/runtime.md")

  try {
    const lines = transcriptLines(screen.lines())
    const header = lines.find((line) => line.includes("Edited 3 files")) ?? ""
    expect(header.indexOf("Edited 3 files")).toBe(10)

    for (const [path, additions, deletions] of [
      ["packages/core/src/provider/usage.ts", "+3", "−1"],
      ["docs/runtime.md", "+1", "−1"],
      ["docs/configuration.md", "+2", "−1"],
    ] as const) {
      const row = lines.find((line) => line.includes(path)) ?? ""
      expect(row).toContain(additions)
      expect(row).toContain(deletions)
      expect(row.indexOf(additions)).toBeLessThan(row.indexOf(deletions))
    }

    // Collapsed is the default: no diff body is painted until the block is expanded.
    expect(screen.frame()).not.toContain("Old cache note")
    expect(screen.frame()).not.toContain("Current cache note")

    const headerRow = screen.lines().findIndex((line) => line.includes("Edited 3 files"))
    await screen.mouse.click(12, headerRow)
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && !screen.frame().includes("+ Current cache note")) await Bun.sleep(20)

    const expanded = transcriptLines(screen.lines())
    const removed = expanded.find((line) => line.includes("- Old cache note")) ?? ""
    const added = expanded.find((line) => line.includes("+ Current cache note")) ?? ""
    expect(removed.search(/\d/)).toBe(5)
    expect(removed.indexOf("- Old cache note")).toBe(12)
    expect(added.indexOf("+ Current cache note")).toBe(12)
  } finally {
    await screen.dispose()
  }
}, 60_000)
