/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { YCodingEvent } from "@ycoding-ai/client"
import { json } from "./fixture/tui-client"
import { renderScreen } from "./screen/harness"

const parentID = "ses_block_parent"
const childID = "ses_block_child"
const directory = "/tmp/ycoding/blocked-surface"
const location = { directory, project: { id: "proj_blocked_surface", directory } }
const model = {
  id: "gpt-5.6-terra",
  modelID: "gpt-5.6-terra",
  providerID: "openai",
  name: "GPT 5.6 Terra",
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  variants: [{ id: "high" }],
  time: { released: 0 },
  cost: [],
  status: "active",
  enabled: true,
  limit: { context: 200_000, output: 32_000 },
}
const session = (id: string, title: string) => ({
  id,
  title,
  projectID: "proj_blocked_surface",
  location: { directory },
  agent: id === parentID ? "build" : "general",
  model: { providerID: "openai", id: "gpt-5.6-terra", variant: "high" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
})
const parent = session(parentID, "Blocked surface")
const child = { ...session(childID, "skill-cleanup"), parentID }
const childPermission = {
  id: "per_child_shell",
  sessionID: childID,
  action: "atlassian-rovo_updateConfluenceContent",
  resources: ["*"],
  metadata: {},
  source: { type: "tool" as const, messageID: "msg_child", callID: "call_child" },
}
const task = {
  sessionID: childID,
  parentID,
  description: "skill-cleanup",
  agent: "general",
  model: { providerID: "openai", id: "gpt-5.6-terra", variant: "high" },
  background: true,
  state: "running",
  revision: 1,
  time: { created: 1, updated: 2 },
}

let childPermissions: Array<typeof childPermission> = []
const repliedTo: string[] = []

async function route(url: URL) {
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: [parent, child], cursor: {} })
  if (url.pathname === `/api/session/${parentID}`) return json({ data: parent })
  if (url.pathname === `/api/session/${childID}`) return json({ data: child })
  if (url.pathname === `/api/session/${parentID}/message` || url.pathname === `/api/session/${childID}/message`)
    return json({ data: [], cursor: {} })
  if (url.pathname === `/api/session/${childID}/permission`) return json({ location, data: childPermissions })
  if (url.pathname === `/api/session/${parentID}/permission`) return json({ location, data: [] })
  if (url.pathname.endsWith(`/permission/${childPermission.id}/reply`)) {
    repliedTo.push(url.pathname)
    return new Response(null, { status: 204 })
  }
  if ([parentID, childID].some((id) => url.pathname === `/api/session/${id}/subagent`))
    return json({ data: [task], summary: { total: 1, active: 1, running: 1, waiting: 0 }, cursor: {} })
  if (url.pathname === `/api/session/${parentID}/diagnostics` || url.pathname === `/api/session/${childID}/diagnostics`)
    return json({
      data: {
        model: parent.model,
        context: { total: 0, percent: 0 },
        tokens: { uncachedInput: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        cache: { eligible: 0, hitRatio: 0, mechanism: "unreported", readReported: false, writeReported: false },
        requests: { logical: 0, physical: 0, helpers: 0, continued: 0, fallback: 0, tokens: parent.tokens },
      },
    })
  if (url.pathname === `/api/session/${parentID}/guardrail` || url.pathname === `/api/session/${childID}/guardrail`)
    return json({
      data: { rootSessionID: parentID, profile: "standard", customRules: 0, approvals: 0, blocked: 0, counters: [], invalidFiles: [] },
    })
  if (url.pathname === "/api/model") return json({ location, data: [model] })
  if (url.pathname === "/api/provider") return json({ location, data: [{ id: "openai", name: "OpenAI" }] })
  if (url.pathname === "/api/agent")
    return json({
      location,
      data: [
        { id: "build", name: "Build", request: { headers: {}, body: {} }, mode: "primary", hidden: false, permissions: [] },
        { id: "general", name: "General", request: { headers: {}, body: {} }, mode: "subagent", hidden: false, permissions: [] },
      ],
    })
  if (url.pathname === "/api/skill") return json({ location, data: [] })
  if (url.pathname === "/api/mcp/resource") return json({ location, data: { resources: [], templates: [] } })
  if (url.pathname === "/api/vcs/branch") return json({ location, data: { current: "main", default: "main" } })
  if (url.pathname === "/path") return json({ home: process.env.HOME, state: "", config: "", worktree: directory, directory })
  if (
    [
      `/api/session/${parentID}/pending`,
      `/api/session/${parentID}/todo`,
      `/api/session/${parentID}/skills`,
      `/api/session/${parentID}/guardrail/request`,
      `/api/session/${childID}/pending`,
      `/api/session/${childID}/todo`,
      `/api/session/${childID}/skills`,
      `/api/session/${childID}/guardrail/request`,
      "/api/shell",
      "/api/mcp",
      "/api/integration",
      "/api/command",
      "/api/reference",
      "/api/form/request",
    ].includes(url.pathname)
  )
    return json({ location, data: [] })
  if (url.pathname === "/api/permission/request") return json({ location, data: childPermissions })
  return undefined
}

async function waitForFrameText(screen: { frame(): string }, text: string) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (screen.frame().includes(text)) return
    await Bun.sleep(20)
  }
  expect(screen.frame()).toContain(text)
}

test("surfaces a subagent's own pending permission in the subagent view", async () => {
  childPermissions = [childPermission]
  const screen = await renderScreen({
    width: 120,
    height: 40,
    args: { sessionID: childID },
    route,
    settle: "SUBAGENT ECONOMICS",
  })
  try {
    await waitForFrameText(screen, "Permission required")
    expect(screen.frame()).toContain("atlassian-rovo_updateConfluenceContent")
    screen.input.pressEnter()
    for (let attempt = 0; attempt < 150 && repliedTo.length === 0; attempt++) await Bun.sleep(20)
    expect(repliedTo).toEqual([`/api/session/${childID}/permission/per_child_shell/reply`])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("surfaces a live subagent permission in the subagent view", async () => {
  childPermissions = []
  const screen = await renderScreen({
    width: 120,
    height: 40,
    args: { sessionID: childID },
    route,
    settle: "SUBAGENT ECONOMICS",
  })
  try {
    await screen.waitForEventStream()
    screen.events.emit({
      id: "evt_child_permission",
      type: "permission.v2.asked",
      created: Date.now(),
      data: childPermission,
    } satisfies YCodingEvent)
    await waitForFrameText(screen, "Permission required")
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("shows the download side-effect warning on selected Chrome site approval", async () => {
  childPermissions = [{
    ...childPermission,
    id: "per_chrome_site",
    action: "browser_interact",
    resources: ["https://example.test/form"],
    metadata: { mode: "selected", incidentalDownloads: true, site: "https://example.test" },
  }]
  const screen = await renderScreen({
    width: 120,
    height: 40,
    args: { sessionID: childID },
    route,
    settle: "SUBAGENT ECONOMICS",
  })
  try {
    await waitForFrameText(screen, "Permission required")
    expect(screen.frame()).toContain("example.test")
    expect(screen.frame()).toContain("downloads")
  } finally {
    await screen.dispose()
  }
}, 30_000)
