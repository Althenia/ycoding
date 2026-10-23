import { json } from "./tui-client"

export const groupID = "cgrp_release0001"
export const docsGroupID = "cgrp_docssweep001"
export const leadID = "ses_lead00000001"
export const docsID = "ses_docsworker001"
export const apiID = "ses_apiworker0001"
export const infraID = "ses_infraworker01"
export const designID = "ses_designrev0001"
export const scribeID = "ses_scribe0000001"
export const notesID = "ses_notesworker01"
export const scratchID = "ses_scratch000001"
export const planningID = "ses_planning00001"
export const time = { created: 1_700_000_000_000, updated: 1_700_000_100_000 }

export type FixtureSession = {
  title: string
  directory: string
  state: "idle" | "running" | "waiting" | "failed"
  lastActivity: number
  updated: number
  pending?: number
  drivenBy?: { sessionID: string; title: string }
}
export type FixtureProject = {
  id: string
  name: string
  revision: number
  active: boolean
  pausedReason?: "interrupted" | "restart"
  masterSessionID: string
  memberSessionIDs: string[]
  settings: { concurrency: number | null; delegatedDecisions?: Record<string, unknown> }
}
export type Write = { method: string; path: string; body: Record<string, any> }

const minutes = (count: number) => Date.now() - count * 60_000

export const delegatedDecisions = {
  categories: ["permission", "review"] as const,
  actions: ["shell:git status"],
  resources: ["/repo/src/**"],
  expiresAt: 1_800_000_000_000,
}

function sessionInfo(id: string, session: FixtureSession) {
  return {
    id,
    title: session.title,
    projectID: "proj_test",
    location: { directory: session.directory },
    agent: "build",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: session.updated },
  }
}

export function backend(overrides: { projects?: FixtureProject[]; sessions?: Record<string, FixtureSession> } = {}) {
  const sessions: Record<string, FixtureSession> = overrides.sessions ?? {
    [leadID]: {
      title: "Lead",
      directory: "/home/dev/Workspace/api",
      state: "running",
      lastActivity: Date.now(),
      updated: minutes(4),
    },
    [docsID]: {
      title: "Docs worker",
      directory: "/home/dev/Workspace/docs",
      state: "idle",
      lastActivity: minutes(1.5),
      updated: minutes(90),
    },
    [apiID]: {
      title: "Api worker",
      directory: "/home/dev/Workspace/api",
      state: "running",
      lastActivity: minutes(180),
      updated: minutes(180),
      drivenBy: { sessionID: "ses_driver000001", title: "Migration agent" },
    },
    [infraID]: {
      title: "Infra worker",
      directory: "/home/dev/Workspace/infra",
      state: "waiting",
      lastActivity: minutes(240),
      updated: minutes(240),
      pending: 1,
    },
    [designID]: {
      title: "Design review",
      directory: "/home/dev/Workspace/design",
      state: "running",
      lastActivity: minutes(300),
      updated: minutes(300),
    },
    [scribeID]: {
      title: "Scribe",
      directory: "/home/dev/Workspace/docs",
      state: "idle",
      lastActivity: minutes(600),
      updated: minutes(600),
    },
    [notesID]: {
      title: "Notes worker",
      directory: "/home/dev/Workspace/docs",
      state: "idle",
      lastActivity: minutes(700),
      updated: minutes(700),
    },
    [scratchID]: {
      title: "Scratch",
      directory: "/home/dev/tmp",
      state: "idle",
      lastActivity: minutes(2880),
      updated: minutes(2880),
    },
    [planningID]: {
      title: "Planning",
      directory: "/home/dev/Workspace/plan",
      state: "idle",
      lastActivity: minutes(5000),
      updated: minutes(5000),
    },
  }
  const projects: FixtureProject[] = overrides.projects ?? [
    {
      id: groupID,
      name: "Release train",
      revision: 7,
      active: true,
      masterSessionID: leadID,
      memberSessionIDs: [docsID, apiID, infraID, designID],
      settings: { concurrency: 2, delegatedDecisions },
    },
    {
      id: docsGroupID,
      name: "Docs sweep",
      revision: 2,
      active: false,
      masterSessionID: scribeID,
      memberSessionIDs: [notesID],
      settings: { concurrency: null },
    },
  ]
  const state = {
    sessions,
    projects,
    failList: false,
    failWrite: undefined as string | undefined,
    settings: {
      enabled: true,
      categories: ["permission", "review"],
      actions: ["shell:git status"],
      expiresAt: 5_000_000_000_000,
    } as Record<string, unknown> | undefined,
    writes: [] as Write[],
    created: 0,
  }
  const participant = (id: string) => {
    const session = state.sessions[id]!
    return {
      sessionID: id,
      title: session.title,
      location: { directory: session.directory },
      state: session.state,
      lastActivity: session.lastActivity,
      pending: Array.from({ length: session.pending ?? 0 }, (_, index) => ({
        kind: "question",
        requestID: `req_${id}_${index}`,
        fingerprint: `fp_${index}`,
        summary: "Keep the old table names?",
      })),
      ...(session.drivenBy === undefined ? {} : { drivenBy: session.drivenBy }),
    }
  }
  const info = (project: FixtureProject) => ({
    id: project.id,
    name: project.name,
    revision: project.revision,
    active: project.active,
    ...(project.pausedReason === undefined ? {} : { pausedReason: project.pausedReason }),
    master: participant(project.masterSessionID),
    members: project.memberSessionIDs.map(participant),
    settings: project.settings,
    time,
  })
  const summary = (project: FixtureProject) => ({
    id: project.id,
    name: project.name,
    revision: project.revision,
    active: project.active,
    masterSessionID: project.masterSessionID,
    memberCount: project.memberSessionIDs.length,
    settings: project.settings,
    time,
  })
  const conflict = (message: string) =>
    json({ _tag: "CoordinationError", reason: "Coordination.ConflictError", message }, { status: 409 })
  const record = (request: Request, url: URL, body: Record<string, any>) =>
    state.writes.push({ method: request.method, path: url.pathname, body })

  const route = async (url: URL, request: Request) => {
    const path = url.pathname
    if (!path.startsWith("/api/coordination") && !path.startsWith("/api/session")) return undefined
    const sessionMatch = /^\/api\/session\/([^/]+)(\/rename)?$/.exec(path)
    if (path === "/api/session" && request.method === "GET")
      return json({ data: Object.entries(state.sessions).map(([id, session]) => sessionInfo(id, session)), cursor: {} })
    if (path === "/api/session" && request.method === "POST") {
      const body = await request.json()
      record(request, url, body)
      const id = `ses_new${String(++state.created).padStart(8, "0")}`
      state.sessions[id] = {
        title: "New session",
        directory: body.location.directory,
        state: "idle",
        lastActivity: Date.now(),
        updated: Date.now(),
      }
      return json({ data: sessionInfo(id, state.sessions[id]!) })
    }
    if (sessionMatch?.[2] && request.method === "POST") {
      const body = await request.json()
      record(request, url, body)
      state.sessions[sessionMatch[1]!]!.title = body.title
      return new Response(null, { status: 204 })
    }
    if (sessionMatch && !sessionMatch[2] && request.method === "DELETE") {
      record(request, url, {})
      const id = sessionMatch[1]!
      delete state.sessions[id]
      for (const project of [...state.projects]) {
        if (project.masterSessionID === id) state.projects.splice(state.projects.indexOf(project), 1)
        else project.memberSessionIDs = project.memberSessionIDs.filter((member) => member !== id)
      }
      return new Response(null, { status: 204 })
    }
    if (!path.startsWith("/api/coordination")) return undefined
    if (path === "/api/coordination/settings") {
      if (state.settings === undefined)
        return json(
          { _tag: "CoordinationError", reason: "unavailable", message: "settings unavailable" },
          { status: 409 },
        )
      return json({ data: state.settings })
    }
    if (path === "/api/coordination" && request.method === "GET") {
      if (state.failList)
        return json(
          { _tag: "CoordinationError", reason: "offline", message: "Projects backend offline" },
          { status: 409 },
        )
      return json({ data: state.projects.map(summary) })
    }
    if (path === "/api/coordination" && request.method === "POST") {
      const body = await request.json()
      record(request, url, body)
      if (state.failWrite) return conflict(state.failWrite)
      const project: FixtureProject = {
        id: `cgrp_created${state.projects.length + 1}`,
        name: body.name,
        revision: 1,
        active: false,
        masterSessionID: body.masterSessionID,
        memberSessionIDs: body.memberSessionIDs,
        settings: { concurrency: null },
      }
      state.projects.push(project)
      return json({ data: info(project) })
    }
    const project = state.projects.find((item) => path === `/api/coordination/${item.id}`)
    if (!project)
      return json(
        { _tag: "CoordinationError", reason: "Coordination.NotFoundError", message: "Project not found" },
        { status: 409 },
      )
    if (request.method === "GET") return json({ data: info(project) })
    if (request.method === "DELETE") {
      record(request, url, {})
      state.projects.splice(state.projects.indexOf(project), 1)
      return new Response(null, { status: 204 })
    }
    const body = await request.json()
    record(request, url, body)
    if (state.failWrite) return conflict(state.failWrite)
    if (body.revision !== project.revision) return conflict("Project changed; refresh and retry")
    if (body.name !== undefined) project.name = body.name
    if (body.masterSessionID !== undefined) project.masterSessionID = body.masterSessionID
    if (body.memberSessionIDs !== undefined) project.memberSessionIDs = body.memberSessionIDs
    if (body.settings !== undefined) project.settings = body.settings
    project.revision += 1
    return json({ data: info(project) })
  }
  return { state, route }
}
