/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { json } from "./fixture/tui-client"
import { renderScreen } from "./screen/harness"

const sessionID = "ses_composer_blocked_queued"
const directory = "/tmp/ycoding/composer-blocked-queued"
const location = { directory, project: { id: "proj_composer_blocked_queued", directory } }
const session = {
  id: sessionID,
  title: "Composer blocked queued",
  projectID: "proj_composer_blocked_queued",
  location: { directory },
  agent: "build",
  model: { providerID: "openai", id: "gpt-5.6-terra", variant: "high" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
}
const permission = {
  id: "permission_blocked_reason",
  sessionID,
  action: "shell",
  resources: ["git status"],
  metadata: {},
}
const queued = [
  {
    id: "msg_user_queued",
    sessionID,
    admittedSeq: 5,
    timeCreated: 5,
    type: "user",
    data: { text: "Held input text" },
    delivery: "queue",
  },
]

function base(url: URL) {
  if (url.pathname === "/api/fs/list") return json({ location, data: [] })
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
  if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}/subagent`)
    return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
  if (url.pathname === `/api/session/${sessionID}/diagnostics`)
    return json({
      data: {
        model: session.model,
        context: { total: 0, percent: 0 },
        tokens: { uncachedInput: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        cache: { eligible: 0, hitRatio: 0.61, mechanism: "unreported", readReported: false, writeReported: false },
        requests: { logical: 0, physical: 0, helpers: 0, continued: 0, fallback: 0, tokens: session.tokens },
      },
    })
  if (url.pathname === `/api/session/${sessionID}/usage`)
    return json({
      data: {
        logical: 0,
        physical: 0,
        helpers: 0,
        continued: 0,
        fallback: 0,
        cost: 0,
        tokens: session.tokens,
      },
    })
  if (
    [
      `/api/session/${sessionID}/todo`,
      `/api/session/${sessionID}/skills`,
      `/api/session/${sessionID}/guardrail/request`,
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
  if (url.pathname === "/api/vcs/branch") return json({ location, data: { current: "main", default: "main" } })
  if (url.pathname === "/api/model")
    return json({
      location,
      data: [
        {
          id: session.model.id,
          modelID: session.model.id,
          providerID: session.model.providerID,
          name: "GPT 5.6 Terra",
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          variants: [{ id: session.model.variant }, { id: "low" }],
          time: { released: 0 },
          cost: [],
          status: "active",
          enabled: true,
          limit: { context: 200_000, output: 32_000 },
        },
      ],
    })
  if (url.pathname === "/api/provider") return json({ location, data: [{ id: "openai", name: "OpenAI" }] })
  if (url.pathname === "/api/agent")
    return json({
      location,
      data: [{ id: "build", name: "Build", request: { headers: {}, body: {} }, mode: "primary", hidden: false, permissions: [] }],
    })
  return undefined
}

async function blockedRoute(url: URL) {
  if (url.pathname === `/api/session/${sessionID}/permission`) return json({ data: [permission] })
  if (url.pathname === `/api/session/${sessionID}/pending`) return json({ data: [] })
  if (url.pathname === "/api/shell") return json({ location, data: [] })
  return base(url)
}

async function queuedRoute(url: URL) {
  if (url.pathname === `/api/session/${sessionID}/permission`) return json({ data: [] })
  if (url.pathname === `/api/session/${sessionID}/pending`) return json({ data: queued })
  if (url.pathname === "/api/shell") return json({ location, data: [] })
  return base(url)
}

async function shellQueuedRoute(url: URL) {
  if (url.pathname === `/api/session/${sessionID}/permission`) return json({ data: [] })
  if (url.pathname === `/api/session/${sessionID}/pending`) return json({ data: queued })
  if (url.pathname === "/api/shell")
    return json({
      location,
      data: [
        {
          id: "sh_queued",
          command: "bun test",
          status: "running",
          cwd: directory,
          shell: "bash",
          file: "/tmp/sh_queued",
          pid: 1234,
          metadata: { sessionID },
          time: { started: Date.now() },
        },
      ],
    })
  return base(url)
}

async function waitForFrameText(screen: { frame(): string }, text: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (screen.frame().includes(text)) return
    await Bun.sleep(20)
  }
  expect(screen.frame()).toContain(text)
}

test("names the permission blocker inline when it replaces the composer", async () => {
  const screen = await renderScreen({
    width: 100,
    height: 40,
    args: { sessionID },
    route: blockedRoute,
    settle: "Permission required",
  })
  try {
    await waitForFrameText(screen, "Composer paused: permission review")
    expect(screen.frame()).toContain("Composer paused: permission review")
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("shows a queued notice for durable pending rows while idle without clearing the draft", async () => {
  const screen = await renderScreen({
    width: 100,
    height: 40,
    args: { sessionID },
    route: queuedRoute,
    settle: "Message YCoding",
  })
  try {
    await waitForFrameText(screen, "Queued")
    const promptRow = screen.lines().findIndex((line) => line.includes("Message YCoding"))
    await screen.mouse.click(3, promptRow)
    await screen.input.typeText("keep my draft")
    await waitForFrameText(screen, "keep my draft")
    expect(screen.frame()).toContain("Queued")
    expect(screen.frame()).toContain("keep my draft")
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("shows a queued notice while a session shell is running", async () => {
  const screen = await renderScreen({
    width: 100,
    height: 40,
    args: { sessionID },
    route: shellQueuedRoute,
    settle: "Message YCoding",
  })
  try {
    await waitForFrameText(screen, "Queued")
    expect(screen.frame()).toContain("Queued")
  } finally {
    await screen.dispose()
  }
}, 30_000)
