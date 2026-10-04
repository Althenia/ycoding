import { expect, test } from "bun:test"
import { json } from "../fixture/tui-client"
import { renderScreen } from "./harness"

const sessionID = "ses_compact_command"
const directory = "/tmp/ycoding/compact-command"
const location = { directory, project: { id: "proj_compact_command", directory } }
const session = {
  id: sessionID,
  title: "Compaction check",
  projectID: location.project.id,
  location: { directory },
  agent: "build",
  model: { providerID: "test", id: "test-model" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
}

test("compaction command displays a backend conflict as an error toast", async () => {
  const compactions: string[] = []
  const screen = await renderScreen({
    width: 100,
    height: 40,
    args: { sessionID },
    settle: "Message YCoding…",
    route: (url, request) => {
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${sessionID}/compact` && request.method === "POST") {
        compactions.push(sessionID)
        return json({ _tag: "ConflictError", message: "Compaction already running" }, { status: 409 })
      }
      if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
      if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [], cursor: {} })
      if (url.pathname === `/api/session/${sessionID}/subagent`)
        return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
      if (/^\/api\/session\/[^/]+\/(pending|permission|form|todo|skills|guardrail\/request)$/.test(url.pathname))
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
      if (url.pathname === "/api/model")
        return json({
          location,
          data: [
            {
              id: "test-model",
              modelID: "test-model",
              providerID: "test",
              name: "Test Model",
              family: "",
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              variants: [],
              time: { released: 0 },
              cost: [],
              status: "active",
              enabled: true,
              limit: { context: 100_000, output: 10_000 },
            },
          ],
        })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "test", name: "Test" }] })
      if (url.pathname === "/api/agent")
        return json({
          location,
          data: [
            {
              id: "build",
              name: "Build",
              request: { headers: {}, body: {} },
              mode: "primary",
              hidden: false,
              permissions: [],
            },
          ],
        })
      return undefined
    },
  })
  try {
    screen.input.pressKey("x", { ctrl: true })
    screen.input.pressKey("c")
    const deadline = Date.now() + 10_000
    while (compactions.length === 0 && Date.now() < deadline) await new Promise<void>((resolve) => setImmediate(resolve))
    expect(compactions).toEqual([sessionID])
    while (!screen.frame().includes("Compaction already running") && Date.now() < deadline)
      await new Promise<void>((resolve) => setImmediate(resolve))
    expect(screen.frame()).toContain("✗ Error")
    expect(screen.frame()).toContain("Compaction already running")
  } finally {
    await screen.dispose()
  }
}, 30_000)
