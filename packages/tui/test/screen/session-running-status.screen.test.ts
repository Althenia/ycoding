import { expect, test } from "bun:test"
import { directory as defaultDirectory, json } from "../fixture/tui-client"
import { DESIGN_VIEWPORT } from "../viewport"
import { renderScreen } from "./harness"

const sessionID = "ses_0085fc702"
const directory = `${process.env.HOME}/Workspace/Personal/YCoding`
const location = { directory, project: { id: "project", directory } }
const session = {
  id: sessionID,
  title: "Provider cache audit",
  projectID: "project",
  location: { directory },
  agent: "build",
  model: { providerID: "anthropic", id: "claude-opus-5" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 4 },
}

// A drain between steps owns the Session while every projected assistant message is already
// complete. The header used to read that as "ready" and invited a prompt the Session could not take.
test("a running session never reports ready", async () => {
  const screen = await renderScreen({
    ...DESIGN_VIEWPORT,
    args: { sessionID },
    settle: "cooking",
    route: (url) => {
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === "/api/session/active") return json({ data: { [sessionID]: {} } })
      if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
      if (url.pathname === `/api/session/${sessionID}/message`)
        return json({
          data: [
            { id: "msg_user", type: "user", text: "Summarize the session.", time: { created: 1 } },
            {
              id: "msg_assistant",
              type: "assistant",
              agent: "build",
              model: { providerID: "anthropic", id: "claude-opus-5" },
              content: [{ type: "text", text: "Working on it." }],
              time: { created: 2, completed: 3 },
            },
          ],
          cursor: {},
        })
      if (url.pathname === `/api/session/${sessionID}/pending`) return json({ data: [] })
      if (url.pathname === `/api/session/${sessionID}/permission`) return json({ data: [] })
      if (url.pathname === `/api/session/${sessionID}/subagent`) return json({ data: [] })
      if (url.pathname === `/api/session/${sessionID}/todo`) return json({ data: [] })
      if (url.pathname === `/api/session/${sessionID}/skills`) return json({ data: [] })
      if (url.pathname === "/path")
        return json({ home: process.env.HOME, state: "", config: "", worktree: defaultDirectory, directory })
      return undefined
    },
  })

  try {
    const header = screen.lines()[1]
    expect(header).toContain("cooking")
    expect(header).not.toContain("ready")
  } finally {
    await screen.dispose()
  }
}, 60_000)
