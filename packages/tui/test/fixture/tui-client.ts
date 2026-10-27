import { YCoding, type YCodingEvent, type SessionInfo, type SessionProjection } from "@ycoding-ai/client"

export const worktree = "/tmp/ycoding"
export const directory = `${worktree}/packages/tui`

export function json(data: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers)
  if (!headers.has("content-type")) headers.set("content-type", "application/json")
  return new Response(JSON.stringify(data), {
    ...init,
    headers,
  })
}

export function sessionSnapshot(
  sessionID: string,
  messages: readonly unknown[],
  options: Partial<Pick<SessionProjection, "before" | "sourceEpoch" | "watermark">> & { session?: Partial<SessionInfo> } = {},
) {
  return json({
    sourceEpoch: "test_epoch",
    watermark: { type: "log.synced", aggregateID: sessionID },
    ...options,
    session: {
      id: sessionID,
      projectID: "proj_test",
      title: "Fixture Session",
      agent: "build",
      location: { directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
      ...options.session,
    } satisfies SessionInfo,
    messages,
  })
}

export function createEventStream() {
  const encoder = new TextEncoder()
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const pending: Uint8Array[] = []
  const response = (
    controllers: Set<ReadableStreamDefaultController<Uint8Array>>,
    queued: Uint8Array[],
    initial?: unknown,
  ) => {
    let current: ReadableStreamDefaultController<Uint8Array> | undefined
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          current = controller
          controllers.add(controller)
          if (initial) controller.enqueue(encoder.encode(`data: ${JSON.stringify(initial)}\n\n`))
          for (const chunk of queued.splice(0)) controller.enqueue(chunk)
        },
        cancel() {
          if (current) controllers.delete(current)
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
  }
  const send = (
    controllers: Set<ReadableStreamDefaultController<Uint8Array>>,
    queued: Uint8Array[],
    event: unknown,
  ) => {
    const chunk = encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
    if (controllers.size === 0) {
      queued.push(chunk)
      return
    }
    for (const controller of controllers) controller.enqueue(chunk)
  }

  return {
    emit(event: YCodingEvent) {
      send(streams, pending, event)
    },
    subscriptions() {
      return streams.size
    },
    connect() {
      return response(streams, pending, { id: "evt_connected", type: "server.connected", data: {} })
    },
    disconnect() {
      for (const controller of streams) controller.close()
      streams.clear()
    },
  }
}

export type FetchHandler = (url: URL, request: Request) => Response | undefined | Promise<Response | undefined>

export function createFetch(override?: FetchHandler, events?: ReturnType<typeof createEventStream>) {
  const session = [] as URL[]
  async function fetch(input: RequestInfo | URL, init?: RequestInit) {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    if (url.pathname === "/session") session.push(url)
    const overridden = await override?.(url, request)
    if (overridden) return overridden
    if (url.pathname === "/api/event" && events) return events.connect()

    if (
      [
        "/agent",
        "/command",
        "/experimental/workspace",
        "/experimental/workspace/status",
        "/formatter",
        "/lsp",
      ].includes(url.pathname)
    )
      return json([])
    if (["/config", "/experimental/resource", "/mcp", "/provider/auth", "/session/status"].includes(url.pathname))
      return json({})
    if (url.pathname === "/config/providers") return json({ providers: {}, default: {} })
    if (url.pathname === "/experimental/console") return json({ consoleManagedProviders: [], switchableOrgCount: 0 })
    if (url.pathname === "/experimental/capabilities") return json({ backgroundSubagents: true })
    if (url.pathname === "/path") return json({ home: "", state: "", config: "", worktree, directory })
    if (url.pathname === "/api/location") return json({ directory, project: { id: "proj_test", directory: worktree } })
    if (url.pathname === "/api/vcs/branch")
      return json({
        location: { directory, project: { id: "proj_test", directory: worktree } },
        data: { current: "main", default: "main" },
      })
    if (url.pathname === "/api/fs/list")
      return json({ location: { directory, project: { id: "proj_test", directory: worktree } }, data: [] })
    if (url.pathname === "/api/project/current") return json({ id: "proj_test", directory: worktree })
    if (url.pathname === "/api/project/proj_test/directories") return json([{ directory: worktree }])
    if (url.pathname === "/api/model/default")
      return json({ location: { directory, project: { id: "proj_test", directory: worktree } }, data: null })
    if (url.pathname === "/api/shell")
      return json({ location: { directory, project: { id: "proj_test", directory: worktree } }, data: [] })
    if (url.pathname === "/api/mcp")
      return json({ location: { directory, project: { id: "proj_test", directory: worktree } }, data: [] })
    if (url.pathname === "/api/mcp/resource")
      return json({
        location: { directory, project: { id: "proj_test", directory: worktree } },
        data: { resources: [], templates: [] },
      })
    if (url.pathname === "/api/config/diagnostics")
      return json({ location: { directory, project: { id: "proj_test", directory: worktree } }, data: [] })
    if (url.pathname === "/api/session") return json({ data: [], cursor: {} })
    if (url.pathname === "/api/session/active") return json({ data: {} })
    if (/^\/api\/session\/[^/]+\/dots\/access$/.test(url.pathname)) {
      const sessionID = url.pathname.split("/")[3]
      return json({ data: { sessionID, rootSessionID: sessionID, enabled: false, configured: false, inherited: false, revision: 0 } })
    }
    if (/^\/api\/session\/[^/]+\/snapshot$/.test(url.pathname))
      return sessionSnapshot(url.pathname.slice("/api/session/".length, -"/snapshot".length), [])
    if (/^\/api\/session\/[^/]+\/(pending|skills|todo)$/.test(url.pathname)) return json({ data: [] })
    if (url.pathname === "/api/remote") return json({ data: { state: "off" } })
    if (url.pathname === "/api/keep-awake") return json({ data: { state: "off" } })
    if (url.pathname === "/api/server/telemetry/consent")
      return json({ consent: { enabled: false, noticeVersion: 1, decidedAt: 0 }, noticeVersion: 1 })
    if (url.pathname === "/api/permission/request")
      return json({ location: { directory, project: { id: "proj_test", directory: worktree } }, data: [] })
    if (url.pathname === "/api/form/request")
      return json({ location: { directory, project: { id: "proj_test", directory: worktree } }, data: [] })
    if (/^\/api\/session\/[^/]+\/guardrail\/request$/.test(url.pathname)) return json({ data: [] })
    if (/^\/api\/session\/[^/]+\/guardrail$/.test(url.pathname))
      return json({ data: { rootSessionID: url.pathname.split("/")[3], profile: "standard", customRules: 0, approvals: 0, blocked: 0, counters: [], invalidFiles: [] } })
    if (/^\/api\/session\/[^/]+\/subagent$/.test(url.pathname))
      return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
    if (/^\/api\/session\/[^/]+\/review$/.test(url.pathname)) return json({ data: [] })
    if (/^\/api\/session\/[^/]+\/compaction$/.test(url.pathname))
      return json({ data: [], truncated: false, completedBefore: 0, completedCount: 0, totalSavedTokens: 0 })
    if (/^\/api\/session\/[^/]+\/diagnostics$/.test(url.pathname)) return json({ data: null })
    if (/^\/api\/session\/[^/]+\/usage$/.test(url.pathname)) return json({ data: null })
    if (/^\/api\/session\/[^/]+\/usage\/(prompts|tasks)$/.test(url.pathname)) {
      const empty = { requests: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: { pricedRequests: 0, unpricedRequests: 0 } }
      return json({ data: url.pathname.endsWith("/prompts") ? { units: [], unattributed: empty, history: "partial" } : { tasks: [], total: empty, history: "partial" } })
    }
    // Provider-usage refresh is read-only and best effort. Absent usage renders as unreported, so the
    // fixture returns no payload rather than zeroed quota values.
    if (/^\/api\/provider\/[^/]+\/usage$/.test(url.pathname)) return json({ data: null })
    if (url.pathname === "/api/incident/report") return json({ data: { rows: [], groups: 0 } })
    if (url.pathname === "/api/incident/recent") return json({ data: { items: [] } })
    if (url.pathname === "/api/incident/guidance") return json({ data: { enabled: true } })
    if (url.pathname === "/api/provider/usage/forecast") return json({ data: { asOf: 0, localScope: "backend" } })
    if (/^\/api\/session\/[^/]+\/autonomy$/.test(url.pathname))
      return json({ data: { mode: "normal", permissions: "manual", guardrails: "manual", answers: "manual", effective: { permissions: "manual", guardrails: "manual", answers: "manual", inherited: {}, asleep: false, guardrailsEnabled: true } } })
    if (/^\/api\/session\/[^/]+\/form$/.test(url.pathname)) return json({ data: [] })
    if (url.pathname === "/api/coordination") return json({ data: [] })
    if (url.pathname === "/api/coordination/settings") return json({ data: { enabled: true, categories: [] } })
    if (/^\/api\/session\/[^/]+\/permission$/.test(url.pathname)) return json({ data: [] })
    if (
      ["/api/agent", "/api/model", "/api/provider", "/api/integration", "/api/command", "/api/skill"].includes(
        url.pathname,
      )
    )
      return json({
        location: { directory, project: { id: "proj_test", directory: worktree } },
        data: [],
      })
    if (url.pathname === "/api/reference")
      return json({ location: { directory, project: { id: "proj_test", directory } }, data: [] })
    if (url.pathname === "/provider") return json({ all: [], default: {}, connected: [] })
    if (url.pathname === "/session") return json([])
    if (url.pathname === "/vcs") return json({ branch: "main" })
    throw new Error(`unexpected request: ${url.pathname}`)
  }
  fetch.preconnect = () => {}
  return { fetch, session }
}

export function createApi(fetch: typeof globalThis.fetch) {
  return YCoding.make({ baseUrl: "http://test", fetch })
}
