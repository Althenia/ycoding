/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import path from "node:path"
import { json } from "../fixture/tui-client"
import { DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE } from "../viewport"
import { captureRoute } from "./capture"

const parentID = "ses_0a22ce01"
const sessionID = "ses_0a22ce02"
const directory = "/tmp/ycoding/subagent-chat"
const location = { directory, project: { id: "proj_subagent_chat", directory } }
const parent = session(parentID, "Provider cache audit", "build", undefined, 9.08)
const child = session(sessionID, "Sync provider docs with cache fields", "docs-sync", parentID, 0.41)
const tasks = [createTask(sessionID, "docs-sync", "running", 1), createTask("ses_0a22ce03", "test-triage", "waiting", 2), createTask("ses_0a22ce04", "keymap-audit", "completed", 3)]

test("captures populated subagent chat states at reference terminal dimensions", async () => {
  for (const viewport of [DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE, { width: 80, height: 24 }]) {
    const lines = await captureRoute({
      ...viewport,
      args: { sessionID },
      settle: "Claude Sonnet 5",
      stable: ["Claude Sonnet 5"],
      route,
    })
    expect(lines).toHaveLength(viewport.height)
    expect(lines.join("\n")).toContain("Provider cache audit")
    expect(lines.join("\n")).toContain("◦ Docs-Sync")
    expect(lines.join("\n")).toContain("Context")
    expect(lines.join("\n")).toContain("prefix")
    expect(lines.join("\n")).toContain("read")
    expect(lines.join("\n")).toContain("write")
    expect(lines.join("\n")).toContain("rolls up to Provider cache audit")
    expect(lines.join("\n")).toContain("durable")
    expect(lines.join("\n")).not.toContain("┃")
    await Bun.write(path.resolve(import.meta.dir, `../../../../.aphrodite/renders/subagent-chat-${viewport.width}x${viewport.height}.txt`), lines.join("\n"))
  }
}, 120_000)

function session(id: string, title: string, agent: string, parentID: string | undefined, cost: number) { return { id, title, projectID: location.project.id, location: { directory }, agent, ...(parentID ? { parentID } : {}), model: { providerID: "anthropic", id: "claude-sonnet-5" }, cost, tokens: { input: 1_000, output: 200, reasoning: 0, cache: { read: 4_000, write: 200 } }, time: { created: 1, updated: 4 } } }
function createTask(sessionID: string, agent: string, state: "running" | "waiting" | "completed", created: number) { return { sessionID, parentID, description: agent === "docs-sync" ? "Sync provider docs with cache fields" : agent, agent, model: { providerID: "anthropic", id: "claude-sonnet-5" }, background: true, state, revision: 1, time: { created, updated: created } } }
function route(url: URL) {
  if (url.pathname === "/api/fs/list") return json({ location, data: [] }); if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: [parent, child], cursor: {} }); if (url.pathname === `/api/session/${sessionID}`) return json({ data: child }); if (url.pathname === `/api/session/${parentID}`) return json({ data: parent })
  if (tasks.some((item) => url.pathname === `/api/session/${item.sessionID}`)) return json({ data: tasks.some((item) => item.sessionID === sessionID && url.pathname === `/api/session/${item.sessionID}`) ? child : { ...child, id: url.pathname.slice("/api/session/".length) } })
  if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [{ id: "msg_assistant", type: "assistant", agent: "docs-sync", model: child.model, content: [{ type: "text", text: "Updated provider documentation." }], time: { created: 2, completed: 3 } }, { id: "msg_user", type: "user", text: "Sync the provider docs with the new cache telemetry fields.", time: { created: 1 } }], cursor: {} })
  if ([`/api/session/${sessionID}/pending`, `/api/session/${sessionID}/permission`, `/api/session/${sessionID}/form`, `/api/session/${sessionID}/todo`, `/api/session/${sessionID}/skills`, `/api/session/${sessionID}/guardrail/request`].includes(url.pathname)) return json({ data: [] }); if (url.pathname === `/api/session/${parentID}/subagent`) return json({ data: tasks }); if (url.pathname === `/api/session/${sessionID}/diagnostics`) return json({ data: { model: child.model, context: { total: 18_400, limit: 200_000, percent: 9 }, tokens: { uncachedInput: 1_000, output: 200, reasoning: 0, cacheRead: 4_000, cacheWrite: 200 }, cache: { eligible: 4_200, hitRatio: .74, minimumTokens: 4_000, mechanism: "anthropic-cache-control", readReported: true, writeReported: true }, requests: { logical: 1, physical: 1, helpers: 0, continued: 0, fallback: 0, tokens: child.tokens, latestInvalidation: "stable-hit" } } })
  if (url.pathname === "/api/vcs/branch") return json({ location, data: { current: "main", default: "main" } }); if (url.pathname === "/api/model") return json({ location, data: [{ id: "claude-sonnet-5", modelID: "claude-sonnet-5", providerID: "anthropic", name: "Claude Sonnet 5", capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [{ id: "fast" }], time: { released: 0 }, cost: [], status: "active", enabled: true, limit: { context: 200_000, output: 32_000 } }] }); if (url.pathname === "/api/provider") return json({ location, data: [{ id: "anthropic", name: "Claude" }] }); if (url.pathname === "/api/agent") return json({ location, data: [{ id: "docs-sync", name: "docs-sync", mode: "subagent", hidden: false, permissions: [], request: { headers: {}, body: {} } }, { id: "build", name: "Build", mode: "primary", hidden: false, permissions: [], request: { headers: {}, body: {} } }] })
  if (["/api/integration", "/api/command", "/api/skill", "/api/reference", "/api/mcp", "/api/shell", "/api/permission/request", "/api/form/request"].includes(url.pathname)) return json({ location, data: [] }); if (url.pathname === "/api/mcp/resource") return json({ location, data: { resources: [], templates: [] } }); if (url.pathname === "/path") return json({ home: process.env.HOME, state: "", config: "", worktree: directory, directory }); return undefined
}
