import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { message } from "./synthetic-backend"
import { syntheticDesktop, type SyntheticCall } from "./synthetic-desktop"

const participant = (sessionID: string) => ({ sessionID, title: sessionID, location: { directory: "/synthetic/repo" }, state: "idle", lastActivity: 1, pending: [] })
const group = { id: "cgrp_team", name: "Team", revision: 5, active: true, master: participant("ses_parent"), members: [participant("ses_child")], settings: { concurrency: null }, time: { created: 1, updated: 2 } }
const session = (directory: string) => ({ id: "ses_new", title: "Created", location: { directory }, time: { created: 1, updated: 2 }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 })
const backendDirectory = (typed: string) => typed.startsWith("~") ? `/home/backend${typed.slice(1)}` : typed
const routes = (calls: readonly SyntheticCall[]) => calls.filter((call) => call.route === "/api/location" || (call.route === "/api/session" && call.method === "POST")).map((call) => call.route === "/api/location" ? `location ${call.query.get("location[directory]")}` : `session ${(call.body.location as { directory: string }).directory}`)

const flows = [
  ["create-in-directory", (revision: number, directory: string) => ({ kind: "create-in-directory", revision, name: "Team", directory, memberSessionIDs: [] })],
  ["new-member", (revision: number, directory: string) => ({ kind: "new-member", revision, groupID: "cgrp_team", groupRevision: 5, directory, title: "Helper" })],
] as const

async function scenario(run: (owned: Awaited<ReturnType<typeof syntheticDesktop>>) => Promise<void>) {
  const owned = await syntheticDesktop((call) => {
    if (call.route === "/api/session" && call.method === "POST") return { data: session(backendDirectory((call.body.location as { directory: string }).directory)) }
    if (call.route === "/api/coordination/cgrp_team/members" && call.method === "POST") return { data: { groupID: "cgrp_team", sessionID: call.body.sessionID, location: { directory: "/synthetic/repo" }, ownerSessionID: "ses_parent", reconciled: false } }
    if (call.route === "/api/coordination/cgrp_team") return { data: call.method === "GET" ? group : { ...group, revision: 6 } }
    if (call.route === "/api/coordination" && call.method === "POST") return { data: { ...group, master: participant("ses_new") } }
    return undefined
  })
  const home = spyOn(os, "homedir").mockReturnValue(owned.resources)
  try { await run(owned) }
  finally {
    home.mockRestore()
    await fs.chmod(path.join(owned.resources, "locked"), 0o700).catch(() => undefined)
    await owned.close()
  }
}

const isDirectory = (target: string) => fs.stat(target).then((info) => info.isDirectory(), () => false)

test.each(flows)("%s sends the typed placement unchanged to session.create with no local folder probe, registration or creation", async (_name, input) => {
  await scenario(async (owned) => {
    const typed = ["~/work/team/../team/app/", "~", `${owned.resources}//`, "/srv/new app", "C:\\Work\\Repo", "d:/Work/Repo", "\\\\fileserver\\share\\Team Plan", "~\\notes"]
    for (const directory of typed) await owned.controller.changeProject(input(owned.revision, `  ${directory}  `))
    expect(routes(owned.calls)).toEqual(typed.map((directory) => `session ${directory}`))
    expect(await isDirectory(path.join(owned.resources, "work"))).toBe(false)
    expect(await isDirectory(path.join(owned.resources, "notes"))).toBe(false)
    expect(await isDirectory(path.join(process.cwd(), "d:"))).toBe(false)
  })
})

test.each(flows)("%s keeps the exact Git subfolder and creates no folder on this machine", async (_name, input) => {
  await scenario(async (owned) => {
    const subfolder = path.join(owned.resources, "repo", "packages", "app", "new", "leaf")
    await owned.controller.changeProject(input(owned.revision, subfolder))
    expect(routes(owned.calls)).toEqual([`session ${subfolder}`])
    expect(await isDirectory(path.join(owned.resources, "repo"))).toBe(false)
  })
})

test.each(flows)("%s rejects relative, drive-relative, incomplete UNC, device and empty paths before any backend write", async (_name, input) => {
  await scenario(async (owned) => {
    const message_ = "Enter an absolute folder path on the backend machine (such as /srv/app, C:\\Work or \\\\server\\share\\dir), or one starting with ~."
    for (const directory of ["relative/path", "./here", "~someone/work", "   ", "C:work", "C:", "work\\repo", "\\\\fileserver", "\\\\fileserver\\", "\\\\?\\C:\\x", "\\\\.\\pipe\\x", `/${"a".repeat(4096)}`])
      expect(await message(owned.controller.changeProject(input(owned.revision, directory)))).toBe(message_)
    expect(owned.calls.some((call) => call.method !== "GET")).toBe(false)
  })
})

test.each(flows)("%s makes no backend write when the connection revision is stale", async (_name, input) => {
  await scenario(async (owned) => {
    await expect(owned.controller.changeProject(input(owned.revision + 1, "/srv/stale"))).rejects.toThrow()
    expect(routes(owned.calls)).toEqual([])
  })
})

test.each(flows)("%s accepts the backend's authoritative Location without comparing it to the typed spelling", async (_name, input) => {
  await scenario(async (owned) => {
    await expect(owned.controller.changeProject(input(owned.revision, "~/typed"))).resolves.toBeDefined()
    expect(routes(owned.calls)).toEqual(["session ~/typed"])
    expect(owned.calls.some((call) => call.method === "POST" && call.route.startsWith("/api/coordination"))).toBe(true)
  })
})

test("projects reports each non-Git directory as its own repository root and workspaces keeps every available directory", async () => {
  const inventory = [
    { projectID: "global", projectWorktree: "/", directory: "/synthetic/plain", sessions: 1, timeActive: 2, available: true },
    { projectID: "global", projectWorktree: "/", directory: "/synthetic/other", sessions: 1, timeActive: 1, available: true },
    { projectID: "prj_git", projectName: "Repo", projectWorktree: "/synthetic/repo", directory: "/synthetic/repo/pkg", sessions: 1, timeActive: 1, available: true },
    { projectID: "prj_git", projectWorktree: "/synthetic/repo", directory: "/synthetic/repo/gone", sessions: 1, timeActive: 1, available: false },
  ]
  const owned = await syntheticDesktop((call) => call.route === "/api/project/inventory" ? { data: inventory, cursor: {} } : undefined)
  try {
    const projects = await owned.controller.projects()
    expect(projects.repositories.map((entry) => [entry.projectID, entry.projectWorktree, entry.directory])).toEqual([
      ["global", "/synthetic/plain", "/synthetic/plain"],
      ["global", "/synthetic/other", "/synthetic/other"],
      ["prj_git", "/synthetic/repo", "/synthetic/repo/pkg"],
      ["prj_git", "/synthetic/repo", "/synthetic/repo/gone"],
    ])
    expect(await owned.controller.workspaces()).toEqual([{ directory: "/synthetic/plain" }, { directory: "/synthetic/other" }, { directory: "/synthetic/repo/pkg", name: "Repo" }])
  } finally { await owned.close() }
})
