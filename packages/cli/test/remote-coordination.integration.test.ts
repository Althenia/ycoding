import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLocalServer } from "../src/remote-local"
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
