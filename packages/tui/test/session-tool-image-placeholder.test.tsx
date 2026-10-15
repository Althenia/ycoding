import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@ycoding-ai/client"
import { json, sessionSnapshot } from "./fixture/tui-client"
import { renderScreen } from "./screen/harness"

const sessionID = "ses_image_placeholder"
const directory = "/tmp/ycoding/image-placeholder"
const location = { directory, project: { id: "proj_image_placeholder", directory } }
const model = { providerID: "openai", id: "fixture" }
const placeholder = "[Image removed from stored history: image/png, 2.9 KiB]"
const session = {
  id: sessionID,
  title: "Removed image",
  projectID: location.project.id,
  location: { directory },
  agent: "build",
  model,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
}
const messages: SessionMessageInfo[] = [
  { id: "msg_image_user", type: "user", text: "Capture the window", time: { created: 1 } },
  {
    id: "msg_image_assistant",
    type: "assistant",
    agent: "build",
    model,
    content: [
      {
        type: "tool",
        id: "call_capture_image",
        name: "computer",
        state: {
          status: "completed",
          input: { action: "desktop.capture", platform: "macos" },
          structured: {},
          content: [{ type: "text", text: placeholder }],
        },
        time: { created: 2, ran: 2, completed: 3 },
      },
    ],
    finish: "tool-calls",
    time: { created: 2, completed: 3 },
  },
]

async function route(url: URL) {
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
  if (url.pathname === `/api/session/${sessionID}/snapshot`) return sessionSnapshot(sessionID, messages, { session })
  if (url.pathname === `/api/session/${sessionID}/subagent`)
    return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
  if (["pending", "permission", "todo", "skills"].some((resource) => url.pathname === `/api/session/${sessionID}/${resource}`))
    return json({ data: [] })
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
  if (url.pathname === "/api/agent")
    return json({
      location,
      data: [
        { id: "build", name: "Build", request: { headers: {}, body: {} }, mode: "primary", hidden: false, permissions: [] },
      ],
    })
  if (url.pathname === "/api/model")
    return json({
      location,
      data: [
        {
          ...model,
          modelID: model.id,
          name: "Fixture",
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          variants: [],
          time: { released: 0 },
          cost: [],
          status: "active",
          enabled: true,
          limit: { context: 200000, output: 32000 },
        },
      ],
    })
  return undefined
}

test("renders the stored-history placeholder that replaced a pruned tool image in the tool details", async () => {
  const screen = await renderScreen({
    width: 100,
    height: 30,
    args: { sessionID },
    route,
    config: { animations: false },
    settle: "computer [action=desktop.capture",
  })
  try {
    expect(screen.frame()).not.toContain(placeholder)
    await screen.mouse.click(12, screen.lines().findIndex((line) => line.includes("computer [action=desktop.capture")))
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline && !screen.frame().includes(placeholder)) {
      await screen.renderOnce()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    expect(screen.frame()).toContain(placeholder)
    expect(screen.frame()).not.toContain("data:image")
  } finally {
    await screen.dispose()
  }
}, 30_000)
