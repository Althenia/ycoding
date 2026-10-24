import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLocalServer } from "../src/remote-local"
import { createSessionRegistry, createSubscriptions, executeRemoteDirectorySession } from "../src/remote-operations"
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
  const home = await realpath(await mkdtemp(join(tmpdir(), "ycoding-project-title-")))
  const directory = join(home, "release")
  await mkdir(directory)
  const server = await startServer(directory)
  try {
    const local = createLocalServer({ url: server.base, auth: { type: "basic", username: "ycoding", password } })
    const sessions = createSessionRegistry({ local })
    await sessions.refresh()
    const subscriptions = createSubscriptions()
    const create = async (id: string, title?: string) => {
      const [frame] = await executeRemoteDirectorySession({ id: `req_${id}`, home, input: { id, directory, ...(title === undefined ? {} : { title }) }, local, sessions, subscriptions })
      expect(frame).toMatchObject({ type: "response", ok: true })
      return (frame as { value: { data: { id: string; title: string } } }).value.data
    }
    expect(await create("ses_master", "Release Project")).toMatchObject({ id: "ses_master", title: "Release Project" })
    expect(await create("ses_new_member", "Docs member")).toMatchObject({ id: "ses_new_member", title: "Docs member" })
    await createSession(server, "ses_existing_member", directory)
    const untitled = (await local.getSession("ses_existing_member", { directory })).title
    expect(untitled).not.toBe("Docs member")
    const group = await local.coordinationCreate({ name: "Release Project", masterSessionID: "ses_master", memberSessionIDs: ["ses_new_member"] })
    await local.coordinationUpdate({ groupID: group.id, revision: group.revision, memberSessionIDs: ["ses_new_member", "ses_existing_member"] })
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
