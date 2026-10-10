/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { ModelInfo, SessionMessageInfo } from "@ycoding-ai/client"
import { SessionOrchestrationIdentity } from "@ycoding-ai/core/session/orchestration-identity"
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
const patchFor = (path: string, line: string) => [`--- a/${path}`, `+++ b/${path}`, "@@ -1 +1 @@", "-export const value = false", `+export const value = ${line}`].join("\n")
const user = (id: string, text: string) => ({ id, type: "user", text, time: { created: 1 } })
const assistant = (id: string, content: unknown[], finish = "stop") => ({
  id, type: "assistant", agent: "build", model, content, finish, time: { created: 2, completed: 3 },
})
const editPart = (id: string, path: string, line: string) => ({
  type: "tool", id, name: "edit",
  state: { status: "completed", input: { path }, content: [], structured: { files: [{ file: path, patch: patchFor(path, line), additions: 1, deletions: 1 }] } },
  time: { created: 2, ran: 2, completed: 3 },
})
const controlPart = (id: string, action: string, input: Record<string, unknown> = {}) => ({
  type: "tool", id, name: "subagent_control",
  state: { status: "completed", input: { action, sessionID: "ses_child", ...input }, content: [], structured: { action, task: { sessionID: "ses_child" } } },
  time: { created: 2, ran: 2, completed: 3 },
})
const launchPart = { type: "tool", id: "call_launch", name: "subagent", state: { status: "running", input: {}, content: [], structured: { sessionID: "ses_child", status: "running" } }, time: { created: 2, ran: 2 } }
const forgedPart = { type: "tool", id: "call_forged", name: "subagent", state: { status: "completed", input: {}, content: [], structured: { sessionID: "ses_foreign" } }, time: { created: 2, ran: 2, completed: 3 } }
const parentTranscript = [
  user("msg_user_1", "Launch the review"),
  assistant("msg_step_1", [editPart("call_edit_parent", "src/parent.ts", "true"), launchPart, forgedPart], "tool-calls"),
  assistant("msg_reply_1", [{ type: "text", text: "Review launched." }]),
  user("msg_user_2", "Send a follow-up"),
  assistant("msg_reply_2", [controlPart("call_send", "send"), { type: "text", text: "Follow-up sent." }]),
] as SessionMessageInfo[]
const childTranscript = [
  { id: "msg_task_launch", type: "user", text: "Review", time: { created: 2 } },
  assistant("msg_child_1", [editPart("call_edit_child", "src/child.ts", "true"), { type: "tool", id: "call_edit_bad", name: "edit", state: { status: "completed", input: {}, content: [], structured: { files: [{ file: "src/ignored.ts", patch: "not a diff", additions: 1, deletions: 0 }] } }, time: { created: 2, ran: 2, completed: 3 } }]),
  { id: "msg_manual_child", type: "user", text: "Manual nudge", time: { created: 3 } },
  assistant("msg_child_manual", [editPart("call_edit_manual", "src/manual.ts", "true")]),
  { id: SessionOrchestrationIdentity.send(sessionID, "msg_reply_2", "call_send"), type: "synthetic", text: "Follow up", description: "Parent subagent message", metadata: { source: "subagent_parent", kind: "message" }, time: { created: 3 } },
  assistant("msg_child_2", [editPart("call_edit_later", "src/later.ts", "true")]),
] as SessionMessageInfo[]
function routeFor(messages: SessionMessageInfo[], onMessages?: (sessionID: string) => void) {
  return (url: URL) => {
    if (url.pathname === "/api/fs/list") return json({ location, data: [] })
    if (url.pathname === "/api/location") return json(location)
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
    if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: messages, cursor: {} })
    if (url.pathname === "/api/session/ses_child/message") return json({ data: childTranscript, cursor: {} })
    if (url.pathname === "/api/session/ses_foreign/message") { onMessages?.("ses_foreign"); return json({ data: childTranscript, cursor: {} }) }
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
            state: "running",
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
    if (url.pathname === "/api/model") return json({ location, data: [{ id: model.id, modelID: model.id, providerID: model.providerID, name: "Claude Opus 5", capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [], time: { released: 0 }, cost: [], status: "active", enabled: true, limit: { context: 200_000, output: 32_000 } }] satisfies ModelInfo[] })
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

test("attributes a reused child's work to the segment that dispatched it and keeps one collapsed summary per segment", async () => {
  const foreignReads: string[] = []
  const screen = await renderScreen({
    ...DESIGN_VIEWPORT,
    height: 80,
    args: { sessionID },
    route: routeFor(parentTranscript, (id) => foreignReads.push(id)),
    settle: "Captured changes 2 files",
  })
  try {
    await waitForFrame(screen.frame, "Captured changes 1 file")
    const rows = (header: string) => screen.lines().flatMap((line, index) => (line.includes(header) ? [index] : []))
    const line = (text: string) => screen.lines().findIndex((row) => row.includes(text))
    expect(rows("Captured changes 2 files")).toHaveLength(1)
    expect(rows("Captured changes 1 file")).toHaveLength(1)
    expect(line("Review launched.")).toBeLessThan(rows("Captured changes 2 files")[0]!)
    expect(rows("Captured changes 2 files")[0]!).toBeLessThan(line("Send a follow-up"))
    expect(line("Follow-up sent.")).toBeLessThan(rows("Captured changes 1 file")[0]!)
    expect(screen.frame()).not.toContain("Edited ")
    expect(screen.frame()).not.toContain("src/child.ts")
    expect(screen.lines().filter((row) => row.includes("src/parent.ts"))).toHaveLength(0)
    expect(foreignReads).toEqual([])

    await screen.mouse.click(12, rows("Captured changes 1 file")[0]!)
    await waitForFrame(screen.frame, "src/later.ts")
    expect(screen.frame()).not.toContain("src/child.ts")
    expect(screen.frame()).not.toContain("export const value = true")

    await screen.mouse.click(12, rows("Captured changes 2 files")[0]!)
    await waitForFrame(screen.frame, "src/child.ts")
    expect(screen.lines().filter((row) => row.includes("src/parent.ts"))).toHaveLength(1)
    expect(screen.frame()).not.toContain("src/ignored.ts")
    expect(screen.frame()).not.toContain("src/manual.ts")
    await screen.mouse.click(12, screen.lines().findIndex((row) => row.includes("src/parent.ts")))
    await waitForFrame(screen.frame, "export const value = true")
  } finally {
    await screen.dispose()
  }
}, 60_000)
