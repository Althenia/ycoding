/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@ycoding-ai/client"
import { json } from "./fixture/tui-client"
import { DESIGN_VIEWPORT } from "./viewport"
import { renderScreen } from "./screen/harness"

const sessionID = "ses_file_change_summary"
const directory = "/tmp/ycoding/file-change-summary"
const location = { directory, project: { id: "proj_file_change_summary", directory } }
const model = { providerID: "anthropic", id: "claude-opus-5" }
const session = {
  id: sessionID,
  title: "File change summary",
  projectID: "proj_file_change_summary",
  location: { directory },
  agent: "build",
  model,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 3 },
}
const parentPatch = [
  "--- a/src/parent.ts",
  "+++ b/src/parent.ts",
  "@@ -1 +1 @@",
  "-export const value = 'old'",
  "+export const value = 'new'",
].join("\n")
const childPatch = [
  "--- a/src/child.ts",
  "+++ b/src/child.ts",
  "@@ -1 +1 @@",
  "-export const child = false",
  "+export const child = true",
].join("\n")
const workingTranscript = [
  { id: "msg_user", type: "user", text: "Apply the changes", time: { created: 1 } },
  {
    id: "msg_assistant_working",
    type: "assistant",
    agent: "build",
    model,
    content: [
      {
        type: "tool",
        id: "call_edit_parent",
        name: "edit",
        state: {
          status: "running",
          input: { path: "src/parent.ts" },
          content: [],
          structured: { files: [{ file: "src/parent.ts", patch: parentPatch, additions: 1, deletions: 1 }] },
        },
        time: { created: 2, ran: 2 },
      },
    ],
    finish: "tool-calls",
    time: { created: 2 },
  },
] as SessionMessageInfo[]
const aggregateTranscript = [
  ...workingTranscript.slice(0, 1),
  {
    id: "msg_assistant_complete",
    type: "assistant",
    agent: "build",
    model,
    content: [
      {
        type: "tool",
        id: "call_edit_parent_complete",
        name: "edit",
        state: {
          status: "completed",
          input: { path: "src/parent.ts" },
          content: [],
          structured: { files: [{ file: "src/parent.ts", patch: parentPatch, additions: 1, deletions: 1 }] },
        },
        time: { created: 2, ran: 2, completed: 3 },
      },
    ],
    finish: "stop",
    time: { created: 2, completed: 3 },
  },
] as SessionMessageInfo[]

const childTranscript = [
  {
    id: "msg_child_complete",
    type: "assistant",
    agent: "build",
    model,
    content: [
      {
        type: "tool",
        id: "call_edit_child_complete",
        name: "edit",
        state: {
          status: "completed",
          input: { path: "src/child.ts" },
          content: [],
          structured: {
            files: [
              { file: "src/child.ts", patch: childPatch, additions: 1, deletions: 1 },
              { file: "src/ignored.ts", patch: "not a diff", additions: 1, deletions: 0 },
            ],
          },
        },
        time: { created: 2, ran: 2, completed: 3 },
      },
    ],
    finish: "stop",
    time: { created: 2, completed: 3 },
  },
] as SessionMessageInfo[]
function routeFor(messages: SessionMessageInfo[]) {
  return (url: URL) => {
    if (url.pathname === "/api/fs/list") return json({ location, data: [] })
    if (url.pathname === "/api/location") return json(location)
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
    if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: messages, cursor: {} })
    if (url.pathname === "/api/session/ses_child/message") return json({ data: childTranscript, cursor: {} })
    if (url.pathname === `/api/session/${sessionID}/pending`) return json({ data: [] })
    if (url.pathname === `/api/session/${sessionID}/guardrail/request`) return json({ location, data: [] })
    if (url.pathname === `/api/session/${sessionID}/subagent`)
      return json({
        data: [
          {
            sessionID: "ses_child",
            parentID: sessionID,
            description: "Update child file",
            agent: "build",
            model,
            background: true,
            state: "completed",
            revision: 1,
            time: { created: 2, updated: 3 },
          },
        ],
        summary: { total: 1, active: 0, running: 0, waiting: 0 },
        cursor: {},
      })
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
      return json({ data: { rootSessionID: sessionID, profile: "standard", customRules: 0, approvals: 0, blocked: 0, counters: [], invalidFiles: [] } })
    if (url.pathname === `/api/session/${sessionID}/diagnostics`)
      return json({ data: { model, context: { total: 0, percent: 0 }, tokens: { uncachedInput: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cache: { eligible: 0, mechanism: "unreported", readReported: false, writeReported: false }, requests: { logical: 0, physical: 0, helpers: 0, continued: 0, fallback: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } } })
    if (url.pathname === "/api/vcs/branch") return json({ location, data: { current: "main", default: "main" } })
    if (url.pathname === "/api/model") return json({ location, data: [{ id: model.id, modelID: model.id, providerID: model.providerID, name: "Claude Opus 5", capabilities: { tools: true, input: ["text"], output: ["text"] }, time: { released: 0 }, cost: [], status: "active", enabled: true, limit: { context: 200_000, output: 32_000 } }] })
    if (url.pathname === "/api/provider") return json({ location, data: [{ id: "anthropic", name: "Claude" }] })
    if (url.pathname === "/api/agent") return json({ location, data: [{ id: "build", name: "Build", request: { headers: {}, body: {} }, mode: "primary", hidden: false, permissions: [] }] })
    return undefined
  }
}

async function waitForFrame(frame: () => string, text: string) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (frame().includes(text)) return
    await Bun.sleep(20)
  }
  throw new Error(`screen did not settle on ${text}`)
}

test("collapses the captured changes summary until the header is expanded", async () => {
  const screen = await renderScreen({
    ...DESIGN_VIEWPORT,
    args: { sessionID },
    route: routeFor(aggregateTranscript),
    settle: "Captured changes 2 files",
  })
  try {
    await waitForFrame(screen.frame, "Captured changes 2 files")
    expect(screen.frame()).toContain("Captured changes 2 files")
    // A captured-changes block can list hundreds of files, so it stays collapsed until asked for.
    // The per-tool "Edited" block keeps listing src/parent.ts, so src/child.ts is what distinguishes
    // the captured block, and src/parent.ts must appear once instead of twice.
    expect(screen.frame()).not.toContain("src/child.ts")
    expect(screen.lines().filter((line) => line.includes("src/parent.ts"))).toHaveLength(1)

    const headerRows = screen
      .lines()
      .flatMap((line, index) => (line.includes("Captured changes 2 files") ? [index] : []))
    await screen.mouse.click(12, headerRows.at(-1)!)
    await waitForFrame(screen.frame, "src/child.ts")
    expect(screen.frame()).toContain("src/child.ts")
    expect(screen.lines().filter((line) => line.includes("src/parent.ts"))).toHaveLength(2)
    expect(screen.frame()).not.toContain("export const value = 'new'")
    expect(screen.frame()).not.toContain("export const child = true")

    const parentRows = screen.lines().flatMap((line, index) => (line.includes("src/parent.ts") ? [index] : []))
    await screen.mouse.click(12, parentRows.at(-1)!)
    await waitForFrame(screen.frame, "export const value = 'new'")
    expect(screen.frame()).toContain("export const value = 'new'")
    expect(screen.frame()).not.toContain("export const child = true")
  } finally {
    await screen.dispose()
  }
}, 60_000)
