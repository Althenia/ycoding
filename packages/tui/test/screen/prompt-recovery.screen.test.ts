import { expect, test } from "bun:test"
import { json, type FetchHandler } from "../fixture/tui-client"
import { renderScreen } from "./harness"

// Distinct Location and Session from every other screen suite so the shared module mocks
// installed by renderScreen cannot collide with a concurrent lane.
const sessionID = "ses_prompt_recovery"
const directory = "/tmp/ycoding/prompt-recovery"
const location = { directory, project: { id: "proj_prompt_recovery", directory } }
const session = {
  id: sessionID,
  title: "Prompt recovery",
  projectID: "proj_prompt_recovery",
  location: { directory },
  agent: "build",
  model: { providerID: "openai", id: "gpt-5.6-terra", variant: "high" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
}

let promptRequests: Array<{ id: string; text: string; resume?: boolean }> = []
let failFirstPrompt = false

function resetFixture() {
  promptRequests = []
  failFirstPrompt = true
}

const route: FetchHandler = async (url, request) => {
  if (url.pathname === "/api/fs/list") return json({ location, data: [] })
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
  if (url.pathname === `/api/session/${sessionID}/model` && request.method === "POST")
    return new Response(null, { status: 204 })
  if (url.pathname === `/api/session/${sessionID}/prompt` && request.method === "POST") {
    const body = (await request.json()) as { id: string; text: string; resume?: boolean }
    promptRequests.push(body)
    if (failFirstPrompt) {
      failFirstPrompt = false
      return json({ message: "prompt admission failed" }, { status: 500 })
    }
    return json({
      data: {
        id: body.id,
        sessionID,
        admittedSeq: promptRequests.length,
        timeCreated: Date.now(),
        type: "user",
        data: { text: body.text },
        delivery: "steer",
      },
    })
  }
  if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}/subagent`)
    return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
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
        model: session.model,
        context: { total: 0, percent: 0 },
        tokens: { uncachedInput: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        cache: { eligible: 0, hitRatio: 0.61, mechanism: "unreported", readReported: false, writeReported: false },
        requests: { logical: 0, physical: 0, helpers: 0, continued: 0, fallback: 0, tokens: session.tokens },
      },
    })
  if (url.pathname === `/api/session/${sessionID}/usage`)
    return json({
      data: { logical: 0, physical: 0, helpers: 0, continued: 0, fallback: 0, cost: 0, tokens: session.tokens },
    })
  if (
    [
      `/api/session/${sessionID}/pending`,
      `/api/session/${sessionID}/permission`,
      `/api/session/${sessionID}/todo`,
      `/api/session/${sessionID}/skills`,
      `/api/session/${sessionID}/guardrail/request`,
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
  if (url.pathname === "/api/mcp/resource") return json({ location, data: { resources: [], templates: [] } })
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
  if (url.pathname === "/api/skill") return json({ location, data: [] })
  if (url.pathname === "/api/agent")
    return json({
      location,
      data: [
        { id: "build", name: "Build", request: { headers: {}, body: {} }, mode: "primary", hidden: false, permissions: [] },
      ],
    })
  return undefined
}

async function waitFor(predicate: () => boolean, label: string) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (predicate()) return
    await Bun.sleep(20)
  }
  throw new Error(`timed out waiting for ${label}; prompts=${JSON.stringify(promptRequests)}`)
}

async function focusComposer(screen: Awaited<ReturnType<typeof renderScreen>>) {
  const promptRow = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
  expect(promptRow).toBeGreaterThan(-1)
  await screen.mouse.click(3, promptRow)
}

test("a changed draft sends after a failed admission instead of blocking the composer", async () => {
  resetFixture()
  const screen = await renderScreen({ width: 100, height: 69, args: { sessionID }, route, settle: "Message YCoding…" })
  try {
    await focusComposer(screen)
    await screen.input.typeText("first draft admission")
    await screen.input.pressEnter()
    // The 500 surfaces as the admission failure feedback, proving the send really failed.
    await waitFor(
      () => screen.frame().includes("Checking whether sent · retry keeps the same prompt ID"),
      "admission failure feedback",
    )
    expect(promptRequests).toHaveLength(1)
    expect(promptRequests[0]?.text).toBe("first draft admission")

    await screen.input.typeText(" plus changed tail")
    await screen.input.pressEnter()
    // Pre-fix the composer rejects the changed draft with unresolved-send feedback and issues
    // no request; the second admission request is the behavior under test.
    await waitFor(
      () =>
        promptRequests.length >= 3 ||
        promptRequests.length >= 2 ||
        screen.frame().includes("Previous send is unresolved"),
      "the changed draft to reach prompt admission",
    )
    expect(screen.frame()).not.toContain("Previous send is unresolved")
    expect(promptRequests.length).toBeGreaterThanOrEqual(2)
    expect(promptRequests[1]?.text).toBe("first draft admission plus changed tail")
    // A changed draft allocates fresh prompt identities instead of reusing the failed ones.
    expect(promptRequests[1]?.id).not.toBe(promptRequests[0]?.id)
    await waitFor(() => screen.frame().includes("Message YCoding…"), "the composer to clear after success")
    expect(promptRequests.map((request) => request.text)).toEqual([
      "first draft admission",
      "first draft admission plus changed tail",
      "first draft admission plus changed tail",
    ])
    expect(promptRequests.map((request) => request.resume)).toEqual([false, false, true])
    expect(promptRequests[1].id).toBe(promptRequests[2].id)
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("an unchanged draft retries with the retained prompt identity", async () => {
  resetFixture()
  const screen = await renderScreen({ width: 100, height: 69, args: { sessionID }, route, settle: "Message YCoding…" })
  try {
    await focusComposer(screen)
    await screen.input.typeText("stable identity retry")
    await screen.input.pressEnter()
    await waitFor(
      () => screen.frame().includes("Checking whether sent · retry keeps the same prompt ID"),
      "admission failure feedback",
    )
    expect(promptRequests).toHaveLength(1)

    await screen.input.pressEnter()
    await waitFor(
      () => promptRequests.length >= 3 && screen.frame().includes("Message YCoding…"),
      "the exact retry to complete",
    )
    expect(promptRequests.map((request) => request.text)).toEqual([
      "stable identity retry",
      "stable identity retry",
      "stable identity retry",
    ])
    expect(new Set(promptRequests.map((request) => request.id)).size).toBe(1)
    expect(promptRequests.map((request) => request.resume)).toEqual([false, false, true])
    expect(screen.frame()).not.toContain("Previous send is unresolved")
  } finally {
    await screen.dispose()
  }
}, 30_000)
