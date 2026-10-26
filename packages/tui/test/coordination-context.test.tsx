/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { ConfigProvider } from "../src/config"
import { ClientProvider } from "../src/context/client"
import { CoordinationProvider, useCoordination } from "../src/context/coordination"
import {
  apiID,
  backend,
  delegatedDecisions,
  designID,
  docsGroupID,
  docsID,
  groupID,
  infraID,
  leadID,
  notesID,
  scratchID,
} from "./fixture/coordination-backend"
import { ProjectCreationError } from "../src/util/coordination"
import { createApi, createEventStream, createFetch } from "./fixture/tui-client"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

async function mount(
  server: ReturnType<typeof backend>,
  options: { config?: Parameters<typeof createTuiResolvedConfig>[0] } = {},
) {
  const events = createEventStream()
  const fetch = createFetch(server.route, events)
  let coordination!: ReturnType<typeof useCoordination>
  function Probe() {
    coordination = useCoordination()
    return (
      <text>
        {coordination.error()
          ? `error ${coordination.error()}`
          : (coordination.projects() ?? [])
              .map((project) => `${project.name} ${project.active ? "active" : "paused"}`)
              .join(" | ") || "loading"}
      </text>
    )
  }
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig(options.config)}>
          <ClientProvider api={createApi(fetch.fetch)}>
            <CoordinationProvider>
              <Probe />
            </CoordinationProvider>
          </ClientProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 8 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => !frame.includes("loading"))
  return { app, events, coordination: () => coordination }
}

async function until(check: () => boolean, label: string, timeout = 5_000) {
  const deadline = Date.now() + timeout
  while (!check() && Date.now() < deadline) await Bun.sleep(10)
  if (!check()) throw new Error(`Timed out waiting for ${label}`)
}

const writes = (server: ReturnType<typeof backend>) =>
  server.state.writes.map((write) => [write.method, write.path, write.body] as const)

test("the provider loads each Project with the master first, live member state, pending count and directory", async () => {
  const server = backend()
  const { app, coordination } = await mount(server)
  try {
    const release = coordination().projects()![0]!
    expect(release).toMatchObject({ id: groupID, name: "Release train", revision: 7, active: true, concurrency: 2 })
    expect(release.delegatedDecisions).toEqual(delegatedDecisions)
    expect(release.master).toMatchObject({
      sessionID: leadID,
      title: "Lead",
      role: "master",
      state: "running",
      directory: "/home/dev/Workspace/api",
      pending: 0,
    })
    expect(release.members.map((member) => [member.sessionID, member.state, member.pending])).toEqual([
      [docsID, "idle", 0],
      [apiID, "running", 0],
      [infraID, "waiting", 1],
      [designID, "running", 0],
    ])
    expect(release.members.every((member) => member.role === "member")).toBe(true)
    expect(release.members[1]!.drivenBy).toBe("Migration agent")
    expect(coordination().projects()![1]).toMatchObject({ id: docsGroupID, active: false, concurrency: null })
    expect(coordination().loadedAt()).toBeGreaterThan(0)
    expect(coordination().globalDelegation()).toMatchObject({ enabled: true, categories: ["permission", "review"] })
  } finally {
    app.renderer.destroy()
  }
})

test("root Sessions carry the name of the Project that already holds them", async () => {
  const { app, coordination } = await mount(backend())
  try {
    await until(() => coordination().sessions().length > 0, "root sessions")
    const byID = new Map(
      coordination()
        .sessions()
        .map((session) => [session.sessionID, session]),
    )
    expect(byID.get(leadID)?.projectName).toBe("Release train")
    expect(byID.get(notesID)?.projectName).toBe("Docs sweep")
    expect(byID.get(scratchID)).toMatchObject({ title: "Scratch", directory: "/home/dev/tmp" })
    expect(byID.get(scratchID)?.projectName).toBeUndefined()
    expect(coordination().projectOf(infraID)).toMatchObject({ role: "member" })
    expect(coordination().projectOf(scratchID)).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("Project snapshots preserve the reported pause reason", async () => {
  const server = backend()
  server.state.projects[0]!.active = false
  server.state.projects[0]!.pausedReason = "restart"
  const { app, coordination } = await mount(server)
  try {
    expect(coordination().projects()![0]!.pausedReason).toBe("restart")
  } finally {
    app.renderer.destroy()
  }
})

test("a failed list reports the backend reason and keeps the Projects unloaded", async () => {
  const server = backend()
  server.state.failList = true
  const events = createEventStream()
  const fetch = createFetch(server.route, events)
  let coordination!: ReturnType<typeof useCoordination>
  function Probe() {
    coordination = useCoordination()
    return <text>{coordination.error() ?? "no error"}</text>
  }
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ClientProvider api={createApi(fetch.fetch)}>
            <CoordinationProvider>
              <Probe />
            </CoordinationProvider>
          </ClientProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 4 },
  )
  app.renderer.start()
  try {
    await app.waitForFrame((frame) => frame.includes("Projects backend offline"))
    expect(coordination.projects()).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("creating with an existing master sends the name and master with no members", async () => {
  const server = backend()
  const { app, coordination } = await mount(server)
  try {
    const masterID = await coordination().service.create({ name: "Q4 planning", master: { sessionID: scratchID } })
    expect(masterID).toBe(scratchID)
    expect(writes(server)).toEqual([
      ["POST", "/api/coordination", { name: "Q4 planning", masterSessionID: scratchID, memberSessionIDs: [] }],
    ])
    await until(
      () =>
        coordination()
          .projects()!
          .some((project) => project.name === "Q4 planning"),
      "created project",
    )
  } finally {
    app.renderer.destroy()
  }
})

test("creating with a new master creates the Session in the directory, titles it and makes it the master", async () => {
  const server = backend()
  const { app, coordination } = await mount(server)
  try {
    const masterID = await coordination().service.create({
      name: "Infra move",
      master: { directory: "/home/dev/Workspace/infra" },
    })
    expect(masterID).toStartWith("ses_new")
    expect(writes(server)).toEqual([
      ["POST", "/api/session", { location: { directory: "/home/dev/Workspace/infra" }, title: "Infra move" }],
      ["POST", "/api/coordination", { name: "Infra move", masterSessionID: masterID, memberSessionIDs: [] }],
    ])
  } finally {
    app.renderer.destroy()
  }
})

test("a new master takes an explicit title over the Project name", async () => {
  const server = backend()
  const { app, coordination } = await mount(server)
  try {
    await coordination().service.create({ name: "Infra move", master: { directory: "/x", title: "Ops lead" } })
    expect(server.state.writes[0]!.body).toEqual({ location: { directory: "/x" }, title: "Ops lead" })
    expect(server.state.writes.some((write) => write.path.endsWith("/rename"))).toBe(false)
  } finally {
    app.renderer.destroy()
  }
})

test("a new master directory beginning with ~ resolves against the TUI home before the Session is created", async () => {
  const server = backend()
  const { app, coordination } = await mount(server)
  try {
    await coordination().service.create({ name: "Home project", master: { directory: "~/Workspace/app" } })
    await coordination().service.create({ name: "Bare home", master: { directory: "~" } })
    expect(server.state.writes.filter((write) => write.path === "/api/session").map((write) => write.body)).toEqual([
      { location: { directory: "/tmp/ycoding/home/Workspace/app" }, title: "Home project" },
      { location: { directory: "/tmp/ycoding/home" }, title: "Bare home" },
    ])
  } finally {
    app.renderer.destroy()
  }
})

test("a relative directory is rejected before Session creation and a corrected directory then creates once", async () => {
  const server = backend()
  const { app, coordination } = await mount(server)
  try {
    const input = { name: "Relative project", master: { directory: "Workspace/app" } }
    const rejected = await coordination()
      .service.create(input)
      .catch((cause: unknown) => cause)
    expect(rejected).toBeInstanceOf(Error)
    expect(rejected).not.toBeInstanceOf(ProjectCreationError)
    expect(rejected).toMatchObject({ message: "Choose an absolute directory" })
    await expect(coordination().service.create(input)).rejects.toThrow("Choose an absolute directory")
    expect(server.state.writes).toEqual([])

    const masterID = await coordination().service.create({
      name: "Relative project",
      master: { directory: "/tmp/ycoding/home/Workspace/app" },
    })
    expect(masterID).toStartWith("ses_new")
    expect(server.state.created).toBe(1)
    expect(server.state.writes.map((write) => write.path)).toEqual(["/api/session", "/api/coordination"])
  } finally {
    app.renderer.destroy()
  }
})

test("a new member directory resolves ~ and rejects a relative path before Session creation", async () => {
  const server = backend()
  const { app, coordination } = await mount(server)
  try {
    await expect(coordination().service.newMember(groupID, "Workspace/new", "Fresh")).rejects.toThrow(
      "Choose an absolute directory",
    )
    expect(server.state.writes).toEqual([])
    const created = await coordination().service.newMember(groupID, "~/Workspace/new", "Fresh")
    expect(server.state.writes[0]).toMatchObject({
      path: "/api/session",
      body: { location: { directory: "/tmp/ycoding/home/Workspace/new" }, title: "Fresh" },
    })
    expect(server.state.projects.find((project) => project.id === groupID)?.memberSessionIDs).toContain(created)
  } finally {
    app.renderer.destroy()
  }
})

test("renaming and changing concurrency send only the changed field and keep delegated decisions", async () => {
  const server = backend()
  const { app, coordination } = await mount(server)
  try {
    await coordination().service.rename(groupID, "Release train 2")
    await coordination().service.setConcurrency(groupID, null)
    await coordination().service.setConcurrency(groupID, 4)
    expect(writes(server)).toEqual([
      ["PATCH", `/api/coordination/${groupID}`, { revision: 7, name: "Release train 2" }],
      ["PATCH", `/api/coordination/${groupID}`, { revision: 8, settings: { concurrency: null, delegatedDecisions } }],
      ["PATCH", `/api/coordination/${groupID}`, { revision: 9, settings: { concurrency: 4, delegatedDecisions } }],
    ])
  } finally {
    app.renderer.destroy()
  }
})

test("delegation edits keep concurrency, and inheriting clears the narrowing", async () => {
  const server = backend()
  const { app, coordination } = await mount(server)
  try {
    await coordination().service.setDelegation(groupID, { categories: ["review"] })
    await coordination().service.setDelegation(groupID, null)
    expect(writes(server).map(([, , body]) => body)).toEqual([
      { revision: 7, settings: { concurrency: 2, delegatedDecisions: { categories: ["review"] } } },
      { revision: 8, settings: { concurrency: 2 } },
    ])
  } finally {
    app.renderer.destroy()
  }
})

test("choosing another master moves the old master to the members and keeps every other member", async () => {
  const server = backend()
  const { app, coordination } = await mount(server)
  try {
    await coordination().service.setMaster(groupID, apiID)
    expect(server.state.writes[0]!.body).toEqual({
      revision: 7,
      masterSessionID: apiID,
      memberSessionIDs: [leadID, docsID, infraID, designID],
    })
    await until(() => coordination().projects()![0]!.master.sessionID === apiID, "new master")
    expect(
      coordination()
        .projects()![0]!
        .members.map((member) => member.sessionID),
    ).toEqual([leadID, docsID, infraID, designID])
  } finally {
    app.renderer.destroy()
  }
})

test("adding, creating and removing members rewrite only the member list", async () => {
  const server = backend()
  const { app, coordination } = await mount(server)
  try {
    await coordination().service.addMember(groupID, scratchID)
    const created = await coordination().service.newMember(groupID, "/home/dev/Workspace/new", "Fresh")
    await coordination().service.removeMember(groupID, docsID)
    expect(
      writes(server)
        .filter(([method]) => method === "PATCH")
        .map(([, , body]) => body),
    ).toEqual([
      { revision: 7, memberSessionIDs: [docsID, apiID, infraID, designID, scratchID] },
      { revision: 8, memberSessionIDs: [docsID, apiID, infraID, designID, scratchID, created] },
      { revision: 9, memberSessionIDs: [apiID, infraID, designID, scratchID, created] },
    ])
    expect(server.state.writes[1]).toMatchObject({
      path: "/api/session",
      body: { location: { directory: "/home/dev/Workspace/new" } },
    })
    expect(server.state.sessions[docsID]).toBeDefined()
  } finally {
    app.renderer.destroy()
  }
})

test("a Session already in a Project cannot be added again", async () => {
  const server = backend()
  const { app, coordination } = await mount(server)
  try {
    await expect(coordination().service.addMember(groupID, docsID)).rejects.toThrow(
      "A Session can belong to a Project once",
    )
    await expect(coordination().service.addMember(groupID, leadID)).rejects.toThrow(
      "A Session can belong to a Project once",
    )
    expect(server.state.writes).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("deleting a member deletes its Session, and deleting a Project keeps every Session", async () => {
  const server = backend()
  const { app, coordination } = await mount(server)
  try {
    await expect(coordination().service.deleteMember(groupID, leadID)).rejects.toThrow(
      "Only a member Session can be deleted",
    )
    await coordination().service.deleteMember(groupID, designID)
    expect(writes(server)).toEqual([["DELETE", `/api/session/${designID}`, {}]])
    await coordination().service.deleteProject(docsGroupID)
    expect(server.state.writes.at(-1)).toMatchObject({ method: "DELETE", path: `/api/coordination/${docsGroupID}` })
    expect(server.state.sessions[notesID]).toBeDefined()
    await until(() => coordination().projects()!.length === 1, "project removed")
    expect(
      coordination()
        .projects()![0]!
        .members.map((member) => member.sessionID),
    ).not.toContain(designID)
  } finally {
    app.renderer.destroy()
  }
})

test("a stale revision surfaces the backend reason and a refresh recovers", async () => {
  const server = backend()
  const { app, coordination } = await mount(server)
  try {
    server.state.projects[0]!.revision = 9
    await expect(coordination().service.rename(groupID, "Late")).rejects.toThrow("Project changed; refresh and retry")
    await until(() => coordination().projects()![0]!.revision === 9, "refreshed revision")
    await coordination().service.rename(groupID, "Late")
    expect(server.state.projects[0]!.name).toBe("Late")
  } finally {
    app.renderer.destroy()
  }
})

test("a mutation waits for the latest overlapping Project refresh before the next write", async () => {
  const server = backend()
  const initialRoute = server.route
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
  const started = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
  let read = 0
  let holding = false
  server.route = async (url, request) => {
    if (holding && request.method === "GET" && url.pathname === "/api/coordination" && read < 2) {
      const index = read++
      started[index]!.resolve()
      await gates[index]!.promise
    }
    return initialRoute(url, request)
  }
  const { app, coordination } = await mount(server)
  try {
    holding = true
    let settled = false
    const mutation = coordination()
      .service.rename(groupID, "Renamed project")
      .then(() => {
        settled = true
      })
    await started[0]!.promise
    const refresh = coordination().refresh()
    await started[1]!.promise
    gates[0]!.resolve()
    await new Promise<void>((resolve) => setImmediate(resolve))
    const settledBeforeLatestRead = settled
    gates[1]!.resolve()
    await Promise.all([mutation, refresh])
    expect(settledBeforeLatestRead).toBe(false)
    await coordination().service.addMember(groupID, scratchID)
    expect(server.state.writes.at(-1)?.body).toMatchObject({ revision: 8 })
    expect(
      coordination()
        .projects()![0]!
        .members.some((member) => member.sessionID === scratchID),
    ).toBe(true)
  } finally {
    gates.forEach((gate) => gate.resolve())
    app.renderer.destroy()
  }
})

test("member state changes arrive in place from coordination and execution events", async () => {
  const server = backend()
  const { app, events, coordination } = await mount(server)
  try {
    server.state.sessions[docsID]!.state = "running"
    events.emit({
      id: "evt_updated",
      created: 1,
      type: "coordination.updated",
      data: { groupID, revision: 7 },
    } as never)
    await until(() => coordination().projects()![0]!.members[0]!.state === "running", "docs worker running")
    server.state.sessions[docsID]!.state = "failed"
    events.emit({
      id: "evt_failed",
      created: 2,
      type: "session.execution.failed",
      data: { sessionID: docsID },
    } as never)
    await until(() => coordination().projects()![0]!.members[0]!.state === "failed", "docs worker failed")
    expect(
      coordination()
        .projects()![0]!
        .members.map((member) => member.sessionID),
    ).toEqual([docsID, apiID, infraID, designID])
  } finally {
    app.renderer.destroy()
  }
})

test("external notifications gate on master Sessions from the loaded Projects", async () => {
  const everything = await mount(backend())
  try {
    for (const sessionID of [leadID, docsID, "ses_other"])
      expect(everything.coordination().externalAllowed(sessionID, "failure")).toBe(true)
  } finally {
    everything.app.renderer.destroy()
  }
  const masters = await mount(backend(), {
    config: { attention: { coordination: { scope: "coordinators", categories: ["failure"] } } },
  })
  try {
    const allowed = masters.coordination().externalAllowed
    expect(allowed(leadID, "failure")).toBe(true)
    expect(allowed(docsID, "failure")).toBe(false)
    expect(allowed(leadID, "completion")).toBe(false)
  } finally {
    masters.app.renderer.destroy()
  }
})
