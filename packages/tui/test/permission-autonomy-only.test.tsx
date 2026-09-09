/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { json } from "./fixture/tui-client"
import { renderScreen } from "./screen/harness"

test("legacy local auto state cannot approve a permission outside durable autonomy", async () => {
  const sessionID = "ses_permission_autonomy_only"
  const directory = "/tmp/ycoding/permission-autonomy-only"
  const location = { directory, project: { id: "proj_permission_autonomy_only", directory } }
  const session = {
    id: sessionID,
    title: "Permission autonomy",
    projectID: location.project.id,
    location: { directory },
    agent: "god",
    model: { providerID: "openai", id: "gpt-5.6-terra", variant: "medium" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 },
  }
  const permission = { id: "permission_autonomy_only", sessionID, action: "shell", resources: ["git status"], metadata: {} }
  const replies: unknown[] = []
  const replied = Promise.withResolvers<void>()
  const screen = await renderScreen({
    width: 100,
    height: 40,
    args: { sessionID, ...{ auto: true } },
    settle: "Permission required",
    route: async (url, request) => {
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
      if (url.pathname === `/api/session/${sessionID}/permission`) return json({ data: [permission] })
      if (request.method === "POST" && url.pathname.includes("permission")) {
        replies.push(await request.json())
        replied.resolve()
        return new Response(null, { status: 204 })
      }
      if (["message", "pending", "subagent", "todo", "skills"].some((part) => url.pathname === `/api/session/${sessionID}/${part}`))
        return json({ data: [], cursor: {} })
      if (url.pathname === `/api/session/${sessionID}/guardrail`)
        return json({ data: { rootSessionID: sessionID, profile: "standard", customRules: 0, approvals: 0, blocked: 0, counters: [], invalidFiles: [] } })
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "god", name: "God", request: { headers: {}, body: {} }, mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "openai", name: "OpenAI" }] })
      if (url.pathname === "/api/model")
        return json({ location, data: [{ id: session.model.id, modelID: session.model.id, providerID: "openai", name: "Terra", capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [{ id: "medium" }], time: { released: 0 }, cost: [], status: "active", enabled: true, limit: { context: 200_000, output: 32_000 } }] })
      return undefined
    },
  })
  try {
    expect(screen.frame()).toContain("Permission required")
    expect(replies).toEqual([])
    screen.input.pressEnter()
    await replied.promise
    expect(replies).toEqual([{ reply: "once" }])
  } finally {
    await screen.dispose()
  }
}, 30_000)
