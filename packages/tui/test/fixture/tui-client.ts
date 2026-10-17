import { afterEach } from "bun:test"
import {
  YCoding,
  encodeDomain,
  type V5Client,
  type EventSubscribeOutput,
  type SessionInfo,
  type SessionProjection,
  type SessionLogItem,
} from "@ycoding-ai/client/v5"
import { eventSources, fixtureBudgets, scriptedTransport, type EventSource } from "./v5-peer"

export const worktree = "/tmp/ycoding"
export const directory = `${worktree}/packages/tui`
const clients = new Set<V5Client>()
afterEach(() => {
  for (const client of clients) client.transport.close()
  clients.clear()
})

export function json(data: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers)
  if (!headers.has("content-type")) headers.set("content-type", "application/json")
  return new Response(JSON.stringify(data), {
    ...init,
    headers,
  })
}

export function capturedGroup(
  placementMessageID: string,
  path: string,
  diff: string,
  additions = 1,
  deletions = 1,
): Awaited<ReturnType<V5Client["session"]["capturedChanges"]["list"]>>["data"][number] {
  return {
    placementMessageID,
    path,
    additions,
    deletions,
    status: "modified" as const,
    files: [{ path, diff, additions, deletions, status: "modified" as const }],
  }
}

export function sessionSnapshot(
  sessionID: string,
  messages: readonly unknown[],
  options: Partial<Pick<SessionProjection, "before" | "sourceEpoch" | "watermark">> & {
    session?: Partial<SessionInfo>
  } = {},
) {
  return json({
    sourceEpoch: "source-1",
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

export function createEventStream(options: { ready?: boolean; end?: boolean } = {}) {
  const streams = new Map<Parameters<EventSource["attach"]>[0], string>()
  const pending: EventSubscribeOutput[] = []
  const openings = new Set<() => void>()
  let ready = options.ready !== false
  const send = (peer: Parameters<EventSource["attach"]>[0], id: string, events: EventSubscribeOutput[]) => {
    peer.events(
      id,
      events.map((event) => ({
        typeName: "ycoding.v5.PublicEvent",
        payload: encodeDomain("ycoding.v5.PublicEvent", { created: 0, sourceEpoch: "source-1", ...event }),
      })),
    )
  }
  const source: EventSource = {
    opening(open) {
      if (ready) open()
      else openings.add(open)
    },
    attach(peer, dispatch) {
      const id = `tui_subscription_${streams.size}`
      streams.set(peer, id)
      peer.subscribe(dispatch, id)
      const close = peer.socket.close.bind(peer.socket)
      peer.socket.close = () => {
        streams.delete(peer)
        close()
      }
      if (pending.length) queueMicrotask(() => send(peer, id, pending.splice(0)))
      if (options.end) queueMicrotask(() => peer.end(id))
    },
  }
  return {
    ...source,
    emit(event: EventSubscribeOutput) {
      if (event.type === "server.connected") throw new Error("Ready owns server.connected")
      if (!streams.size) {
        pending.push(event)
        return
      }
      for (const [peer, id] of streams) send(peer, id, [event])
    },
    subscriptions() {
      return streams.size
    },
    ready() {
      ready = true
      for (const open of openings) open()
      openings.clear()
    },
    connect() {
      const response = new Response(null)
      eventSources.set(response, source)
      return response
    },
    disconnect() {
      for (const peer of streams.keys()) peer.socket.close()
      streams.clear()
    },
  }
}

export type FetchHandler = (url: URL, request: Request) => Response | undefined | Promise<Response | undefined>

export function createLogStream(items: SessionLogItem[], end = true) {
  const response = new Response(null)
  const peers = new Set<Parameters<EventSource["attach"]>[0]>()
  eventSources.set(response, {
    opening(open) {
      open()
    },
    attach(peer, dispatch) {
      const id = `log_${dispatch.requestID}`
      peers.add(peer)
      peer.subscribe(dispatch, id)
      queueMicrotask(() => {
        peer.events(
          id,
          items.map((item) => ({
            typeName: "ycoding.v5.SessionLogItem",
            payload: encodeDomain("ycoding.v5.SessionLogItem", item),
          })),
        )
        if (end) peer.end(id)
      })
    },
  })
  return {
    response,
    disconnect() {
      for (const peer of peers) peer.socket.close()
      peers.clear()
    },
  }
}

export function createFetch(override?: FetchHandler, events?: ReturnType<typeof createEventStream>) {
  const source = events ?? createEventStream()
  const session = [] as URL[]
  async function fetch(input: RequestInfo | URL, init?: RequestInit) {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    if (url.pathname === "/session") session.push(url)
    const overridden = await override?.(url, request)
    if (overridden) return overridden
    if (url.pathname === "/api/event") return source.connect()

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
    if (url.pathname === "/api/location")
      return json({
        directory,
        project: { id: "proj_test", directory: worktree },
        backendPaths: {
          home: "/tmp/ycoding/home",
          state: "/tmp/ycoding/backend-state",
          config: "/tmp/ycoding/backend-config",
          worktree: "/tmp/ycoding/worktrees",
        },
      })
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
    if (/^\/api\/session\/[^/]+\/(captured-changes|team\/economics|family\/activity)$/.test(url.pathname))
      return json({ data: [] })
    if (/^\/api\/session\/[^/]+\/snapshot$/.test(url.pathname))
      return sessionSnapshot(url.pathname.slice("/api/session/".length, -"/snapshot".length), [])
    if (/^\/api\/session\/[^/]+\/(pending|skills)$/.test(url.pathname)) return json({ data: [] })
    if (/^\/api\/session\/[^/]+\/review$/.test(url.pathname)) return json({ data: [] })
    if (/^\/api\/session\/[^/]+\/guardrail$/.test(url.pathname))
      return json({
        data: {
          rootSessionID: url.pathname.split("/")[3],
          profile: "standard",
          customRules: 0,
          approvals: 0,
          blocked: 0,
          counters: [],
          invalidFiles: [],
          decisions: [],
          dismissals: [],
        },
      })
    if (url.pathname === "/api/remote") return json({ data: { state: "off" } })
    if (url.pathname === "/api/keep-awake") return json({ data: { state: "off" } })
    if (url.pathname === "/api/server/telemetry/consent")
      return json({ consent: { enabled: false, noticeVersion: 1, decidedAt: 0 }, noticeVersion: 1 })
    if (url.pathname === "/api/permission/request")
      return json({ location: { directory, project: { id: "proj_test", directory: worktree } }, data: [] })
    if (url.pathname === "/api/form/request")
      return json({ location: { directory, project: { id: "proj_test", directory: worktree } }, data: [] })
    if (/^\/api\/session\/[^/]+\/guardrail\/request$/.test(url.pathname)) return json({ data: [] })
    if (/^\/api\/session\/[^/]+\/compaction$/.test(url.pathname))
      return json({ data: [], truncated: false, completedBefore: 0, completedCount: 0, totalSavedTokens: 0 })
    if (/^\/api\/session\/[^/]+\/diagnostics$/.test(url.pathname)) return json({ data: null })
    if (/^\/api\/session\/[^/]+\/usage$/.test(url.pathname))
      return json({
        data: {
          logical: 0,
          physical: 0,
          helpers: 0,
          continued: 0,
          fallback: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      })
    if (/^\/api\/session\/[^/]+\/usage\/tasks$/.test(url.pathname)) {
      const empty = { requests: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: { pricedRequests: 0, unpricedRequests: 0 } }
      return json({ data: { tasks: [], total: empty, history: "partial" } })
    }
    // Provider-usage refresh is read-only and best effort. Absent usage renders as unreported, so the
    // fixture returns no payload rather than zeroed quota values.
    if (/^\/api\/provider\/[^/]+\/usage$/.test(url.pathname)) return json({ data: null })
    if (url.pathname === "/api/provider/usage/forecast")
      return json({
        location: { directory, project: { id: "proj_test", directory: worktree } },
        data: { asOf: 0, localScope: "backend" },
      })
    if (/^\/api\/session\/[^/]+\/autonomy$/.test(url.pathname))
      return json({ data: { mode: "normal", yolo: 0, effective: { yolo: 0, asleep: false, ordinaryReviewsAuto: false, guardrailsEnabled: true, modelReviews: false, hardModelReviews: false } } })
    if (/^\/api\/session\/[^/]+\/form$/.test(url.pathname)) return json({ data: [] })
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
  const transport = scriptedTransport((url, request) => fetch(request), source)
  return {
    fetch: Object.assign(fetch, { socket: transport.socket }),
    session,
    listen: transport.listen,
    close: transport.close,
    waitForSettlement: transport.waitForSettlement,
  }
}

export function createApi(fetch?: ReturnType<typeof createFetch>["fetch"]) {
  const fixture = fetch ?? createFetch().fetch
  const client = YCoding.make({
    endpoint: { url: "http://test" },
    location: { directory },
    socket: fixture.socket,
    budgets: fixtureBudgets,
  })
  clients.add(client)
  return client
}
