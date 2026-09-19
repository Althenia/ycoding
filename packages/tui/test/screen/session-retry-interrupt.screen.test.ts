import { expect, test } from "bun:test"
import type { YCodingEvent } from "@ycoding-ai/client"
import { directory as defaultDirectory, json } from "../fixture/tui-client"
import { DESIGN_VIEWPORT } from "../viewport"
import { renderScreen } from "./harness"

const sessionID = "ses_retry_interrupt"
const directory = `${process.env.HOME}/Workspace/Personal/YCoding`
const location = { directory, project: { id: "project", directory } }
const session = {
  id: sessionID,
  title: "Retry interrupt",
  projectID: "project",
  location: { directory },
  agent: "build",
  model: { providerID: "anthropic", id: "claude-opus-5" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 4 },
}

/**
 * A step interrupted during provider retry backoff keeps its assistant row open until the next
 * prompt, because the retry attempt already published `Step.Started`. Reading that open row as
 * activity pinned the header at "cooking" for a Session that had already settled.
 */
test("an interrupted retry does not keep the header cooking", async () => {
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
            { id: "msg_user", type: "user", text: "Retry then interrupt.", time: { created: 1 } },
            {
              id: "msg_assistant",
              type: "assistant",
              agent: "build",
              model: { providerID: "anthropic", id: "claude-opus-5" },
              content: [],
              retry: { attempt: 2, at: Date.now() + 30_000, error: { message: "Provider unavailable" } },
              time: { created: 2 },
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
    expect(screen.lines()[1]).toContain("retry")

    // The user interrupts while the retry is scheduled, and the drain settles as interrupted.
    screen.events.emit({
      id: "evt_retry_interrupted",
      created: 5,
      type: "session.execution.interrupted",
      data: { sessionID, reason: "user" },
    } as YCodingEvent)

    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      const header = screen.lines()[1] ?? ""
      if (header.includes("ready")) break
      await Bun.sleep(20)
    }

    const header = screen.lines()[1] ?? ""
    expect(header).not.toContain("cooking")
    expect(header).toContain("ready")
  } finally {
    await screen.dispose()
  }
}, 60_000)
