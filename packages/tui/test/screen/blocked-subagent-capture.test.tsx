/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { json } from "../fixture/tui-client"
import { DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE } from "../viewport"
import { captureRoute } from "./capture"

const renders = path.resolve(import.meta.dir, "../../../../.aphrodite/renders")
const parentID = "ses_blocked_parent"
const sessionID = "ses_blocked_child"
const directory = "/tmp/ycoding/blocked-subagent"
const location = { directory, project: { id: "proj_blocked", directory } }
const model = {
  id: "claude-sonnet-5",
  modelID: "claude-sonnet-5",
  providerID: "anthropic",
  name: "Claude Sonnet 5",
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  variants: [{ id: "fast" }],
  time: { released: 0 },
  cost: [],
  status: "active" as const,
  enabled: true,
  limit: { context: 200_000, output: 32_000 },
}
const parent = session(parentID, "Provider cache audit")
const child = { ...session(sessionID, "Test triage"), parentID, agent: "general" }
const siblings = [
  task("ses_cache", "Provider cache audit", "running", 1),
  task("ses_docs", "Docs sync", "running", 2),
  task(sessionID, "Test triage", "waiting", 3, "Should I mark the pre-existing failures as expected, or fix them?"),
  task("ses_keymap", "Keymap audit", "running", 4),
]

test("captures the product blocked-subagent screen at reference dimensions", async () => {
  for (const viewport of [DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE, { width: 80, height: 24 }]) {
    const rows = await captureRoute({
      ...viewport,
      args: { sessionID },
      settle: "Test triage",
      route,
    })
    expect(rows).toHaveLength(viewport.height)
    await mkdir(renders, { recursive: true })
    await Bun.write(path.join(renders, `blocked-subagent-${viewport.width}x${viewport.height}.txt`), rows.join("\n"))
    const output = rows.join("\n")
    expect(output).toContain("Enter answer")
    expect(output).toContain("durable")
    expect(output).not.toContain("Subagents  Shell")
    expect(output).not.toContain("┃")
    if (viewport.width === 80) continue
    expect(output).toContain("Two provider tests fail on main before my changes.")
    expect(output).toContain("Should I mark the pre-existing failures as expected, or fix them?")
    expect(output).toContain("TEST TRIAGE SUBAGENT")
    expect(output).toContain("task")
    expect(output).toContain("awaiting decision")
  }
}, 60_000)

function route(url: URL) {
  if (url.pathname === "/api/fs/list") return json({ location, data: [] })
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: [parent, child], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}`) return json({ data: child })
  if (["ses_cache", "ses_docs", "ses_keymap"].some((id) => url.pathname === `/api/session/${id}`))
    return json({ data: { ...session(url.pathname.slice("/api/session/".length), "Sibling") , parentID } })
  if (url.pathname === `/api/session/${sessionID}/message`)
    return json({
      data: [
        {
          id: "msg_assistant",
          type: "assistant",
          agent: "general",
          model: { providerID: "anthropic", id: "claude-sonnet-5", variant: "fast" },
          content: [{ type: "text", text: "Two provider tests fail on main before my changes. They assert a cache ratio of 0 when no tokens were read." }],
          time: { created: 2, completed: 3 },
        },
        { id: "msg_user", type: "user", text: "Investigate the provider test baseline.", time: { created: 1 } },
      ],
      cursor: {},
    })
  if (url.pathname === `/api/session/${parentID}/subagent`) return json({ data: siblings })
  if ([`/api/session/${sessionID}/pending`, `/api/session/${sessionID}/permission`, `/api/session/${sessionID}/todo`, `/api/session/${sessionID}/skills`, `/api/session/${sessionID}/guardrail/request`].includes(url.pathname)) return json({ data: [] })
  if (url.pathname === `/api/session/${sessionID}/guardrail`) return json({ data: guardrail() })
  if (url.pathname === `/api/session/${sessionID}/diagnostics`) return json({ data: diagnostics() })
  if (url.pathname === "/api/vcs/branch") return json({ location, data: { current: "main", default: "main" } })
  if (url.pathname === "/api/model") return json({ location, data: [model] })
  if (url.pathname === "/api/provider") return json({ location, data: [{ id: "anthropic", name: "Claude" }] })
  if (url.pathname === "/api/agent") return json({ location, data: [{ id: "general", name: "General", request: { headers: {}, body: {} }, mode: "subagent", hidden: false, permissions: [] }] })
  if (["/api/integration", "/api/command", "/api/skill", "/api/reference", "/api/mcp", "/api/shell", "/api/permission/request", "/api/form/request"].includes(url.pathname)) return json({ location, data: [] })
  if (url.pathname === "/api/mcp/resource") return json({ location, data: { resources: [], templates: [] } })
  if (url.pathname === "/path") return json({ home: process.env.HOME, state: "", config: "", worktree: directory, directory })
  return undefined
}

function session(id: string, title: string) {
  return { id, title, projectID: "proj_blocked", location: { directory }, agent: "general", model: { providerID: "anthropic", id: "claude-sonnet-5" }, cost: 0.63, tokens: { input: 31_200, output: 0, reasoning: 0, cache: { read: 68_000, write: 0 } }, time: { created: 1, updated: 4 } }
}

function task(sessionID: string, description: string, state: "running" | "waiting", created: number, question?: string) {
  return { sessionID, parentID, description, agent: "general", model: { providerID: "anthropic", id: "claude-sonnet-5" }, background: true, state, ...(question ? { question: { id: "qst_blocked", text: question, time: 4 } } : {}), revision: 1, time: { created, updated: 4 } }
}

function guardrail() {
  return { rootSessionID: parentID, profile: "standard", customRules: 0, approvals: 0, blocked: 0, counters: [], invalidFiles: [] }
}

function diagnostics() {
  return { model: { providerID: "anthropic", id: "claude-sonnet-5" }, context: { total: 31_200, percent: 15 }, tokens: { uncachedInput: 31_200, output: 0, reasoning: 0, cacheRead: 68_000, cacheWrite: 0 }, cache: { eligible: 68_000, hitRatio: 0.68, mechanism: "anthropic-cache-control", readReported: true, writeReported: true }, requests: { logical: 1, physical: 1, helpers: 0, continued: 0, fallback: 0, tokens: { input: 31_200, output: 0, reasoning: 0, cache: { read: 68_000, write: 0 } }, latestInvalidation: "stable-hit" } }
}
