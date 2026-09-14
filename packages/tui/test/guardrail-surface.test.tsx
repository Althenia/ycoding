/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { YCodingEvent } from "@ycoding-ai/client"
import { json } from "./fixture/tui-client"
import { renderScreen } from "./screen/harness"

const parentID = "ses_guardrail_parent"
const childID = "ses_guardrail_child"
const directory = "/tmp/ycoding/guardrail-surface"
const location = { directory, project: { id: "proj_guardrail_surface", directory } }
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
  projectID: "proj_guardrail_surface",
  location: { directory },
  agent: id === parentID ? "build" : "general",
  model: { providerID: "openai", id: "gpt-5.6-terra", variant: "high" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
})
const parent = session(parentID, "Guardrail surface")
const child = { ...session(childID, "skill-cleanup"), parentID }
const request = {
  id: "grq_surface",
  rootSessionID: parentID,
  sessionID: parentID,
  action: "shell",
  resources: ["rm -rf packages/one packages/two"],
  ruleIDs: ["standard.review.broad-deletion"],
  reason: "Recursive deletion includes the current project, one of its ancestors, or multiple targets",
  standard: true,
}
const childRequest = { ...request, id: "grq_child_surface", sessionID: childID }
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

let listed: Array<typeof request> = []
const replies: unknown[] = []
const repliedTo: string[] = []

async function route(url: URL, init?: Request) {
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: [parent, child], cursor: {} })
  if (url.pathname === `/api/session/${parentID}`) return json({ data: parent })
  if (url.pathname === `/api/session/${childID}`) return json({ data: child })
  if (url.pathname === `/api/session/${parentID}/message` || url.pathname === `/api/session/${childID}/message`)
    return json({ data: [], cursor: {} })
  if (url.pathname === `/api/session/${childID}/guardrail/request`) return json({ data: listed })
  if (url.pathname === `/api/session/${parentID}/guardrail/request`) return json({ data: listed })
  if (url.pathname.endsWith("/guardrail/request/grq_surface/reply") || url.pathname.endsWith("/guardrail/request/grq_child_surface/reply")) {
    repliedTo.push(url.pathname)
    replies.push(await init?.json())
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
      `/api/session/${parentID}/permission`,
      `/api/session/${parentID}/todo`,
      `/api/session/${parentID}/skills`,
      `/api/session/${childID}/pending`,
      `/api/session/${childID}/permission`,
      `/api/session/${childID}/todo`,
      `/api/session/${childID}/skills`,
      "/api/shell",
      "/api/mcp",
      "/api/integration",
      "/api/command",
      "/api/reference",
      "/api/permission/request",
      "/api/form/request",
    ].includes(url.pathname)
  )
    return json({ location, data: [] })
  return undefined
}

async function settle(text: string, sessionID: string) {
  return renderScreen({ width: 120, height: 40, args: { sessionID }, route, settle: text })
}

async function waitForFrameText(screen: { frame(): string }, text: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (screen.frame().includes(text)) return
    await Bun.sleep(20)
  }
  expect(screen.frame()).toContain(text)
}

const asked = (data: typeof request, id: string) =>
  ({
    id,
    type: "guardrail.asked",
    created: 3,
    data,
  }) satisfies YCodingEvent

test("surfaces a pending root guardrail review from the durable list", async () => {
  listed = [request]
  const screen = await settle("Guardrail blocked", parentID)
  try {
    expect(screen.frame()).toContain("Guardrail blocked")
    expect(screen.frame()).toContain("rm -rf packages/one packages/two")
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("surfaces a pending root guardrail review that arrives as a live event", async () => {
  listed = []
  const screen = await settle("Message YCoding…", parentID)
  try {
    expect(screen.frame()).not.toContain("Guardrail blocked")
    await screen.waitForEventStream()
    screen.events.emit(asked(request, "evt_root_asked"))
    await waitForFrameText(screen, "Guardrail blocked")
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("surfaces a pending subagent guardrail review from the durable list", async () => {
  listed = [childRequest]
  const screen = await settle("SUBAGENT ECONOMICS", childID)
  try {
    await waitForFrameText(screen, "Guardrail blocked")
    expect(screen.frame()).toContain("Subagent ses_guardrail_child in ses_guardrail_parent")
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("surfaces a pending subagent guardrail review that arrives as a live event", async () => {
  listed = []
  const screen = await settle("SUBAGENT ECONOMICS", childID)
  try {
    expect(screen.frame()).not.toContain("Guardrail blocked")
    await screen.waitForEventStream()
    screen.events.emit(asked(childRequest, "evt_child_asked"))
    await waitForFrameText(screen, "Guardrail blocked")
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("renders a transcript row for a subagent review and replies against the root session", async () => {
  listed = [childRequest]
  replies.length = 0
  repliedTo.length = 0
  const screen = await settle("SUBAGENT ECONOMICS", childID)
  try {
    await waitForFrameText(screen, "Guardrail blocked")
    expect(screen.frame()).toContain("rm -rf packages/one packages/two")
    // The only surface for a subagent review is the transcript row plus this prompt; without it the
    // subagent blocks invisibly until the Session is interrupted. Option selection itself is covered
    // by the component suites, so this asserts the default reply and its root-Session address.
    await waitForFrameText(screen, "Allow for this session")
    screen.input.pressEnter()
    for (let attempt = 0; attempt < 100 && replies.length === 0; attempt++) await Bun.sleep(20)
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ reply: "reject" })
    expect(repliedTo).toEqual([`/api/session/${parentID}/guardrail/request/grq_child_surface/reply`])
  } finally {
    await screen.dispose()
  }
}, 30_000)
