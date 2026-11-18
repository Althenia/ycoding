import { expect, test } from "bun:test"
import { QueryClient, QueryObserver } from "@tanstack/solid-query"
import { renderToString } from "solid-js/web"
import { ProjectPanel, projectDirectoryTarget, type ProjectsData } from "./projects"
import type { ProjectDetail } from "../coordination"

const project: ProjectDetail = {
  id: "cgrp_sample", name: "Sample", revision: 1, active: true, created: 1, updated: 1,
  settings: { concurrency: 2 },
  master: { sessionID: "ses_master", title: "Lead", directory: "/workspace/master", state: "running", lastActivity: 1, pending: [] },
  members: [{ sessionID: "ses_member", title: "Member", directory: "/workspace/member", state: "waiting", lastActivity: 1,
    pending: [{ kind: "permission", requestID: "req_sample", summary: "Approve workspace access" }] }],
}

test("Project rows keep waiting requests and navigation visible while details mount on demand", () => {
  const query = new QueryObserver<NonNullable<ReturnType<ProjectsData["query"]>["data"]>>(new QueryClient(), {
    queryKey: ["project-panel"], enabled: false,
    queryFn: async () => { throw new Error("Initial Project rows do not start queries") },
  })
  const data: ProjectsData = {
    now: () => 1, notice: () => undefined, pending: () => false,
    freshness: () => ({ stale: false, text: "Updated just now" }),
    get remote(): never { throw new Error("Initial Project rows do not read the connection") },
    query: () => query.getCurrentResult(),
    connected: () => true,
    ready: () => undefined,
    groups: () => [],
    creating: () => false,
    setCreating: () => { throw new Error("Unexpected creation change") },
    setPending: () => { throw new Error("Unexpected pending change") },
    setNotice: () => { throw new Error("Unexpected notice change") },
    dialog: () => undefined,
    setDialog: () => { throw new Error("Unexpected dialog change") },
    run: async () => false,
    report: (result): result is { readonly reached: true } => result.reached,
    refresh: () => { throw new Error("Unexpected refresh") },
    membership: () => undefined,
    open: () => { throw new Error("Unexpected navigation") },
  }
  const html = renderToString(() => <ProjectPanel data={data} project={project} />)
  expect(html).toContain("Approve workspace access")
  expect(html).toContain('aria-label="Open session Member"')
  expect(html).toContain('aria-label="Details for Member"')
  expect(html).toContain('aria-expanded="false"')
  expect(html).not.toContain("/workspace/member")
  expect(html).not.toContain('aria-label="Delete session Member"')
  expect(html).toContain('aria-label="Project sessions" aria-expanded="true"')
  expect(html).toContain('aria-label="Project settings" aria-expanded="false"')
  expect(html).not.toContain("Save name")
})

test("closed Project context gives its entire column back to chat and wraps row identity", async () => {
  const css = await Bun.file(new URL("projects.css", import.meta.url)).text()
  expect(css).toMatch(/\.workspace\.workspace--project-closed\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/)
  expect(css).toMatch(/\.project-member strong[^}]*white-space:\s*normal/)
})

test("typed paths become directory targets and known choices keep their workspace", () => {
  expect(projectDirectoryTarget("  /srv/new app ", "")).toEqual({ target: { directory: "/srv/new app" } })
  expect(projectDirectoryTarget("~", "")).toEqual({ target: { directory: "~" } })
  expect(projectDirectoryTarget("~/code/x", "")).toEqual({ target: { directory: "~/code/x" } })
  expect(projectDirectoryTarget("/known", "wsp_known")).toEqual({ target: { workspace: "wsp_known" } })
  expect(projectDirectoryTarget("", "")).toEqual({ error: "Choose a directory" })
  for (const rejected of ["relative/dir", "~other/x", "C:work", "C:", "work\\repo", "\\\\fileserver", "\\\\fileserver\\", "\\\\?\\C:\\x"])
    expect(projectDirectoryTarget(rejected, "")).toMatchObject({ error: expect.stringContaining("Enter an absolute path") })
})

test("Windows, UNC and backslash home paths reach the target exactly as typed, trimming only the outer whitespace", () => {
  for (const typed of ["C:\\Work\\Repo", "d:/Work/Repo", "C:\\", "\\\\fileserver\\share\\Team Plan\\", "~\\notes", "~/notes", "/srv/new app"]) {
    expect(projectDirectoryTarget(typed, "")).toEqual({ target: { directory: typed } })
    expect(projectDirectoryTarget(`\t  ${typed}  \n`, "")).toEqual({ target: { directory: typed } })
  }
  expect(projectDirectoryTarget("C:\\Work\\ Repo ", "")).toEqual({ target: { directory: "C:\\Work\\ Repo" } })
})
