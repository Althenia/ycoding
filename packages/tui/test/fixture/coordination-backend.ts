import { json } from "./tui-client"

export const groupID = "cgrp_alpha0000001"
export const leadID = "ses_lead00000001"
export const workerID = "ses_worker0000001"
export const watcherID = "ses_watcher000001"
export const location = { directory: "/repo" }
export const delegatedDecisions = {
  categories: ["permission", "review"],
  actions: ["shell:git status"],
  resources: ["/repo/src/**"],
  expiresAt: 1_800_000_000_000,
}
export const members = [
  { sessionID: leadID, role: "coordinator", allowedTools: ["read"], resourceScopes: ["/repo/**"], location },
  { sessionID: workerID, role: "worker", allowedTools: ["read", "grep"], resourceScopes: ["/repo/src/**"], location },
  { sessionID: watcherID, role: "observer", location },
]
export const policy = { concurrency: 3, queueCapacity: 40, budget: 5, delegatedDecisions }
export const time = { created: 1, updated: 2 }

function session(id: string, title: string) {
  return {
    id,
    title,
    projectID: "proj_test",
    location,
    agent: "build",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  }
}

export function dispatch(id: string, status: string, reason?: string) {
  return {
    id: `cdsp_${id}`,
    groupID,
    targetSessionID: workerID,
    coordinatorSessionID: leadID,
    generation: 1,
    status,
    ...(reason === undefined ? {} : { reason }),
    selection: { agent: "build", model: { providerID: "openai", id: "gpt-6", profile: "work" }, reason: "Quick lease check" },
    text: "Check the parser",
    time,
  }
}

export type WriteBody = {
  readonly revision?: number
  readonly name?: string
  readonly policy?: {
    readonly concurrency: number | null
    readonly queueCapacity: number
    readonly budget?: number
    readonly delegatedDecisions?: {
      readonly categories: ReadonlyArray<string>
      readonly actions?: ReadonlyArray<string>
      readonly resources?: ReadonlyArray<string>
      readonly expiresAt?: number
    }
  }
  readonly members?: ReadonlyArray<{
    readonly sessionID: string
    readonly role: string
    readonly allowedTools?: ReadonlyArray<string>
    readonly resourceScopes?: ReadonlyArray<string>
  }>
}

export function backend(
  overrides: { dispatches?: unknown[]; capacity?: Record<string, unknown>; status?: string; lastCursor?: { next: null } } = {},
) {
  const state = {
    status: overrides.status ?? "armed",
    failList: false,
    settings: { enabled: true, categories: ["permission", "review"], actions: ["shell:git status"], expiresAt: 5_000_000_000_000 } as Record<string, unknown> | undefined,
    dispatches: overrides.dispatches ?? [],
    capacity: {
      groupID,
      concurrency: 3,
      hardLimit: 5,
      effectiveLimit: 3,
      active: 2,
      waiting: 0,
      queued: 1,
      queueCapacity: 40,
      available: 1,
      spent: 0.5,
      ...overrides.capacity,
    },
    calls: [] as string[],
    writes: [] as Array<{ method: string; path: string; body: WriteBody }>,
    sessionQueries: [] as URL[],
  }
  const info = () => ({
    id: groupID,
    name: "Release train",
    status: state.status,
    revision: 7,
    policy,
    fencingGeneration: 2,
    members,
    time,
  })
  const route = async (url: URL, request: Request) => {
    if (!url.pathname.startsWith("/api/coordination") && url.pathname !== "/api/session") return undefined
    if (url.pathname === "/api/session") {
      state.sessionQueries.push(url)
      state.calls.push("sessions")
      const cursor = url.searchParams.get("cursor")
      if (cursor === null) return json({ data: [session(leadID, "Lead session"), session(watcherID, "Watcher")], cursor: { next: "page-2" } })
      return json({ data: [session(workerID, "Worker A")], cursor: overrides.lastCursor ?? {} })
    }
    if (request.method !== "GET") {
      const body: WriteBody = await request.json()
      state.writes.push({ method: request.method, path: url.pathname, body })
      return json({ data: info() })
    }
    state.calls.push(url.pathname)
    if (url.pathname === "/api/coordination/settings") {
      if (state.settings === undefined) return json({ _tag: "CoordinationError", reason: "unavailable", message: "settings unavailable" }, { status: 409 })
      return json({ data: state.settings })
    }
    if (url.pathname === "/api/coordination") {
      if (state.failList) return json({ _tag: "CoordinationError", reason: "offline", message: "Coordination backend offline" }, { status: 409 })
      return json({ data: [{ ...info(), members: undefined, memberCount: members.length }] })
    }
    if (url.pathname.endsWith("/capacity")) return json({ data: state.capacity })
    if (url.pathname.endsWith("/receipts"))
      return json({
        data: [
          {
            id: "crcpt_001",
            groupID,
            dispatchID: "cdsp_a",
            kind: "dispatched",
            sessionID: workerID,
            generation: 1,
            time: 10,
            selection: { agent: "omoikane", model: { providerID: "anthropic", id: "claude-sonnet-5-5", variant: "high" }, reason: "Needs deep reasoning" },
          },
        ],
      })
    return json({
      data: {
        ...info(),
        claims: [{ groupID, targetSessionID: workerID, holderSessionID: leadID, generation: 1, status: "active", leaseExpiresAt: 99 }],
        dispatches: state.dispatches,
      },
    })
  }
  return { state, route }
}
