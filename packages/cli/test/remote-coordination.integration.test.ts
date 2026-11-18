import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join, relative } from "node:path"
import type { RemoteRequest } from "@ycoding-ai/remote"
import { createLocalServer } from "../src/remote-local"
import { createSessionRegistry, createSubscriptions, executeRemoteOperation } from "../src/remote-operations"
import { createSession, password, startServer } from "./remote-harness"

test("local Project adapter preserves owner authorization, revisions and Session deletion cascades", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ycoding-project-adapter-"))
  const server = await startServer(directory)
  try {
    await createSession(server, "ses_master", directory)
    await createSession(server, "ses_member", directory)
    const local = createLocalServer({ url: server.base, auth: { type: "basic", username: "ycoding", password } })
    expect((await fetch(`${server.base}/api/coordination`)).status).toBe(401)
    expect(await local.coordinationSettings()).toHaveProperty("categories")
    const group = await local.coordinationCreate({ name: "Project", masterSessionID: "ses_master", memberSessionIDs: ["ses_member"] })
    expect(await local.coordinationList()).toContainEqual(expect.objectContaining({ id: group.id, masterSessionID: "ses_master" }))
    expect(await local.coordinationGet({ groupID: group.id })).toMatchObject({ master: { sessionID: "ses_master" }, members: [{ sessionID: "ses_member" }] })
    const updated = await local.coordinationUpdate({ groupID: group.id, revision: group.revision, name: "Renamed", settings: { concurrency: 2 } })
    expect(updated).toMatchObject({ name: "Renamed", settings: { concurrency: 2 } })
    await expect(local.coordinationUpdate({ groupID: group.id, revision: group.revision, name: "Stale" })).rejects.toMatchObject({ kind: "conflict" })
    await local.deleteSession("ses_member", { directory })
    expect((await local.coordinationGet({ groupID: group.id })).members).toEqual([])
    await local.coordinationDelete({ groupID: group.id })
    expect(await local.coordinationList()).toEqual([])
    expect(await local.getSession("ses_master", { directory })).toMatchObject({ id: "ses_master" })
    await local.coordinationCreate({ name: "Second", masterSessionID: "ses_master", memberSessionIDs: [] })
    await local.deleteSession("ses_master", { directory })
    expect(await local.coordinationList()).toEqual([])
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)

test("remote Session creation honors an explicit title for a new Master and members, and adoption keeps the stored title", async () => {
  const home = await realpath(await mkdtemp(join(import.meta.dir, ".remote-coordination-")))
  const directory = join(home, "release")
  await mkdir(directory)
  const server = await startServer(directory)
  try {
    const local = createLocalServer({ url: server.base, auth: { type: "basic", username: "ycoding", password } })
    await createSession(server, "ses_existing_member", directory)
    const sessions = createSessionRegistry({ local })
    await sessions.refresh()
    const subscriptions = createSubscriptions()
    const [listed] = await executeRemoteOperation({ request: { type: "request", id: "req_workspaces", operation: "workspace.list" }, local, sessions, subscriptions })
    expect(listed).toMatchObject({ ok: true })
    const workspace = (listed as { value: { data: Array<{ id: string; directory: string }> } }).value.data.find((item) => item.directory === directory)?.id
    if (workspace === undefined) throw new Error("Recorded Session workspace is missing")
    const create = async (id: string, title?: string) => {
      const [frame] = await executeRemoteOperation({ request: { type: "request", id: `req_${id}`, operation: "session.create", input: { id, workspace, ...(title === undefined ? {} : { title }) } }, local, sessions, subscriptions })
      expect(frame).toMatchObject({ type: "response", ok: true })
      return (frame as { value: { data: { id: string; title: string } } }).value.data
    }
    expect(await create("ses_master", "Release Project")).toMatchObject({ id: "ses_master", title: "Release Project" })
    expect(await create("ses_new_member", "Docs member")).toMatchObject({ id: "ses_new_member", title: "Docs member" })
    const untitled = (await local.getSession("ses_existing_member", { directory })).title
    expect(untitled).not.toBe("Docs member")
    const group = await local.coordinationCreate({ name: "Release Project", masterSessionID: "ses_master", memberSessionIDs: ["ses_new_member"] })
    expect(await local.coordinationAttach({ groupID: group.id, sessionID: "ses_existing_member" })).toMatchObject({ sessionID: "ses_existing_member", ownerSessionID: "ses_master", reconciled: false })
    const project = await local.coordinationGet({ groupID: group.id })
    expect(project.master).toMatchObject({ sessionID: "ses_master", title: "Release Project" })
    expect(Object.fromEntries(project.members.map((member) => [member.sessionID, member.title])))
      .toEqual({ ses_new_member: "Docs member", ses_existing_member: untitled })
    expect(await create("ses_master", "Renamed by retry")).toMatchObject({ id: "ses_master", title: "Release Project" })
    expect((await local.getSession("ses_master", { directory })).title).toBe("Release Project")
  } finally {
    await server.close()
    await rm(home, { recursive: true, force: true })
  }
}, 30000)

async function insideGitWorkTree(directory: string) {
  const git = Bun.spawn(["git", "-C", directory, "rev-parse", "--is-inside-work-tree"], { stdout: "pipe", stderr: "pipe" })
  await git.exited
  return git.exitCode === 0
}

test("a Project in folders outside any Git work tree is created, listed, opened, attached to and detached from through real routes", async () => {
  const home = await realpath(await mkdtemp(join(homedir(), ".ycoding-project-adopt-")))
  expect(await insideGitWorkTree(home), "scratch under the home directory must not be inside a Git work tree").toBe(false)
  const typed = (name: string) => `~/${relative(homedir(), join(home, name))}`
  const masterDirectory = join(home, "Client Work", "New Project")
  const memberDirectory = join(home, "Members", "Docs")
  const independentDirectory = join(home, "Independent", "Notes")
  const server = await startServer(home, { provider: { text: "Existing history" } })
  try {
    if (!server.provider) throw new Error("Missing isolated provider")
    const model = { providerID: server.provider.providerID, id: server.provider.modelID }
    const local = createLocalServer({ url: server.base, auth: { type: "basic", username: "ycoding", password } })
    const sessions = createSessionRegistry({ local })
    const subscriptions = createSubscriptions()
    const run = async (operation: RemoteRequest["operation"], input?: Record<string, unknown>, sessionID?: string) => {
      const [frame] = await executeRemoteOperation({
        request: { type: "request", id: `req_${operation}`, operation, ...(input === undefined ? {} : { input }), ...(sessionID === undefined ? {} : { sessionID }) },
        local, sessions, subscriptions,
      })
      if (!frame?.ok) throw new Error(JSON.stringify(frame))
      const value = frame.value as Record<string, any>
      return "data" in value ? value.data : value
    }
    const create = (id: string, directory: string, extra: Record<string, unknown> = {}) => run("session.create", { id, scope: "bound", directory, ...extra })

    expect(await Bun.file(masterDirectory).exists()).toBe(false)
    const master = await create("ses_master", typed("Client Work/New Project"), { title: "New Project" })
    expect(master).toMatchObject({ id: "ses_master", title: "New Project", location: { directory: masterDirectory } })
    expect((await stat(masterDirectory)).isDirectory()).toBe(true)
    expect(await insideGitWorkTree(masterDirectory)).toBe(false)

    const workspaces: Array<{ id: string; directory: string }> = await run("workspace.list")
    const registered = workspaces.find((item) => item.directory === masterDirectory)
    expect(registered).toBeDefined()
    expect((await run("session.list")).map((session: { id: string }) => session.id)).toContain("ses_master")
    expect(await run("session.get", undefined, "ses_master")).toMatchObject({ id: "ses_master", location: { directory: masterDirectory } })
    expect(await run("workspace.catalog", { workspace: registered?.id })).toHaveProperty("agents")

    const group = await run("coordination.create", { name: "New Project", masterSessionID: "ses_master", memberSessionIDs: [] })
    expect(group).toMatchObject({ master: { sessionID: "ses_master", location: { directory: masterDirectory } }, members: [] })

    const member = await create("ses_member", memberDirectory)
    expect(member.location.directory).toBe(memberDirectory)
    expect(await insideGitWorkTree(memberDirectory)).toBe(false)
    const independent = await create("ses_independent", independentDirectory, { model })
    expect(independent.location.directory).toBe(independentDirectory)
    expect(await insideGitWorkTree(independentDirectory)).toBe(false)

    await local.prompt("ses_independent", { directory: independentDirectory }, { id: "msg_history", text: "Remember this." })
    const deadline = Date.now() + 30_000
    const messages = () => local.messages("ses_independent", { directory: independentDirectory })
    const history = async () => (await messages()).map((message) => message.id)
    while (!(await messages()).some((message) => message.type === "assistant" && message.time.completed !== undefined)) {
      if (Date.now() >= deadline) throw new Error("Independent Session history did not settle")
      await Bun.sleep(10)
    }
    const before = await history()

    const attachPath = `/api/coordination/${group.id}/members`
    expect((await fetch(`${server.base}${attachPath}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionID: "ses_member" }) })).status).toBe(401)
    expect((await fetch(`${server.base}${attachPath}/ses_member`, { method: "DELETE" })).status).toBe(401)

    expect(await run("coordination.attach", { groupID: group.id, sessionID: "ses_member" })).toMatchObject({ groupID: group.id, sessionID: "ses_member", location: { directory: memberDirectory }, ownerSessionID: "ses_master", reconciled: false })
    expect(await run("coordination.attach", { groupID: group.id, sessionID: "ses_independent" })).toMatchObject({ sessionID: "ses_independent", location: { directory: independentDirectory }, reconciled: false })
    expect(await run("coordination.attach", { groupID: group.id, sessionID: "ses_independent" })).toMatchObject({ sessionID: "ses_independent", reconciled: true })
    const attached = await run("coordination.get", { groupID: group.id })
    expect(Object.fromEntries(attached.members.map((item: { sessionID: string; location: { directory: string } }) => [item.sessionID, item.location.directory])))
      .toEqual({ ses_member: memberDirectory, ses_independent: independentDirectory })
    expect(await history()).toEqual(before)
    expect((await local.getSession("ses_independent", { directory: independentDirectory })).location.directory).toBe(independentDirectory)

    expect(await run("coordination.detach", { groupID: group.id, sessionID: "ses_independent" })).toEqual({ sessionID: "ses_independent", removed: true })
    expect((await run("coordination.get", { groupID: group.id })).members.map((item: { sessionID: string }) => item.sessionID)).toEqual(["ses_member"])
    expect(await run("session.get", undefined, "ses_independent")).toMatchObject({ id: "ses_independent", location: { directory: independentDirectory } })
    expect(await history()).toEqual(before)
    expect((await stat(independentDirectory)).isDirectory()).toBe(true)
    await expect(run("coordination.detach", { groupID: group.id, sessionID: "ses_independent" })).rejects.toThrow()
  } finally {
    await server.close()
    await rm(home, { recursive: true, force: true })
  }
}, 60000)
