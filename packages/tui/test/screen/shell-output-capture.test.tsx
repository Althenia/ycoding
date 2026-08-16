/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { json, type FetchHandler } from "../fixture/tui-client"
import { DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE } from "../viewport"
import { captureRoute } from "./capture"

const renders = path.resolve(import.meta.dir, "../../../../.aphrodite/renders")
const sessionID = "ses_shell_capture"
const shellID = "sh_0f21"
const directory = "/tmp/ycoding/shell-output"
const location = { directory, project: { id: "proj_shell", directory } }
const now = Date.now()
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
const session = {
  id: sessionID,
  title: "Provider tests",
  projectID: "proj_shell",
  location: { directory },
  agent: "general",
  model: { providerID: "anthropic", id: "claude-sonnet-5" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 4 },
}
const shellData = {
  id: shellID,
  status: "running" as const,
  command: "bun test provider",
  cwd: directory,
  shell: "bash",
  file: `/tmp/${shellID}`,
  pid: 105,
  metadata: { sessionID },
  time: { started: now - 10_000 },
}

test("shell-output route renders identity header, stream, metadata, and footer", async () => {
  for (const viewport of [DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE]) {
    process.env.YCODING_ROUTE = JSON.stringify({ type: "shell-output", sessionID, shellID })
    try {
      const rows = await captureRoute({
        ...viewport,
        route,
        settle: "bun test provider",
        stable: ["records cache read counters", "returns 0 ratio when nothing read"],
      })
      expect(rows).toHaveLength(viewport.height)
      const text = rows.join("\n")
      expect(text).toContain("y. ycoding")
      expect(text).toContain("bun test provider")
      expect(text).toContain("Main chat")
      expect(text).toContain("pid 105")
      expect(text).toContain("running")
      expect(text).toContain("records cache read counters")
      expect(text).toContain("returns 0 ratio when nothing read")
      expect(text).toContain("Owner:")
      expect(text).toContain("Status:")
      expect(text).toContain("Started:")
      expect(text).toContain("Capture:")
      expect(text).toContain(shellID)
      expect(text).toContain("kill")
      expect(text).toContain("back")
      expect(text).not.toContain("Message YCoding")
      expect(text).not.toContain("SHELLS")
      expect(rows[6]).toContain("bun test v1.3.14")
      expect(rows.slice(55, 66).join("\n")).toContain("Capture:")
      await mkdir(renders, { recursive: true })
      await Bun.write(path.join(renders, `shell-output-${viewport.width}x${viewport.height}.txt`), rows.join("\n"))
    } finally {
      delete process.env.YCODING_ROUTE
    }
  }
}, 60_000)

test("shell-output route renders an exited shell without a kill action", async () => {
  process.env.YCODING_ROUTE = JSON.stringify({ type: "shell-output", sessionID, shellID })
  try {
    const rows = await captureRoute({
      ...DESIGN_VIEWPORT,
      route: terminalRoute,
      settle: "No captured output",
      stable: ["exited", "No captured output", "Capture:"],
    })
    const text = rows.join("\n")
    expect(text).toContain("exited")
    expect(text).toContain("No captured output")
    expect(text).toContain("Capture:")
    expect(text).not.toContain("kill")
  } finally {
    delete process.env.YCODING_ROUTE
  }
}, 60_000)

const route: FetchHandler = (url) => {
  if (url.pathname === "/api/fs/list") return json({ location, data: [] })
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
  if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [], cursor: {} })
  if ([`/api/session/${sessionID}/pending`, `/api/session/${sessionID}/permission`, `/api/session/${sessionID}/todo`, `/api/session/${sessionID}/skills`, `/api/session/${sessionID}/subagent`, `/api/session/${sessionID}/guardrail/request`].includes(url.pathname)) return json({ data: [] })
  if (url.pathname === `/api/session/${sessionID}/guardrail`) return json({ data: { rootSessionID: sessionID, profile: "standard", customRules: 0, approvals: 0, blocked: 0, counters: [], invalidFiles: [] } })
  if (url.pathname === `/api/session/${sessionID}/diagnostics`) return json({ data: null })
  if (url.pathname === "/api/vcs/branch") return json({ location, data: { current: "main", default: "main" } })
  if (url.pathname === "/api/model") return json({ location, data: [model] })
  if (url.pathname === "/api/provider") return json({ location, data: [{ id: "anthropic", name: "Claude" }] })
  if (url.pathname === "/api/agent") return json({ location, data: [{ id: "general", name: "General", request: { headers: {}, body: {} }, mode: "primary", hidden: false, permissions: [] }] })
  if (["/api/integration", "/api/command", "/api/skill", "/api/reference", "/api/mcp", "/api/permission/request", "/api/form/request"].includes(url.pathname)) return json({ location, data: [] })
  if (url.pathname === "/api/shell") return json({ location, data: [shellData] })
  if (url.pathname === `/api/shell/${shellID}/output`) return json({ location, data: { output: "bun test v1.3.14\n✓ records cache read counters   [2.11ms]\n✓ records cache write counters  [0.94ms]\n✗ returns 0 ratio when nothing read  [1.02ms]\n    expected: 0   received: undefined\n14 pass · 2 fail · 1 skip", cursor: 999, size: 200, truncated: false } })
  if (url.pathname === "/api/mcp/resource") return json({ location, data: { resources: [], templates: [] } })
  if (url.pathname === "/path") return json({ home: process.env.HOME, state: "", config: "", worktree: directory, directory })
  if (url.pathname === "/api/session/active") return json({ data: {} })
  return undefined
}

const terminalRoute: FetchHandler = (url, request) => {
  if (url.pathname === "/api/shell")
    return json({
      location,
      data: [{ ...shellData, status: "exited", time: { started: now - 10_000, completed: now }, exit: 1 }],
    })
  if (url.pathname === `/api/shell/${shellID}/output`)
    return json({ location, data: { output: "", cursor: 0, size: 0, truncated: false } })
  return route(url, request)
}
