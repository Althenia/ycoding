import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { message } from "./synthetic-backend"
import { syntheticDesktop, type SyntheticCall } from "./synthetic-desktop"

const participant = (sessionID: string) => ({ sessionID, title: sessionID, location: { directory: "/synthetic/repo" }, state: "idle", lastActivity: 1, pending: [] })
const group = { id: "cgrp_team", name: "Team", revision: 5, active: true, master: participant("ses_parent"), members: [participant("ses_child")], settings: { concurrency: null }, time: { created: 1, updated: 2 } }
const session = (directory: string) => ({ id: "ses_new", title: "Created", location: { directory }, time: { created: 1, updated: 2 }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 })
const routes = (calls: readonly SyntheticCall[]) => calls.filter((call) => call.route === "/api/location" || (call.route === "/api/session" && call.method === "POST")).map((call) => call.route === "/api/location" ? `location ${call.query.get("location[directory]")}` : `session ${(call.body.location as { directory: string }).directory}`)

const flows = [
  ["create-in-directory", (revision: number, directory: string) => ({ kind: "create-in-directory", revision, name: "Team", directory, memberSessionIDs: [] })],
  ["new-member", (revision: number, directory: string) => ({ kind: "new-member", revision, groupID: "cgrp_team", groupRevision: 5, directory, title: "Helper" })],
] as const

async function scenario(run: (owned: Awaited<ReturnType<typeof syntheticDesktop>>, options: { registration: "ok" | "fail" }) => Promise<void>) {
  const options = { registration: "ok" as "ok" | "fail" }
  const owned = await syntheticDesktop((call) => {
    if (call.route === "/api/location") return options.registration === "fail" ? new Response(null, { status: 500 }) : { directory: call.query.get("location[directory]"), project: { id: "prj_test" } }
    if (call.route === "/api/session" && call.method === "POST") return { data: session((call.body.location as { directory: string }).directory) }
    if (call.route === "/api/coordination/cgrp_team") return { data: call.method === "GET" ? group : { ...group, revision: 6 } }
    if (call.route === "/api/coordination" && call.method === "POST") return { data: { ...group, master: participant("ses_new") } }
    return undefined
  })
  const home = spyOn(os, "homedir").mockReturnValue(owned.resources)
  try { await run(owned, options) }
  finally {
    home.mockRestore()
    await fs.chmod(path.join(owned.resources, "locked"), 0o700).catch(() => undefined)
    await owned.close()
  }
}

const isDirectory = (target: string) => fs.stat(target).then((info) => info.isDirectory(), () => false)

test.each(flows)("%s expands ~, normalizes the path, creates missing folders and registers before creating the root Session", async (_name, input) => {
  await scenario(async (owned) => {
    const nested = path.join(owned.resources, "work", "team", "app")
    await owned.controller.changeProject(input(owned.revision, "~/work/team/../team/app/"))
    expect(await isDirectory(nested)).toBe(true)
    expect(routes(owned.calls)).toEqual([`location ${nested}`, `session ${nested}`])
    await owned.controller.changeProject(input(owned.revision, "~"))
    expect(routes(owned.calls).slice(2)).toEqual([`location ${owned.resources}`, `session ${owned.resources}`])
    const plain = path.join(owned.resources, "plain")
    await fs.mkdir(plain)
    await owned.controller.changeProject(input(owned.revision, `${plain}//`))
    expect(routes(owned.calls).slice(4)).toEqual([`location ${plain}`, `session ${plain}`])
  })
})

test.each(flows)("%s keeps the exact Git subfolder instead of the repository root", async (_name, input) => {
  await scenario(async (owned) => {
    const root = path.join(owned.resources, "repo")
    const subfolder = path.join(root, "packages", "app")
    await fs.mkdir(path.join(root, ".git"), { recursive: true })
    await fs.mkdir(subfolder, { recursive: true })
    await owned.controller.changeProject(input(owned.revision, subfolder))
    expect(routes(owned.calls)).toEqual([`location ${subfolder}`, `session ${subfolder}`])
    await owned.controller.changeProject(input(owned.revision, path.join(subfolder, "new", "leaf")))
    expect(await isDirectory(path.join(subfolder, "new", "leaf"))).toBe(true)
    expect(await isDirectory(path.join(root, "new"))).toBe(false)
  })
})

test.each(flows)("%s rejects relative, empty, files and inaccessible paths before any backend write", async (_name, input) => {
  await scenario(async (owned) => {
    const file = path.join(owned.resources, "file.txt")
    await fs.writeFile(file, "synthetic")
    await fs.mkdir(path.join(owned.resources, "locked"))
    await fs.chmod(path.join(owned.resources, "locked"), 0o500)
    const rejected: [string, string][] = [
      ["relative/path", "Enter an absolute folder path or one starting with ~/."],
      ["./here", "Enter an absolute folder path or one starting with ~/."],
      ["~someone/work", "Enter an absolute folder path or one starting with ~/."],
      ["   ", "Enter an absolute folder path or one starting with ~/."],
      [file, "Choose a folder, not a file."],
      [path.join(file, "child"), "A parent of this path is a file. Choose another folder."],
      [path.join(owned.resources, "locked", "child"), "This folder cannot be created. Check the parent folder's access permissions."],
    ]
    for (const [directory, expected] of rejected) expect(await message(owned.controller.changeProject(input(owned.revision, directory)))).toBe(expected)
    expect(routes(owned.calls)).toEqual([])
    expect(owned.calls.some((call) => call.method !== "GET")).toBe(false)
    expect(await isDirectory(path.join(owned.resources, "locked", "child"))).toBe(false)
  })
})

test.each(flows)("%s makes no folder when the connection revision is stale", async (_name, input) => {
  await scenario(async (owned) => {
    const target = path.join(owned.resources, "stale", "leaf")
    await expect(owned.controller.changeProject(input(owned.revision + 1, target))).rejects.toThrow()
    expect(await isDirectory(path.join(owned.resources, "stale"))).toBe(false)
    expect(routes(owned.calls)).toEqual([])
  })
})

test.each(flows)("%s stops before creating a Session when registration fails and says the folder exists", async (_name, input) => {
  await scenario(async (owned, options) => {
    options.registration = "fail"
    const target = path.join(owned.resources, "registered", "leaf")
    expect(await message(owned.controller.changeProject(input(owned.revision, target)))).toContain("registration failed")
    expect(await isDirectory(target)).toBe(true)
    expect(routes(owned.calls)).toEqual([`location ${target}`])
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
