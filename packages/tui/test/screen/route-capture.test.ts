import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { json, type FetchHandler } from "../fixture/tui-client"
import { captureRoute } from "./capture"

const HEIGHT = 69
const HOME_WIDTH = 189
const WIDE_WIDTH = 220
const directory = "/tmp/ycoding/route-capture"
const location = { directory, project: { id: "proj_route_capture", directory } }
const sessionID = "ses_route_capture"
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
  cost: 9.08,
  tokens: { input: 1_411, output: 53, reasoning: 0, cache: { read: 220_672, write: 4_096 } },
  time: { created: 1, updated: 4 },
}
const childSession = {
  ...session,
  id: "ses_route_capture_child",
  parentID: sessionID,
  title: "Inspect rail data",
  cost: 1.24,
}
const todo = { content: "Verify the active-session rail", status: "in_progress" as const, priority: "high" as const }
const subagent = {
  sessionID: "ses_route_capture_child",
  parentID: sessionID,
  description: "Inspect rail data",
  agent: "review",
  model: { providerID: "anthropic", id: "claude-opus-5" },
  background: true,
  state: "running" as const,
  revision: 1,
  time: { created: 1, updated: 4 },
}
const shell = {
  id: "sh_route_capture",
  status: "running" as const,
  command: "bun test",
  cwd: directory,
  shell: "/bin/sh",
  file: "/tmp/ycoding-route-capture-shell",
  metadata: { sessionID },
  time: { started: 1 },
}
const skill = {
  id: "review",
  name: "Code Review",
  activatedBy: "tool" as const,
  activationMessageID: "msg_skill",
  content: "Review the active-session rail.",
  conflicts: [],
  declarations: {},
  state: "active" as const,
}
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
  if (url.pathname === `/api/session/${sessionID}/message`)
    return json({
      data: [
        {
          id: "msg_assistant",
          type: "assistant",
          agent: "build",
          model: { providerID: "anthropic", id: "claude-opus-5", variant: "max" },
          content: [{ type: "text", text: "Two places record it." }],
          time: { created: 2, completed: 3 },
        },
        { id: "msg_user", type: "user", text: "Where is provider cache telemetry recorded?", time: { created: 1 } },
      ],
      cursor: {},
    })
  if (
    [
      `/api/session/${sessionID}/pending`,
      `/api/session/${sessionID}/permission`,
      `/api/session/${sessionID}/guardrail/request`,
    ].includes(url.pathname)
  )
    return json({ data: [] })
  if ([`/api/session/${childSession.id}/permission`, `/api/session/${childSession.id}/form`].includes(url.pathname))
    return json({ data: [] })
  if (url.pathname === `/api/session/${sessionID}/todo`) return json({ data: [todo] })
  if (url.pathname === `/api/session/${sessionID}/subagent`) return json({ data: [subagent] })
  if (url.pathname === `/api/session/${sessionID}/skills`) return json({ data: [skill] })
  if (url.pathname === "/api/shell") return json({ location, data: [shell] })
  if (url.pathname === "/api/mcp") return json({ location, data: [{ name: "context7", status: { status: "connected" } }] })
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
    stable: [" · main · ", "Build · Claude Opus 5"],
  },
  {
    name: "home-220x69",
    width: WIDE_WIDTH,
    route: homeRoute,
    settle: "Claude Opus 5",
    stable: [" · main · ", "Build · Claude Opus 5"],
  },
  {
    name: "session-189x69",
    width: HOME_WIDTH,
    route: sessionRoute,
    args: { sessionID },
    pluginStatus,
    settle: "Claude Opus 5",
    stable: ["SESSION", "TODO LIST", "SUBAGENTS", "SHELLS", "SKILLS", "MCP", "PLUGINS", "CACHE"],
  },
  {
    name: "session-220x69",
    width: WIDE_WIDTH,
    route: sessionRoute,
    args: { sessionID },
    pluginStatus,
    settle: "Claude Opus 5",
    stable: ["SESSION", "TODO LIST", "SUBAGENTS", "SHELLS", "SKILLS", "MCP", "PLUGINS", "CACHE"],
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
  }
}, 120_000)
