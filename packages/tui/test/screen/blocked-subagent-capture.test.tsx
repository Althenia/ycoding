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
const directory = "test-triage"
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
test("captures the product blocked-subagent screen at reference dimensions", async () => {
  for (const viewport of [DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE, { width: 80, height: 24 }]) {
    const rows = await captureRoute({
      ...viewport,
      args: { sessionID },
      settle: "Claude Sonnet 5",
      stable: viewport.width === 80
        ? ["Enter answer"]
        : ["TEST-TRIAGE SUBAGENT", "Should I mark the pre-existing failures as expected, or fix them?", "test-triage (2 of 3)"],
      route,
    })
    expect(rows).toHaveLength(viewport.height)
    await mkdir(renders, { recursive: true })
    await Bun.write(path.join(renders, `blocked-subagent-${viewport.width}x${viewport.height}.txt`), rows.join("\n"))
    const output = rows.join("\n")
    expect(output).toContain("Enter answer")
    expect(output).toContain("awaiting input")
    expect(output).not.toContain("durable · resumable")
    expect(output).not.toContain("SUBAGENT ECONOMICS")
    expect(output).not.toContain("Subagents  Shell")
    expect(output).not.toContain("┃")
    if (viewport.width === 80) continue
    expect(output).toContain("Two provider tests fail on main before my changes.")
    expect(output).toContain("Should I mark the pre-existing failures as expected, or fix them?")
    expect(output).toContain("TEST-TRIAGE SUBAGENT")
    // Board 16 records the activity as a single `ok` row carrying the description and a right-aligned
    // result, replacing the pre-redesign separate `task` label row.
    expect(output).toContain("ok")
    expect(output).toContain("git stash · verify baseline")
    expect(output).toContain("awaiting decision")
    expect(output.match(/TEST-TRIAGE SUBAGENT/g)).toHaveLength(1)
    expect(output.match(/Two provider tests fail on main before my changes\./g)).toHaveLength(1)
    expect(output).toMatch(/blocked 3m\d{2}s/)
    expect(output).not.toContain("─")
    expect(output).not.toContain("│")
    expect(rows[9]?.indexOf("TEST-TRIAGE SUBAGENT")).toBe(3)
    expect(rows[11]?.indexOf("Two provider tests fail on main before my changes.")).toBe(3)
    expect(rows[15]?.indexOf("ok")).toBe(3)
    expect(rows[18]?.indexOf("?")).toBe(3)
    expect(rows[24]?.indexOf("Should I mark the pre-existing failures as expected, or fix them?")).toBe(6)
    expect(rows[1]).toContain("? awaiting input · 4m02s")
    expect(rows[61]?.indexOf("Enter answer")).toBe(3)
    expect(rows[61]?.indexOf("Esc leave blocked")).toBe(18)
    expect(rows[61]?.indexOf("↑ parent")).toBe(39)
  }
}, 60_000)

function route(url: URL) {
  const now = Date.now()
  const parent = session(parentID, "Provider cache audit", now)
  const child = { ...session(sessionID, "test-triage", now), parentID, agent: "general" }
  const siblings = [
    task("ses_docs", "docs-sync", "running", 1, now),
    task(sessionID, "git stash · verify baseline   2 failing", "waiting", 2, now, "Should I mark the pre-existing failures as expected, or fix them?"),
    task("ses_keymap", "keymap-audit", "running", 3, now),
  ]
  if (url.pathname === "/api/fs/list") return json({ location, data: [] })
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: [parent, child], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}`) return json({ data: child })
  if (["ses_docs", "ses_keymap"].some((id) => url.pathname === `/api/session/${id}`))
    return json({ data: { ...session(url.pathname.slice("/api/session/".length), "Sibling", now), parentID } })
  if (url.pathname === `/api/session/${sessionID}/message`)
    return json({
      data: [
        {
          id: "msg_assistant",
          type: "assistant",
          agent: "general",
          model: { providerID: "anthropic", id: "claude-sonnet-5", variant: "fast" },
          content: [{ type: "text", text: "Two provider tests fail on main before my changes. They assert a cache ratio of 0 when no tokens were read." }],
          time: { created: now - 230_000, completed: now - 222_000 },
        },
        { id: "msg_user", type: "user", text: "Investigate the provider test baseline.", time: { created: now - 242_000 } },
      ],
      cursor: {},
    })
  if (url.pathname === `/api/session/${parentID}/subagent`) return json({ data: siblings })
  if ([`/api/session/${sessionID}/pending`, `/api/session/${sessionID}/permission`, `/api/session/${sessionID}/todo`, `/api/session/${sessionID}/skills`, `/api/session/${sessionID}/guardrail/request`].includes(url.pathname)) return json({ data: [] })
  if (url.pathname === `/api/session/${sessionID}/guardrail`) return json({ data: guardrail() })
  if (url.pathname === `/api/session/${sessionID}/diagnostics`) return json({ data: diagnostics() })
  if (url.pathname === "/api/vcs/branch") return json({ location, data: { current: "", default: "" } })
  if (url.pathname === "/api/model") return json({ location, data: [model] })
  if (url.pathname === "/api/provider") return json({ location, data: [{ id: "anthropic", name: "Claude" }] })
  if (url.pathname === "/api/agent") return json({ location, data: [{ id: "general", name: "General", request: { headers: {}, body: {} }, mode: "primary", hidden: false, permissions: [] }] })
  if (["/api/integration", "/api/command", "/api/skill", "/api/reference", "/api/mcp", "/api/shell", "/api/permission/request", "/api/form/request"].includes(url.pathname)) return json({ location, data: [] })
  if (url.pathname === "/api/mcp/resource") return json({ location, data: { resources: [], templates: [] } })
  if (url.pathname === "/path") return json({ home: process.env.HOME, state: "", config: "", worktree: directory, directory })
  return undefined
}

function session(id: string, title: string, now: number) {
  return { id, title, projectID: "proj_blocked", location: { directory }, agent: "general", model: { providerID: "anthropic", id: "claude-sonnet-5", variant: "fast" }, cost: 0.63, tokens: { input: 31_200, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: now - 242_000, updated: now } }
}

function task(sessionID: string, description: string, state: "running" | "waiting", order: number, now: number, question?: string) {
  const agent = sessionID === "ses_docs" ? "docs-sync" : sessionID === "ses_keymap" ? "keymap-audit" : "test-triage"
  return { sessionID, parentID, description, agent, model: { providerID: "anthropic", id: "claude-sonnet-5" }, background: true, state, ...(question ? { question: { id: "qst_blocked", text: question, time: now - 221_000 } } : {}), revision: 1, time: { created: now - (5 - order) * 60_000, updated: now } }
}

function guardrail() {
  return { rootSessionID: parentID, profile: "standard", customRules: 0, approvals: 0, blocked: 0, counters: [], invalidFiles: [] }
}

function diagnostics() {
  return { model: { providerID: "anthropic", id: "claude-sonnet-5" }, context: { total: 31_200, percent: 15 }, tokens: { uncachedInput: 31_200, output: 0, reasoning: 0, cacheRead: 68_000, cacheWrite: 0 }, cache: { eligible: 68_000, hitRatio: 0.68, mechanism: "anthropic-cache-control", readReported: true, writeReported: true }, requests: { logical: 1, physical: 1, helpers: 0, continued: 0, fallback: 0, tokens: { input: 31_200, output: 0, reasoning: 0, cache: { read: 68_000, write: 0 } }, latestInvalidation: "stable-hit" } }
}
