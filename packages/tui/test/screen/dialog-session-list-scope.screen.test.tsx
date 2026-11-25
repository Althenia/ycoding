/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import type { SessionInfo } from "@ycoding-ai/client"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { onMount } from "solid-js"
import { DialogSessionList } from "../../src/component/dialog-session-list"
import { ConfigProvider } from "../../src/config"
import { ArgsProvider } from "../../src/context/args"
import { ClientProvider } from "../../src/context/client"
import { DataProvider } from "../../src/context/data"
import { Keymap } from "../../src/context/keymap"
import { LocalProvider } from "../../src/context/local"
import { LocationProvider, useLocation } from "../../src/context/location"
import { RouteProvider } from "../../src/context/route"
import { ThemeProvider } from "../../src/context/theme"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { createApi, createEventStream, createFetch, json } from "../fixture/tui-client"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

const now = Date.now()
let root = ""
let repoMain = ""
let repoWorktree = ""
let repoClone = ""
let repoOther = ""
let stateDir = ""

function git(cwd: string, args: string[]) {
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
    stdio: "pipe",
  })
}

async function initRepo(dir: string) {
  await mkdir(dir, { recursive: true })
  git(dir, ["init", "-q"])
  await writeFile(path.join(dir, "README.md"), "screen fixture\n")
  git(dir, ["add", "README.md"])
  git(dir, ["commit", "-q", "-m", "init"])
}

function makeSession(input: {
  id: string
  title: string
  projectID: string
  directory: string
  updated: number
  pinned?: number
}): SessionInfo {
  return {
    id: input.id,
    projectID: input.projectID,
    scope: "bound",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: {
      created: now - 100_000,
      updated: input.updated,
      ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
    },
    title: input.title,
    location: { directory: input.directory },
    agent: "build",
    model: { providerID: "anthropic", id: "claude-opus-5" },
  }
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ycoding-tui-session-screen-"))
  stateDir = path.join(root, "state")
  repoMain = path.join(root, "alpha-repo")
  repoWorktree = path.join(root, "alpha-worktree")
  repoClone = path.join(root, "alpha-clone")
  repoOther = path.join(root, "beta-repo")

  await mkdir(stateDir, { recursive: true })
  await initRepo(repoMain)
  git(repoMain, ["worktree", "add", "-q", "-b", "feature-wt", repoWorktree])
  await initRepo(repoClone)
  await initRepo(repoOther)
})

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

test("renders Switch session with cross-repo Pinned and Running above current-repo and linked-worktree Recent", async () => {
  const location = { directory: repoMain, project: { id: "proj_alpha", directory: repoMain } }
  const sessions: SessionInfo[] = [
    makeSession({ id: "ses_pin_beta", title: "Pinned beta release", projectID: "proj_beta", directory: repoOther, updated: now - 5_000, pinned: now - 10_000 }),
    makeSession({ id: "ses_run_beta", title: "Running beta migration", projectID: "proj_beta", directory: repoOther, updated: now - 2_000 }),
    makeSession({ id: "ses_recent_main", title: "Alpha main cleanup", projectID: "proj_alpha", directory: repoMain, updated: now - 1_500 }),
    makeSession({ id: "ses_recent_wt", title: "Alpha worktree picker", projectID: "proj_alpha", directory: repoWorktree, updated: now - 1_000 }),
    makeSession({ id: "ses_clone_idle", title: "Alpha separate clone leak", projectID: "proj_alpha", directory: repoClone, updated: now - 500 }),
    makeSession({ id: "ses_other_idle", title: "Beta idle leak", projectID: "proj_beta", directory: repoOther, updated: now - 400 }),
  ]
  const byID = new Map(sessions.map((session) => [session.id, session]))
  const events = createEventStream()
  const transport = createFetch((url) => {
    if (url.pathname === "/api/location") return json(location)
    if (url.pathname === "/api/session") {
      let rows = [...sessions]
      const pinned = url.searchParams.get("pinned")
      if (pinned === "true") rows = rows.filter((session) => session.time.pinned !== undefined)
      if (pinned === "false") rows = rows.filter((session) => session.time.pinned === undefined)
      const project = url.searchParams.get("project")
      if (project !== null) rows = rows.filter((session) => session.projectID === project)
      const dir = url.searchParams.get("directory")
      if (dir !== null) rows = rows.filter((session) => session.location.directory === dir)
      rows.sort((a, b) => b.time.updated - a.time.updated)
      return json({ data: rows, cursor: {} })
    }
    if (url.pathname === "/api/session/active") return json({ data: { ses_run_beta: { type: "running" as const } } })
    if (url.pathname === "/api/session/outstanding")
      return json({ data: ["ses_run_beta"], running: ["ses_run_beta"], waiting: [], failed: [], lost: [] })
    if (url.pathname === "/api/decision") return json({ data: [] })
    const detail = /^\/api\/session\/([^/]+)$/.exec(url.pathname)?.[1]
    if (detail && byID.has(detail)) return json({ data: byID.get(detail) })
    return undefined
  }, events)

  function Fixture() {
    const dialog = useDialog()
    const loc = useLocation()
    onMount(() => {
      loc.set({ directory: repoMain })
      dialog.replace(() => <DialogSessionList />)
    })
    return null
  }

  const config = createTuiResolvedConfig()
  const viewport = { width: 120, height: 60 }
  const app = await testRender(
    () => (
      <TestTuiContexts
        cwd={repoMain}
        directory={repoMain}
        paths={{ home: root, state: stateDir, worktree: repoMain }}
      >
        <ConfigProvider config={config}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <ArgsProvider>
              <Keymap.Provider config={config}>
                <RouteProvider initialRoute={{ type: "home" }}>
                  <ClientProvider api={createApi(transport.fetch)}>
                    <DataProvider>
                      <LocationProvider>
                        <ToastProvider>
                          <LocalProvider>
                            <DialogProvider>
                              <Fixture />
                            </DialogProvider>
                          </LocalProvider>
                        </ToastProvider>
                      </LocationProvider>
                    </DataProvider>
                  </ClientProvider>
                </RouteProvider>
              </Keymap.Provider>
            </ArgsProvider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    viewport,
  )
  app.renderer.start()
  try {
    await app.waitForFrame(
      (frame) =>
        frame.includes("Pinned beta release") &&
        frame.includes("Running beta migration") &&
        frame.includes("Alpha main cleanup") &&
        frame.includes("Alpha worktree picker"),
    )
    await Bun.sleep(100)
    const frame = app.captureCharFrame()
    const rows = (frame.endsWith("\n") ? frame.slice(0, -1) : frame).split("\n")
    expect(rows).toHaveLength(viewport.height)
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(viewport.width)

    expect(frame).toContain("Switch session")
    expect(frame).toContain("Pinned")
    expect(frame).toContain("Running")
    expect(frame).toContain("Recent")
    expect(frame.indexOf("Pinned")).toBeLessThan(frame.indexOf("Pinned beta release"))
    expect(frame.indexOf("Pinned beta release")).toBeLessThan(frame.indexOf("Running"))
    expect(frame.indexOf("Running")).toBeLessThan(frame.indexOf("Running beta migration"))
    expect(frame.indexOf("Running beta migration")).toBeLessThan(frame.indexOf("Recent"))
    expect(frame.indexOf("Recent")).toBeLessThan(frame.indexOf("Alpha worktree picker"))
    expect(frame.indexOf("Alpha worktree picker")).toBeLessThan(frame.indexOf("Alpha main cleanup"))

    const pinnedRow = rows.find((row) => row.includes("Pinned beta release"))!
    const runningRow = rows.find((row) => row.includes("Running beta migration"))!
    const worktreeRow = rows.find((row) => row.includes("Alpha worktree picker"))!
    expect(pinnedRow).toContain("beta-repo")
    expect(runningRow).toContain("beta-repo")
    expect(worktreeRow).toContain("alpha-worktree")
    expect(frame).not.toContain("Alpha separate clone leak")
    expect(frame).not.toContain("Beta idle leak")
  } finally {
    app.renderer.destroy()
    events.disconnect()
  }
})
