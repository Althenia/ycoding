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
const patchFor = (path: string, line: string) => [`--- a/${path}`, `+++ b/${path}`, "@@ -1 +1 @@", "-export const value = 'old'", `+export const value = '${line}'`].join("\n")
const parentPatch = patchFor("src/parent.ts", "new")
const secondPatch = [
  "--- a/src/parent.ts",
  "+++ b/src/parent.ts",
  "@@ -1 +1 @@",
  "-export const next = 'old'",
  "+export const next = 'new'",
].join("\n")
const sixPaths = ["src/parent.ts", "src/child.ts", "src/feature.ts", "src/config.ts", "src/routes.ts", "src/styles.ts"]
const user = (id: string, text: string) => ({ id, type: "user", text, time: { created: 1 } })
const assistant = (id: string, content: unknown[], completed = true) => ({
  id, type: "assistant", agent: "build", model, content, finish: completed ? "stop" : "tool-calls",
  time: { created: 2, ...(completed ? { completed: 3 } : {}) },
})
const editPart = (id: string, path: string, patch: string, status = "completed") => ({
  type: "tool", id, name: "edit",
  state: status === "error"
    ? { status, input: { path }, content: [], structured: {}, error: { type: "tool.execution", message: "edit denied" } }
    : { status, input: { path }, content: [], structured: { files: [{ file: path, patch, additions: 1, deletions: 1 }] } },
  time: { created: 2, ran: 2, ...(status === "completed" ? { completed: 3 } : {}) },
})
const asMessages = (messages: unknown[]) => messages as SessionMessageInfo[]
const workingTranscript = asMessages([user("msg_user", "Apply the changes"), assistant("msg_assistant_working", [editPart("call_edit_running", "src/parent.ts", parentPatch, "running")], false)])
const singleTranscript = asMessages([user("msg_user", "Apply the changes"), assistant("msg_assistant_complete", [editPart("call_edit_parent", "src/parent.ts", parentPatch)])])
const mergedTranscript = asMessages([user("msg_user", "Apply the changes"),
  assistant("msg_assistant_complete", [editPart("call_edit_one", "src/parent.ts", parentPatch), editPart("call_edit_two", "src/parent.ts", secondPatch)])])
const segmentsTranscript = asMessages([
  user("msg_user_1", "First request"), assistant("msg_reply_1", [editPart("call_edit_1", "src/parent.ts", parentPatch)]),
  user("msg_user_2", "Second request"), assistant("msg_reply_2", [{ type: "text", text: "Nothing to change." }]),
  user("msg_steer", "Steered request"), assistant("msg_reply_3", [editPart("call_edit_3", "src/parent.ts", secondPatch)]),
])
const compactedSegmentsTranscript = asMessages([
  user("msg_user_1", "First request"), assistant("msg_reply_1", [editPart("call_edit_1", "src/first.ts", patchFor("src/first.ts", "first"))]),
  { id: "msg_compaction", type: "compaction", status: "completed", reason: "manual", summary: "Compacted transcript", recent: "", time: { created: 3 } },
  user("msg_user_2", "Second request"), assistant("msg_reply_2", [editPart("call_edit_2", "src/second.ts", patchFor("src/second.ts", "second"))]),
])
const sixFilesTranscript = asMessages([user("msg_user", "Apply the changes"),
  assistant("msg_assistant_six", sixPaths.map((path, index) => editPart(`call_edit_${index}`, path, patchFor(path, "new"))))])
const runningStepTranscript = asMessages([user("msg_user", "Apply the changes"),
  assistant("msg_step_done", [editPart("call_edit_one", "src/parent.ts", parentPatch)], false),
  assistant("msg_step_live", [{ type: "text", text: "Still working." }], false)])
const footerlessTranscript = asMessages([user("msg_user", "Apply the changes"),
  { ...assistant("msg_step_unknown", [editPart("call_edit_one", "src/parent.ts", parentPatch)]), finish: "unknown" },
  user("msg_user_2", "Next request"), assistant("msg_reply_2", [{ type: "text", text: "Nothing to change." }])])
const nextSegmentRunningTranscript = asMessages([
  user("msg_user_1", "First request"), assistant("msg_reply_1", [editPart("call_edit_1", "src/first.ts", patchFor("src/first.ts", "first"))]),
  user("msg_user_2", "Second request"), assistant("msg_step_2", [editPart("call_edit_2", "src/second.ts", patchFor("src/second.ts", "second"))], false),
])
const failedTranscript = asMessages([user("msg_user", "Apply the changes"), assistant("msg_assistant_failed", [editPart("call_edit_failed", "src/parent.ts", parentPatch, "error")])])
function routeFor(messages: SessionMessageInfo[], options: { onFileChange?: () => void; running?: boolean } = {}) {
  return (url: URL) => {
    if (url.pathname === "/api/session/active") return json({ data: options.running ? { [sessionID]: {} } : {} })
    if (url.pathname === "/api/fs/list") return json({ location, data: [] })
    if (url.pathname === "/api/location") return json(location)
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
    if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: messages, cursor: {} })
    if (url.pathname === `/api/session/${sessionID}/file-change`) {
      options.onFileChange?.()
      return json({ data: [] })
    }
    if (url.pathname === `/api/session/${sessionID}/pending`) return json({ data: [] })
    if (url.pathname === `/api/session/${sessionID}/guardrail/request`) return json({ location, data: [] })
    if (url.pathname === `/api/session/${sessionID}/subagent`) return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
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

const headerRows = (lines: string[], header: string) => lines.flatMap((line, index) => (line.includes(header) ? [index] : []))

test("shows a running edit as its own row and never as an edited or captured summary", async () => {
  const screen = await renderScreen({ ...DESIGN_VIEWPORT, args: { sessionID }, route: routeFor(workingTranscript), settle: "src/parent.ts" })
  try {
    expect(screen.frame()).toContain("src/parent.ts")
    expect(screen.frame()).not.toContain("export const value = 'new'")
    expect(screen.frame()).not.toContain("Edited 1 file")
    expect(screen.frame()).not.toContain("Captured changes")
  } finally {
    await screen.dispose()
  }
}, 60_000)

test("keeps a completed edit visible in the summary while its step is still running", async () => {
  const screen = await renderScreen({ ...DESIGN_VIEWPORT, height: 60, args: { sessionID }, route: routeFor(runningStepTranscript, { running: true }), settle: "Still working." })
  try {
    await waitForFrame(screen.frame, "Captured changes 1 file")
    const line = (text: string) => screen.lines().findIndex((row) => row.includes(text))
    expect(line("Still working.")).toBeLessThan(line("Captured changes 1 file"))
    expect(screen.frame()).not.toContain("Edited 1 file")
  } finally {
    await screen.dispose()
  }
}, 60_000)

test("shows the summary after an assistant that ended without a footer", async () => {
  const screen = await renderScreen({ ...DESIGN_VIEWPORT, height: 60, args: { sessionID }, route: routeFor(footerlessTranscript), settle: "Apply the changes" })
  try {
    await waitForFrame(screen.frame, "Captured changes 1 file")
    const line = (text: string) => screen.lines().findIndex((row) => row.includes(text))
    expect(line("Apply the changes")).toBeLessThan(line("Captured changes 1 file"))
    expect(line("Captured changes 1 file")).toBeLessThan(line("Next request"))
    expect(screen.frame()).not.toContain("Edited 1 file")
  } finally {
    await screen.dispose()
  }
}, 60_000)

test("keeps a finished segment's summary in place while the next segment is running", async () => {
  const screen = await renderScreen({ ...DESIGN_VIEWPORT, height: 80, args: { sessionID }, route: routeFor(nextSegmentRunningTranscript, { running: true }), settle: "Second request" })
  try {
    await waitFor(() => headerRows(screen.lines(), "Captured changes 1 file").length === 2, "two segment summaries")
    const [first, second] = headerRows(screen.lines(), "Captured changes 1 file")
    const line = (text: string) => screen.lines().findIndex((row) => row.includes(text))
    expect(line("First request")).toBeLessThan(first!)
    expect(first!).toBeLessThan(line("Second request"))
    expect(line("Second request")).toBeLessThan(second!)
  } finally {
    await screen.dispose()
  }
}, 60_000)

test("keeps a failed edit as its own failed row without a summary", async () => {
  const screen = await renderScreen({ ...DESIGN_VIEWPORT, args: { sessionID }, route: routeFor(failedTranscript), settle: "Apply the changes" })
  try {
    await waitForFrame(screen.frame, "edit")
    expect(screen.frame()).not.toContain("Captured changes")
    expect(screen.frame()).not.toContain("Edited 1 file")
  } finally {
    await screen.dispose()
  }
}, 60_000)

test("merges repeated edits to one file into one summary row and hides the per-tool edit blocks", async () => {
  const screen = await renderScreen({ ...DESIGN_VIEWPORT, height: 60, args: { sessionID }, route: routeFor(mergedTranscript), settle: "Captured changes 1 file" })
  try {
    await waitForFrame(screen.frame, "Captured changes 1 file")
    expect(screen.frame()).not.toContain("Edited 1 file")
    expect(screen.lines().filter((line) => line.includes("src/parent.ts"))).toHaveLength(0)
    await screen.mouse.click(12, headerRows(screen.lines(), "Captured changes 1 file")[0]!)
    await waitForFrame(screen.frame, "src/parent.ts")
    const rows = screen.lines().filter((line) => line.includes("src/parent.ts"))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain("+2")
    expect(screen.frame()).not.toContain("export const value = 'new'")
    expect(screen.frame()).not.toContain("export const next = 'new'")
  } finally {
    await screen.dispose()
  }
}, 60_000)

test("keeps one summary per prompt segment on its own reply, omits an unchanged segment, and reads no ledger", async () => {
  let ledgerRequested = false
  const screen = await renderScreen({
    ...DESIGN_VIEWPORT, height: 80, args: { sessionID }, route: routeFor(segmentsTranscript, { onFileChange: () => (ledgerRequested = true) }),
    settle: "Captured changes 1 file",
  })
  try {
    await waitForFrame(screen.frame, "Steered request")
    await waitFor(() => headerRows(screen.lines(), "Captured changes 1 file").length === 2, "two segment summaries")
    const [first, second] = headerRows(screen.lines(), "Captured changes 1 file")
    const line = (text: string) => screen.lines().findIndex((row) => row.includes(text))
    expect(line("First request")).toBeLessThan(first!)
    expect(first!).toBeLessThan(line("Second request"))
    expect(line("Nothing to change.")).toBeLessThan(line("Steered request"))
    expect(line("Steered request")).toBeLessThan(second!)
    expect(screen.frame()).not.toContain("Edited 1 file")
    expect(ledgerRequested).toBe(false)
  } finally {
    await screen.dispose()
  }
}, 60_000)

test("keeps earlier segment summaries across a compaction", async () => {
  const screen = await renderScreen({ ...DESIGN_VIEWPORT, height: 80, args: { sessionID }, route: routeFor(compactedSegmentsTranscript), settle: "Captured changes 1 file" })
  try {
    await waitFor(() => headerRows(screen.lines(), "Captured changes 1 file").length === 2, "two segment summaries")
    const [first, second] = headerRows(screen.lines(), "Captured changes 1 file")
    await screen.mouse.click(12, first!)
    await waitForFrame(screen.frame, "src/first.ts")
    expect(screen.frame()).not.toContain("src/second.ts")
    expect(screen.lines().findIndex((row) => row.includes("src/first.ts"))).toBeLessThan(headerRows(screen.lines(), "Captured changes 1 file")[1]!)
    expect(second).toBeGreaterThan(first!)
  } finally {
    await screen.dispose()
  }
}, 60_000)

test("lists every edited file of one segment and expands a patch", async () => {
  const screen = await renderScreen({ ...DESIGN_VIEWPORT, height: 80, args: { sessionID }, route: routeFor(sixFilesTranscript), settle: "Captured changes 6 files" })
  try {
    await waitForFrame(screen.frame, "Captured changes 6 files")
    await screen.mouse.click(12, headerRows(screen.lines(), "Captured changes 6 files")[0]!)
    await waitForFrame(screen.frame, sixPaths.at(-1)!)
    expect(screen.lines().filter((line) => sixPaths.some((path) => line.includes(path)))).toHaveLength(6)
    await screen.mouse.click(12, screen.lines().findIndex((line) => line.includes(sixPaths[0]!)))
    await waitForFrame(screen.frame, "export const value = 'new'")
    const row = screen.lines().find((line) => line.includes(sixPaths[0]!)) ?? ""
    expect(row).toContain("+1")
    expect(row).toContain("−1")
  } finally {
    await screen.dispose()
  }
}, 60_000)

async function waitFor(condition: () => boolean, label: string) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (condition()) return
    await Bun.sleep(20)
  }
  throw new Error(`screen did not settle on ${label}`)
}

for (const { name, width, config, split } of [
  { name: "wide auto", width: 189, config: undefined, split: true },
  { name: "wide split preference", width: 189, config: { diffs: { view: "split" } }, split: true },
  { name: "narrow auto", width: 90, config: undefined, split: false },
  { name: "narrow split preference", width: 90, config: { diffs: { view: "split" } }, split: false },
  { name: "wide unified preference", width: 189, config: { diffs: { view: "unified" } }, split: false },
]) test(`renders an expanded captured file with ${name} layout`, async () => {
  const screen = await renderScreen({
    width, height: 80, config, args: { sessionID },
    route: routeFor(singleTranscript),
    settle: "Captured changes 1 file",
  })
  try {
    const header = screen.lines().findIndex((line) => line.includes("Captured changes 1 file"))
    expect(header).toBeGreaterThan(-1)
    await screen.mouse.click(12, header)
    await waitForFrame(screen.frame, "src/parent.ts")
    const file = screen.lines().findIndex((line) => line.includes("src/parent.ts"))
    await screen.mouse.click(12, file)
    await waitForFrame(screen.frame, "export const value = 'new'")
    const oldRow = screen.lines().find((line) => line.includes("export const value = 'old'"))
    expect(oldRow).toBeDefined()
    if (split) {
      expect(oldRow).toContain("export const value = 'new'")
      const oldColumn = oldRow!.indexOf("export const value = 'old'")
      const newColumn = oldRow!.indexOf("export const value = 'new'")
      expect(oldColumn).toBeLessThan(newColumn)
      expect(oldRow!.slice(0, oldColumn)).toMatch(/\b1\b/)
      expect(oldRow!.slice(oldColumn + 26, newColumn)).toMatch(/\b1\b/)
    } else {
      expect(oldRow).not.toContain("export const value = 'new'")
      expect(screen.lines().find((line) => line.includes("export const value = 'new'"))).toMatch(/\b1\b/)
    }
  } finally {
    await screen.dispose()
  }
}, 60_000)
