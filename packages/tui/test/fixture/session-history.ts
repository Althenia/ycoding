import type { SessionMessageInfo } from "@ycoding-ai/client"
import { json, sessionSnapshot } from "./tui-client"

export function sessionHistoryFixture(count: number) {
  const sessionID = "ses_performance"
  const directory = "/tmp/ycoding-tui-perf/workspace"
  const location = { directory, project: { id: "proj_performance", directory } }
  const session = {
    id: sessionID,
    title: "Synthetic performance session",
    projectID: location.project.id,
    location: { directory },
    agent: "build",
    model: { providerID: "fixture", id: "fixture" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 },
  }
  const messages = Array.from(
    { length: count },
    (_, index): SessionMessageInfo =>
      index % 2 === 0
        ? {
            id: `msg_${String(index).padStart(6, "0")}`,
            type: "user",
            text: `Inspect synthetic module ${index}`,
            time: { created: index + 1 },
          }
        : {
            id: `msg_${String(index).padStart(6, "0")}`,
            type: "assistant",
            agent: "build",
            model: session.model,
            content: [
              {
                type: "text",
                text: `${"Verified fixture text with **typed boundaries** and `code`.\n".repeat(20)}\nSynthetic response ${index}`,
              },
            ],
            finish: "stop",
            time: { created: index + 1, completed: index + 2 },
          },
  )
  const requests: string[] = []
  const snapshotQueries: string[] = []
  const gate = Promise.withResolvers<void>()
  return {
    sessionID,
    messages,
    requests,
    snapshotQueries,
    release: gate.resolve,
    route: async (url: URL, request: Request) => {
      requests.push(`${request.method} ${url.pathname}`)
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
      if (url.pathname === `/api/session/${sessionID}/message`) {
        await gate.promise
        return json({ data: messages, cursor: {} })
      }
      if (url.pathname === `/api/session/${sessionID}/snapshot`) {
        snapshotQueries.push(url.search)
        await gate.promise
        const before = url.searchParams.get("before")
        const end = before ? Number(before.replace("fixture_cursor_", "")) : messages.length
        const start = Math.max(0, end - Number(url.searchParams.get("limit") ?? 100))
        return sessionSnapshot(sessionID, messages.slice(start, end), { session, before: start > 0 ? `fixture_cursor_${start}` : undefined })
      }
      if (["/api/location", "/api/fs/list", "/api/agent", "/api/model", "/api/provider"].includes(url.pathname)) {
        if (url.pathname === "/api/location") return json(location)
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
        if (url.pathname === "/api/provider") return json({ location, data: [{ id: "fixture", name: "Fixture" }] })
        if (url.pathname === "/api/model")
          return json({
            location,
            data: [
              {
                id: "fixture",
                modelID: "fixture",
                providerID: "fixture",
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
        return json({ location, data: [] })
      }
      if (url.pathname === `/api/session/${sessionID}/subagent`)
        return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
      if (
        ["pending", "permission", "todo", "skills"].some(
          (suffix) => url.pathname === `/api/session/${sessionID}/${suffix}`,
        )
      )
        return json({ data: [], cursor: {} })
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
      return undefined
    },
  }
}
