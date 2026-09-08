/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import path from "node:path"
import { json } from "../fixture/tui-client"
import { DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE } from "../viewport"
import { captureRoute } from "./capture"

const parentID = "ses_0a22ce01"
const sessionID = "ses_0a22ce02"
const directory = "docs-sync"
const location = { directory, project: { id: "proj_subagent_chat", directory } }
const now = Date.now()
const parent = session(parentID, "Provider cache audit", "general", undefined, 9.08)
const child = session(sessionID, "Sync the provider docs with the new cache telemetry fields.", "general", parentID, 0.41)
const tasks = [createTask(sessionID, "docs-sync", "running", 1), createTask("ses_0a22ce03", "test-triage", "waiting", 2), createTask("ses_0a22ce04", "keymap-audit", "completed", 3)]

test("captures populated subagent chat states at reference terminal dimensions", async () => {
  for (const viewport of [DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE, { width: 80, height: 24 }]) {
    const lines = await captureRoute({
      ...viewport,
      args: { sessionID },
      settle: "Claude Sonnet 5",
      stable: ["Claude Sonnet 5", "◦ docs-sync"],
      route,
    })
    expect(lines).toHaveLength(viewport.height)
    // Board 15 row 5: chips carry the short sibling identity, and the reserved right block stays intact.
    expect(lines.join("\n")).toContain("◦ docs-sync")
    expect(lines.join("\n")).toContain("1 of 3  ·  ↑ parent  ← prev  → next")
    if (viewport.width >= 120) {
      expect(lines.join("\n")).toContain("Provider cache audit")
      const switcher = lines.find((line) => line.includes("↑ Provider cache audit")) ?? ""
      const navigation = "1 of 3  ·  ↑ parent  ← prev  → next"
      expect(switcher).toContain("◦ docs-sync")
      expect(switcher).toContain("? test-triage")
      expect(switcher.indexOf(navigation)).toBe(viewport.width - 3 - navigation.length)
      expect(lines[10]?.indexOf("DOCS-SYNC SUBAGENT")).toBe(3)
      expect(lines[13]?.indexOf("Traced the telemetry fields to their documented counterparts and preserved the parent session's write restrictions.")).toBe(3)
      // The shared grid right-aligns the duration as the row status, so it is no longer part of the
      // label run. Board 15 row 20 keeps the label at the content column with the duration at the edge.
      const thought = lines.find((line) => line.includes("Thought")) ?? ""
      expect(thought).toContain("Thought")
      expect(thought.trimEnd().endsWith("3ms")).toBe(true)
      expect(lines.join("\n")).toMatch(/thinking · \d+m\d{2}s/)
    }
    if (viewport.width >= 120) {
      expect(lines[1]).toContain("thinking · 2m14s")
      expect(lines.join("\n")).toContain("SUBAGENT ECONOMICS")
      expect(lines.join("\n")).toContain("Cache hit")
      expect(lines.join("\n")).toContain("18.4K / 200K · 9%")
      expect(lines.join("\n")).toContain("41,208")
      expect(lines.join("\n")).toContain("docs-sync (1 of 3)")
      expect(lines.join("\n")).toContain("durable · resumable")
      expect(lines[57]?.indexOf("SUBAGENT ECONOMICS")).toBe(3)
      expect(lines[59]?.indexOf("Context")).toBe(3)
      expect(lines[61]?.indexOf("18.4K / 200K · 9%")).toBe(3)
      expect(lines[67]?.indexOf("docs-sync (1 of 3)")).toBe(3)
    }
    if (viewport.width === 80) {
      expect(lines.join("\n")).toContain("↑ Pr…")
      expect(lines.join("\n")).not.toContain("? test-triage")
      expect(lines.join("\n")).not.toContain("◦ keymap-audit")
    }
    // Wide transcript mode renders expanded reasoning with its left border; narrow terminals omit it.
    if (viewport.width >= 120) expect(lines.join("\n")).toContain("┃")
    if (viewport.width < 120) expect(lines.join("\n")).not.toContain("┃")
    await Bun.write(path.resolve(import.meta.dir, `../../../../.aphrodite/renders/subagent-chat-${viewport.width}x${viewport.height}.txt`), lines.join("\n"))
  }
}, 120_000)

function session(id: string, title: string, agent: string, parentID: string | undefined, cost: number) { return { id, title, projectID: location.project.id, location: { directory }, agent, ...(parentID ? { parentID } : {}), model: { providerID: "anthropic", id: "claude-sonnet-5", variant: "fast" }, cost, tokens: { input: 18_400, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 4 } } }
function createTask(sessionID: string, agent: string, state: "running" | "waiting" | "completed", created: number) { return { sessionID, parentID, description: agent === "docs-sync" ? "Read provider docs and cross-check fields" : agent, agent, model: { providerID: "anthropic", id: "claude-sonnet-5" }, background: true, state, revision: 1, ...(state === "waiting" ? { question: { text: "Need test guidance", time: now - 2_000 } } : {}), time: { created, updated: created } } }
function route(url: URL) {
  if (url.pathname === "/api/fs/list") return json({ location, data: [] }); if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: [parent, child], cursor: {} }); if (url.pathname === `/api/session/${sessionID}`) return json({ data: child }); if (url.pathname === `/api/session/${parentID}`) return json({ data: parent })
  if (tasks.some((item) => url.pathname === `/api/session/${item.sessionID}`)) return json({ data: tasks.some((item) => item.sessionID === sessionID && url.pathname === `/api/session/${item.sessionID}`) ? child : { ...child, id: url.pathname.slice("/api/session/".length) } })
  if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [{ id: "msg_assistant", type: "assistant", agent: "general", model: child.model, content: [{ type: "text", text: "Traced the telemetry fields to their documented counterparts and preserved the parent session's write restrictions." }, { type: "reasoning", text: "no writes outside docs/", time: { created: now - 133_997, completed: now - 133_994 } }, { type: "text", text: "$   Read provider docs and cross-check fields   6 calls  >" }, { type: "text", text: "Updated docs/guardrails-and-provider-usage.md with the cache hit-ratio and stable-prefix fields." }, { type: "text", text: "ok   Field parity: pass, 0 missing" }, { type: "text", text: "ok   git diff --check: pass" }, { type: "text", text: "ok   Parent restrictions: preserved" }], time: { created: Date.now() - 134_000 } }, { id: "msg_user", type: "user", text: "Sync the provider docs with the new cache telemetry fields.", time: { created: now - 135_000 } }], cursor: {} })
  if (tasks.some((task) => url.pathname === `/api/session/${task.sessionID}/message`)) return json({ data: [], cursor: {} })
  if ([`/api/session/${sessionID}/pending`, `/api/session/${sessionID}/permission`, `/api/session/${sessionID}/form`, `/api/session/${sessionID}/todo`, `/api/session/${sessionID}/skills`, `/api/session/${sessionID}/guardrail/request`].includes(url.pathname)) return json({ data: [] }); if ([parentID, sessionID].some((id) => url.pathname === `/api/session/${id}/subagent`)) return json({ data: tasks, summary: { total: 3, active: 2, running: 1, waiting: 1 }, cursor: {} }); if (url.pathname === `/api/session/${sessionID}/diagnostics`) return json({ data: { model: child.model, context: { total: 18_400, limit: 200_000, percent: 9 }, tokens: { uncachedInput: 1_000, output: 200, reasoning: 0, cacheRead: 41_208, cacheWrite: 2_048 }, cache: { eligible: 43_256, hitRatio: .74, minimumTokens: 4_000, mechanism: "anthropic-cache-control", readReported: true, writeReported: true }, requests: { logical: 1, physical: 1, helpers: 0, continued: 0, fallback: 0, tokens: child.tokens, latestInvalidation: "stable-hit" } } })
  if (url.pathname === "/api/vcs/branch") return json({ location, data: { current: "", default: "" } }); if (url.pathname === "/api/model") return json({ location, data: [{ id: "claude-sonnet-5", modelID: "claude-sonnet-5", providerID: "anthropic", name: "Claude Sonnet 5", capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [{ id: "fast" }], time: { released: 0 }, cost: [], status: "active", enabled: true, limit: { context: 200_000, output: 32_000 } }] }); if (url.pathname === "/api/provider") return json({ location, data: [{ id: "anthropic", name: "Claude" }] }); if (url.pathname === "/api/agent") return json({ location, data: [{ id: "docs-sync", name: "docs-sync", mode: "subagent", hidden: false, permissions: [], request: { headers: {}, body: {} } }, { id: "general", name: "General", mode: "primary", hidden: false, permissions: [], request: { headers: {}, body: {} } }] })
  if (["/api/integration", "/api/command", "/api/skill", "/api/reference", "/api/mcp", "/api/shell", "/api/permission/request", "/api/form/request"].includes(url.pathname)) return json({ location, data: [] }); if (url.pathname === "/api/mcp/resource") return json({ location, data: { resources: [], templates: [] } }); if (url.pathname === "/path") return json({ home: process.env.HOME, state: "", config: "", worktree: directory, directory }); return undefined
}
