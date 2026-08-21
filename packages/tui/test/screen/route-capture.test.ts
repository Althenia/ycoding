import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { json, type FetchHandler } from "../fixture/tui-client"
import { captureRoute } from "./capture"

const HEIGHT = 69
const HOME_WIDTH = 189
const WIDE_WIDTH = 220
const directory = "~/Workspace/Personal/YCoding"
const location = { directory, project: { id: "proj_route_capture", directory } }
const sessionID = "ses_0085fc701_capture"
const now = Date.now()
const agent = {
  id: "build",
  name: "Build",
  mode: "primary" as const,
  hidden: false,
  permissions: [],
  request: { headers: {}, body: {} },
}
const model = {
  id: "claude-opus-5",
  modelID: "claude-opus-5",
  providerID: "anthropic",
  name: "Claude Opus 5",
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  // Location model info exposes variants as objects; local.model.variant.list() reads variant.id.
  variants: [{ id: "max" }],
  time: { released: 0 },
  cost: [],
  status: "active" as const,
  enabled: true,
  limit: { context: 200_000, output: 32_000 },
}
const session = {
  id: sessionID,
  title: "Provider cache audit",
  projectID: "proj_route_capture",
  location: { directory },
  agent: "build",
  model: { providerID: "anthropic", id: "claude-opus-5" },
  cost: 7.84,
  tokens: { input: 1_411, output: 53, reasoning: 0, cache: { read: 220_672, write: 4_096 } },
  time: { created: 1, updated: 4 },
}
const childSession = {
  ...session,
  id: "ses_docs_sync",
  parentID: sessionID,
  title: "Sync provider docs",
  cost: 1.24,
}
const todos = [
  { content: "Verify baseline", status: "completed" as const, priority: "medium" as const },
  { content: "Fix cache accounting", status: "in_progress" as const, priority: "high" as const },
]
const guardrails = [
  {
    id: "grd_write_outside_workspace",
    rootSessionID: sessionID,
    sessionID,
    action: "write",
    resources: ["../provider-cache.md"],
    ruleIDs: ["workspace-write"],
    reason: "write outside workspace",
    standard: true,
  },
]
const subagents = [
  {
    sessionID: "ses_docs_sync",
    parentID: sessionID,
    description: "docs-sync",
    agent: "docs-sync",
    model: { providerID: "anthropic", id: "claude-opus-5" },
    background: true,
    state: "running" as const,
    revision: 1,
    time: { created: now - 134_000, updated: now },
  },
  {
    sessionID: "ses_cache_audit",
    parentID: sessionID,
    description: "cache-audit",
    agent: "build",
    model: { providerID: "anthropic", id: "claude-opus-5" },
    background: true,
    state: "completed" as const,
    revision: 1,
    time: { created: now - 61_000, updated: now },
  },
]
const shells = ["sh_main_test", "sh_main_dev", "sh_docs_diff"].map((id) => ({
  id,
  status: "running" as const,
  command: "bun test provider",
  cwd: directory,
  shell: "/bin/sh",
  file: `/tmp/${id}`,
  metadata: { sessionID },
  time: { started: now - 4_000 },
}))
const skills = ["review", "cache-audit"].map((id) => ({
  id,
  name: id,
  activatedBy: "tool" as const,
  activationMessageID: "msg_skill",
  content: "",
  conflicts: [],
  declarations: {},
  state: "active" as const,
}))
const pluginStatus = [
  {
    id: "audit-tools",
    source: "file" as const,
    spec: "audit-tools",
    target: "audit-tools",
    enabled: true,
    active: true,
  },
]

const homeRoute: FetchHandler = (url) => {
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/vcs/branch") return json({ location, data: { current: "main", default: "main" } })
  if (url.pathname === "/api/agent") return json({ location, data: [agent] })
  if (url.pathname === "/api/model") return json({ location, data: [model] })
  if (url.pathname === "/api/provider") return json({ location, data: [{ id: "anthropic", name: "Claude" }] })
  if (url.pathname === "/api/integration")
    return json({ location, data: [{ id: "anthropic", name: "Anthropic", connections: [{ type: "credential", id: "cred_capture", label: "Capture" }] }] })
  if (["/api/command", "/api/skill", "/api/reference"].includes(url.pathname))
    return json({ location, data: [] })
  return undefined
}

const sessionRoute: FetchHandler = (url, request) => {
  if (url.pathname === "/api/fs/list") return json({ location, data: [] })
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: [session, childSession], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
  if (url.pathname === `/api/session/${sessionID}/message`) {
    return json({
      data: [
        {
          id: "msg_compaction",
          type: "compaction",
          status: "completed",
          reason: "auto",
          summary: "",
          recent: "",
          messages: 42,
          tokens: { input: 1_000, output: 100, reasoning: 50, cache: { read: 40, write: 10 } },
          time: { created: Date.now() - 1_000 },
        },
        {
          id: "msg_assistant",
          type: "assistant",
          agent: "build",
          model: { providerID: "anthropic", id: "claude-opus-5", variant: "max" },
          content: [
            {
              type: "text",
              text: "Two places record it. The runtime writes counters into the durable session record, and the\n\nTUI reads them for the rail. Recording path is packages/core/src/provider/usage.ts:88.",
            },
            {
              type: "tool",
              id: "call_todowrite",
              name: "todowrite",
              state: {
                status: "completed",
                input: {
                  todos: [
                    { content: "Inspect cache telemetry callers", status: "completed", priority: "medium" },
                    { content: "Fix shared cache accounting", status: "in_progress", priority: "high" },
                  ],
                },
                structured: {},
                content: [{ type: "text", text: "Todos updated" }],
                result: {},
              },
              time: { created: now - 3_900, ran: now - 3_800, completed: now - 3_700 },
            },
            {
              type: "tool",
              id: "call_grep",
              name: "grep",
              state: {
                status: "completed",
                input: { pattern: "cache_read" },
                structured: { matches: 17 },
                content: [{ type: "text", text: "17 matches" }],
                result: {},
              },
              time: { created: now - 3_600, ran: now - 3_500, completed: now - 3_400 },
            },
          ],
          time: { created: Date.now() - 4_060 },
        },
        { id: "msg_user", type: "user", text: "Where is provider cache telemetry recorded?", time: { created: 1 } },
      ],
    })
  }
  if ([`/api/session/${sessionID}/pending`, `/api/session/${sessionID}/permission`].includes(url.pathname))
    return json({ data: [] })
  if (url.pathname === `/api/session/${sessionID}/guardrail/request`) return json({ data: guardrails })
  if ([`/api/session/${childSession.id}/permission`, `/api/session/${childSession.id}/form`].includes(url.pathname))
    return json({ data: [] })
  if (url.pathname === `/api/session/${sessionID}/todo`) return json({ data: todos })
  if (url.pathname === `/api/session/${sessionID}/subagent`)
    return json({
      data: subagents,
      summary: { total: subagents.length, active: 1, running: 1, waiting: 0 },
      cursor: {},
    })
  if (url.pathname === `/api/session/${sessionID}/skills`) return json({ data: skills })
  if (url.pathname === "/api/shell") return json({ location, data: shells })
  if (url.pathname === "/api/mcp")
    return json({
      location,
      data: [
        { name: "context7", status: { status: "connected" } },
        { name: "filesystem", status: { status: "connected" } },
        { name: "git", status: { status: "connected" } },
      ],
    })
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
        model: { providerID: "anthropic", id: "claude-opus-5" },
        context: { total: 1_464, percent: 56 },
        tokens: { uncachedInput: 1_411, output: 53, reasoning: 0, cacheRead: 220_672, cacheWrite: 4_096 },
        cache: {
          eligible: 220_672,
          hitRatio: 0.71,
          mechanism: "anthropic-cache-control",
          readReported: true,
          writeReported: true,
        },
        requests: {
          logical: 1,
          physical: 1,
          helpers: 0,
          continued: 0,
          fallback: 0,
          tokens: { input: 1_411, output: 53, reasoning: 0, cache: { read: 220_672, write: 4_096 } },
          latestInvalidation: "stable-hit",
        },
      },
    })
  return homeRoute(url, request)
}

const targets = [
  {
    name: "home-189x69",
    width: HOME_WIDTH,
    route: homeRoute,
    settle: "Claude Opus 5",
    stable: [" · main · ", "Build", "Claude Opus 5", "max"],
  },
  {
    name: "home-220x69",
    width: WIDE_WIDTH,
    route: homeRoute,
    settle: "Claude Opus 5",
    stable: [" · main · ", "Build", "Claude Opus 5", "max"],
  },
  {
    name: "session-189x69",
    width: HOME_WIDTH,
    route: sessionRoute,
    args: { sessionID },
    pluginStatus,
    settle: "Claude Opus 5",
    // CACHE now renders only when prefix/read/write details are reported, so it is no longer a
    // stability marker. Order follows the design registration: CONTEXT first, then TODO LIST.
    // PLUGINS is deliberately not a stability marker: it is the last rail section, so whenever the
    // rail renders taller than the design it falls below the fold. Waiting on it turns a graded row
    // difference into a capture crash that freezes the whole board.
    stable: ["SESSION", "CONTEXT", "TODO LIST", "SUBAGENTS", "SHELLS", "MCP"],
    transcript: [
      ["ok", "Inspect cache telemetry callers", "done"],
      ["!!", "guardrail", "write outside workspace", "needs approval"],
      ["◦", "subagent", "docs-sync", "running"],
      ["..", "Fix shared cache accounting", "active"],
    ],
  },
  {
    name: "session-220x69",
    width: WIDE_WIDTH,
    route: sessionRoute,
    args: { sessionID },
    pluginStatus,
    settle: "Claude Opus 5",
    // CACHE now renders only when prefix/read/write details are reported, so it is no longer a
    // stability marker. Order follows the design registration: CONTEXT first, then TODO LIST.
    // PLUGINS is deliberately not a stability marker: it is the last rail section, so whenever the
    // rail renders taller than the design it falls below the fold. Waiting on it turns a graded row
    // difference into a capture crash that freezes the whole board.
    stable: ["SESSION", "CONTEXT", "TODO LIST", "SUBAGENTS", "SHELLS", "MCP"],
  },
]

test("captures composed routes at reference terminal dimensions", async () => {
  const output = path.resolve(import.meta.dir, "../../../../.aphrodite/renders")
  await mkdir(output, { recursive: true })

  for (const target of targets) {
    const lines = await captureRoute({ ...target, height: HEIGHT })
    expect(lines).toHaveLength(HEIGHT)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(target.width)
    await Bun.write(path.join(output, `${target.name}.txt`), lines.join("\n"))
    for (const expected of "transcript" in target && target.transcript ? target.transcript : []) {
      const status = expected.at(-1)
      if (!status) continue
      const line = lines.find((line) => expected.slice(0, -1).every((text) => line.slice(0, 143).includes(text)))
      expect(line?.slice(0, 143)).toContain(status)
    }
    if (target.name === "session-189x69") {
      expectAt(lines, 29, 92, "Where is provider cache telemetry recorded?")
      expectAt(lines, 16, 3, "YCODING")
      expectAt(lines, 23, 3, "ok")
      expectAt(lines, 23, 10, "Inspect cache telemetry callers")
      expectAt(lines, 26, 3, "ok")
      expectAt(lines, 26, 10, "grep")
      expectAt(lines, 26, 15, '"cache_read"')
      expectAt(lines, 6, 3, "!!")
      expectAt(lines, 6, 10, "guardrail")
      expectAt(lines, 6, 20, "· write outside workspace")
      expectAt(lines, 9, 3, "◦")
      expectAt(lines, 9, 10, "subagent")
      expectAt(lines, 9, 19, "docs-sync")
      expectAt(lines, 12, 3, "..")
      expectAt(lines, 12, 10, "Fix shared cache accounting")
      expectAt(lines, 14, 51, "~ compacted · 42 messages → 1.2k tokens")
    }
  }
}, 120_000)

function expectAt(lines: string[], row: number, column: number, text: string) {
  expect(lines[row - 1]?.slice(column, column + text.length)).toBe(text)
}
