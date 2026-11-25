/** @jsxImportSource @opentui/solid */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { SessionInfo } from "@ycoding-ai/client"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { onMount } from "solid-js"
import { DialogSessionList } from "../src/component/dialog-session-list"
import { ConfigProvider } from "../src/config"
import { ArgsProvider } from "../src/context/args"
import { ClientProvider } from "../src/context/client"
import { DataProvider } from "../src/context/data"
import { Keymap } from "../src/context/keymap"
import { LocalProvider } from "../src/context/local"
import { LocationProvider, useLocation } from "../src/context/location"
import { RouteProvider } from "../src/context/route"
import { ThemeProvider } from "../src/context/theme"
import { DialogProvider, useDialog } from "../src/ui/dialog"
import { ToastProvider } from "../src/ui/toast"
import { createApi, createEventStream, createFetch, json } from "./fixture/tui-client"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

const now = Date.now()
let root = ""
let repoA = ""
let repoASub = ""
let repoAWt = ""
let repoAClone = ""
let repoB = ""
let plainA = ""
let plainASub = ""
let plainB = ""
let stateRoot = ""
let renderCount = 0

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
  await writeFile(path.join(dir, "README.md"), "fixture\n")
  git(dir, ["add", "README.md"])
  git(dir, ["commit", "-q", "-m", "init"])
}

function makeSession(input: {
  id: string
  title: string
  projectID: string
  directory: string
  updated?: number
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
      updated: input.updated ?? now - 10_000,
      ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
    },
    title: input.title,
    location: { directory: input.directory },
    agent: "build",
    model: { providerID: "anthropic", id: "claude-opus-5" },
  }
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ycoding-tui-session-scope-"))
  stateRoot = path.join(root, "state")
  repoA = path.join(root, "repo-a")
  repoASub = path.join(repoA, "packages", "tui")
  repoAWt = path.join(root, "repo-a-wt")
  repoAClone = path.join(root, "repo-a-clone")
  repoB = path.join(root, "repo-b")
  plainA = path.join(root, "plain-a")
  plainASub = path.join(plainA, "nested")
  plainB = path.join(root, "plain-b")

  await initRepo(repoA)
  await mkdir(repoASub, { recursive: true })
  git(repoA, ["worktree", "add", "-q", "-b", "wt-branch", repoAWt])
  await initRepo(repoAClone)
  await initRepo(repoB)
  await mkdir(plainASub, { recursive: true })
  await mkdir(plainB, { recursive: true })
})

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

type LocationInfo = {
  directory: string
  project: { id: string; directory: string }
}

async function renderScopePicker(input: {
  location: LocationInfo
  sessions: readonly SessionInfo[]
  runningIDs?: readonly string[]
}) {
  const sessionState = path.join(stateRoot, String(renderCount++))
  await mkdir(sessionState, { recursive: true })
  const events = createEventStream()
  const requests: URL[] = []
  const byID = new Map(input.sessions.map((session) => [session.id, session]))
  const running = new Set(input.runningIDs ?? [])

  const transport = createFetch((url) => {
    if (url.pathname === "/api/location") return json(input.location)
    if (url.pathname === "/api/session") {
      requests.push(url)
      let rows = [...input.sessions].filter((session) => !session.parentID)
      const pinned = url.searchParams.get("pinned")
      if (pinned === "true") rows = rows.filter((session) => session.time.pinned !== undefined)
      if (pinned === "false") rows = rows.filter((session) => session.time.pinned === undefined)
      const project = url.searchParams.get("project")
      if (project !== null) rows = rows.filter((session) => session.projectID === project)
      const dir = url.searchParams.get("directory")
      if (dir !== null) rows = rows.filter((session) => session.location.directory === dir)
      const search = url.searchParams.get("search")
      if (search !== null) {
        const needle = search.toLowerCase()
        rows = rows.filter((session) => session.title.toLowerCase().includes(needle))
      }
      rows.sort((a, b) => b.time.updated - a.time.updated)
      const limit = Number(url.searchParams.get("limit") ?? "50")
      return json({ data: rows.slice(0, limit), cursor: {} })
    }
    if (url.pathname === "/api/session/active") {
      return json({
        data: Object.fromEntries([...running].map((id) => [id, { type: "running" as const }])),
      })
    }
    if (url.pathname === "/api/session/outstanding") {
      return json({ data: [...running], running: [...running], waiting: [], failed: [], lost: [] })
    }
    if (url.pathname === "/api/decision") return json({ data: [] })
    const detail = /^\/api\/session\/([^/]+)$/.exec(url.pathname)?.[1]
    if (detail && byID.has(detail)) return json({ data: byID.get(detail) })
    return undefined
  }, events)

  function Fixture() {
    const dialog = useDialog()
    const loc = useLocation()
    onMount(() => {
      loc.set({ directory: input.location.directory })
      dialog.replace(() => <DialogSessionList />)
    })
    return null
  }

  const config = createTuiResolvedConfig()
  const app = await testRender(
    () => (
      <TestTuiContexts
        cwd={input.location.directory}
        directory={input.location.directory}
        paths={{ home: root, state: sessionState, worktree: input.location.project.directory }}
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
    { width: 120, height: 64 },
  )
  app.renderer.start()
  return {
    app,
    requests,
    destroy: () => {
      app.renderer.destroy()
      events.disconnect()
    },
  }
}

describe("DialogSessionList scope boundaries", () => {
  test("excludes unrelated repos including separate clones sharing projectID from Recent", async () => {
    const { app, destroy } = await renderScopePicker({
      location: { directory: repoA, project: { id: "proj_shared", directory: repoA } },
      sessions: [
        makeSession({ id: "ses_main", title: "Main repo recent", projectID: "proj_shared", directory: repoA, updated: now - 1_000 }),
        makeSession({ id: "ses_clone", title: "Separate clone idle", projectID: "proj_shared", directory: repoAClone, updated: now - 500 }),
        makeSession({ id: "ses_other", title: "Unrelated repo idle", projectID: "proj_b", directory: repoB, updated: now - 200 }),
        makeSession({ id: "ses_plain", title: "Plain dir idle", projectID: "global", directory: plainA, updated: now - 100 }),
      ],
    })
    try {
      await app.waitForFrame((frame) => frame.includes("Main repo recent"))
      await Bun.sleep(100)
      const frame = app.captureCharFrame()
      expect(frame).toContain("Recent")
      expect(frame).toContain("Main repo recent")
      expect(frame).not.toContain("Separate clone idle")
      expect(frame).not.toContain("Unrelated repo idle")
      expect(frame).not.toContain("Plain dir idle")
    } finally {
      destroy()
    }
  })

  test("includes linked worktree and main repo subdirectories matched by shared git common directory", async () => {
    const { app, destroy } = await renderScopePicker({
      location: { directory: repoAWt, project: { id: "proj_shared", directory: repoAWt } },
      sessions: [
        makeSession({ id: "ses_wt", title: "Worktree recent", projectID: "proj_shared", directory: repoAWt, updated: now - 1_000 }),
        makeSession({ id: "ses_main_sub", title: "Main subdir recent", projectID: "proj_shared", directory: repoASub, updated: now - 2_000 }),
        makeSession({ id: "ses_main_legacy", title: "Main legacy id recent", projectID: "proj_legacy", directory: repoA, updated: now - 3_000 }),
        makeSession({ id: "ses_clone", title: "Separate clone recent", projectID: "proj_shared", directory: repoAClone, updated: now - 500 }),
        makeSession({ id: "ses_other", title: "Other repo recent", projectID: "proj_b", directory: repoB, updated: now - 400 }),
      ],
    })
    try {
      await app.waitForFrame((frame) => frame.includes("Worktree recent") && frame.includes("Main legacy id recent"))
      await Bun.sleep(100)
      const frame = app.captureCharFrame()
      expect(frame).toContain("Recent")
      expect(frame).toContain("Worktree recent")
      expect(frame).toContain("Main subdir recent")
      expect(frame).toContain("Main legacy id recent")
      expect(frame).not.toContain("Separate clone recent")
      expect(frame).not.toContain("Other repo recent")
    } finally {
      destroy()
    }
  })

  test("outside a repo uses only the current directory for Recent while keeping cross-repo Pinned and Running", async () => {
    const { app, requests, destroy } = await renderScopePicker({
      location: { directory: plainA, project: { id: "global", directory: "/" } },
      sessions: [
        makeSession({ id: "ses_plain_a", title: "Current plain dir", projectID: "global", directory: plainA, updated: now - 1_000 }),
        makeSession({ id: "ses_plain_b", title: "Other plain dir", projectID: "global", directory: plainB, updated: now - 500 }),
        makeSession({ id: "ses_plain_sub", title: "Child plain dir", projectID: "global", directory: plainASub, updated: now - 400 }),
        makeSession({ id: "ses_repo_a", title: "Repo idle session", projectID: "proj_shared", directory: repoA, updated: now - 300 }),
        makeSession({ id: "ses_pin_other", title: "Pinned in repo B", projectID: "proj_b", directory: repoB, updated: now - 2_000, pinned: now - 5_000 }),
        makeSession({ id: "ses_run_other", title: "Running in plain B", projectID: "global", directory: plainB, updated: now - 1_500 }),
      ],
      runningIDs: ["ses_run_other"],
    })
    try {
      await app.waitForFrame(
        (frame) =>
          frame.includes("Current plain dir") &&
          frame.includes("Pinned in repo B") &&
          frame.includes("Running in plain B"),
      )
      await Bun.sleep(100)
      const frame = app.captureCharFrame()
      expect(frame).toContain("Pinned")
      expect(frame).toContain("Running")
      expect(frame).toContain("Recent")
      expect(frame).toContain("Pinned in repo B")
      expect(frame).toContain("Running in plain B")
      expect(frame).toContain("Current plain dir")
      expect(frame).not.toContain("Other plain dir")
      expect(frame).not.toContain("Child plain dir")
      expect(frame).not.toContain("Repo idle session")
      expect(requests.some((url) => url.searchParams.get("project") === "global")).toBe(false)
      expect(requests.some((url) => url.searchParams.get("directory") === plainA)).toBe(true)
    } finally {
      destroy()
    }
  })

  test("shows cross-repo Pinned and Running sessions across git repos and non-repo directories", async () => {
    const { app, destroy } = await renderScopePicker({
      location: { directory: repoA, project: { id: "proj_shared", directory: repoA } },
      sessions: [
        makeSession({ id: "ses_pin_b", title: "Pinned repo B", projectID: "proj_b", directory: repoB, pinned: now - 5_000 }),
        makeSession({ id: "ses_pin_plain", title: "Pinned plain B", projectID: "global", directory: plainB, pinned: now - 4_000 }),
        makeSession({ id: "ses_run_b", title: "Running repo B", projectID: "proj_b", directory: repoB, updated: now - 1_000 }),
        makeSession({ id: "ses_run_plain", title: "Running plain B", projectID: "global", directory: plainB, updated: now - 2_000 }),
        makeSession({ id: "ses_idle_b", title: "Idle repo B", projectID: "proj_b", directory: repoB, updated: now - 100 }),
        makeSession({ id: "ses_wt", title: "Recent worktree A", projectID: "proj_shared", directory: repoAWt, updated: now - 3_000 }),
      ],
      runningIDs: ["ses_run_b", "ses_run_plain"],
    })
    try {
      await app.waitForFrame(
        (frame) =>
          frame.includes("Pinned repo B") &&
          frame.includes("Pinned plain B") &&
          frame.includes("Running repo B") &&
          frame.includes("Running plain B") &&
          frame.includes("Recent worktree A"),
      )
      const frame = app.captureCharFrame()
      expect(frame.indexOf("Pinned")).toBeLessThan(frame.indexOf("Running"))
      expect(frame.indexOf("Running")).toBeLessThan(frame.indexOf("Recent"))
      expect(frame).not.toContain("Idle repo B")
    } finally {
      destroy()
    }
  })

  test("deduplicates pinned and running current-repo sessions in section precedence order", async () => {
    const { app, destroy } = await renderScopePicker({
      location: { directory: repoA, project: { id: "proj_shared", directory: repoA } },
      sessions: [
        makeSession({ id: "ses_both", title: "Pinned running local", projectID: "proj_shared", directory: repoA, updated: now - 500, pinned: now - 5_000 }),
        makeSession({ id: "ses_run_local", title: "Running worktree local", projectID: "proj_shared", directory: repoAWt, updated: now - 1_000 }),
        makeSession({ id: "ses_recent_local", title: "Idle recent local", projectID: "proj_shared", directory: repoA, updated: now - 2_000 }),
      ],
      runningIDs: ["ses_both", "ses_run_local"],
    })
    try {
      await app.waitForFrame(
        (frame) =>
          frame.includes("Pinned running local") &&
          frame.includes("Running worktree local") &&
          frame.includes("Idle recent local"),
      )
      const frame = app.captureCharFrame()
      expect(frame.split("Pinned running local").length - 1).toBe(1)
      expect(frame.split("Running worktree local").length - 1).toBe(1)
      expect(frame.split("Idle recent local").length - 1).toBe(1)
      expect(frame.indexOf("Pinned")).toBeLessThan(frame.indexOf("Pinned running local"))
      expect(frame.indexOf("Pinned running local")).toBeLessThan(frame.indexOf("Running"))
      expect(frame.indexOf("Running")).toBeLessThan(frame.indexOf("Running worktree local"))
      expect(frame.indexOf("Running worktree local")).toBeLessThan(frame.indexOf("Recent"))
      expect(frame.indexOf("Recent")).toBeLessThan(frame.indexOf("Idle recent local"))
    } finally {
      destroy()
    }
  })

  test("search spans global Pinned and Running while keeping Recent scoped in repos and non-repo directories", async () => {
    const repoRun = await renderScopePicker({
      location: { directory: repoA, project: { id: "proj_shared", directory: repoA } },
      sessions: [
        makeSession({ id: "ses_pin_hit", title: "Pinned deploy audit", projectID: "proj_b", directory: repoB, pinned: now - 5_000 }),
        makeSession({ id: "ses_pin_local_hit", title: "Local pinned deploy", projectID: "proj_shared", directory: repoA, pinned: now - 4_000 }),
        makeSession({ id: "ses_run_hit", title: "Running deploy worker", projectID: "proj_b", directory: repoB, updated: now - 1_000 }),
        makeSession({ id: "ses_wt_hit", title: "Worktree deploy fix", projectID: "proj_shared", directory: repoAWt, updated: now - 2_000 }),
        makeSession({ id: "ses_clone_hit", title: "Clone deploy leak", projectID: "proj_shared", directory: repoAClone, updated: now - 500 }),
        makeSession({ id: "ses_other_hit", title: "Other repo deploy leak", projectID: "proj_b", directory: repoB, updated: now - 400 }),
      ],
      runningIDs: ["ses_run_hit"],
    })
    try {
      await repoRun.app.waitForFrame((frame) => frame.includes("Worktree deploy fix"))
      await repoRun.app.mockInput.typeText("deploy")
      await repoRun.app.waitFor(() =>
        repoRun.requests.some((url) => url.searchParams.get("search") === "deploy"),
      )
      await Bun.sleep(100)
      const frame = repoRun.app.captureCharFrame()
      expect(frame).toContain("Pinned deploy audit")
      expect(frame).toContain("Local pinned deploy")
      expect(frame.split("Local pinned deploy").length - 1).toBe(1)
      expect(frame).toContain("Running deploy worker")
      expect(frame).toContain("Worktree deploy fix")
      expect(frame).not.toContain("Clone deploy leak")
      expect(frame).not.toContain("Other repo deploy leak")
    } finally {
      repoRun.destroy()
    }

    const plainRun = await renderScopePicker({
      location: { directory: plainA, project: { id: "global", directory: "/" } },
      sessions: [
        makeSession({ id: "ses_pin_hit", title: "Pinned deploy audit", projectID: "proj_b", directory: repoB, pinned: now - 5_000 }),
        makeSession({ id: "ses_run_hit", title: "Running deploy plain", projectID: "global", directory: plainB, updated: now - 1_000 }),
        makeSession({ id: "ses_plain_hit", title: "Plain A deploy note", projectID: "global", directory: plainA, updated: now - 2_000 }),
        makeSession({ id: "ses_plain_leak", title: "Plain B deploy leak", projectID: "global", directory: plainB, updated: now - 500 }),
      ],
      runningIDs: ["ses_run_hit"],
    })
    try {
      await plainRun.app.waitForFrame((frame) => frame.includes("Plain A deploy note"))
      await plainRun.app.mockInput.typeText("deploy")
      await plainRun.app.waitFor(() =>
        plainRun.requests.some((url) => url.searchParams.get("search") === "deploy"),
      )
      await Bun.sleep(100)
      const frame = plainRun.app.captureCharFrame()
      expect(frame).toContain("Pinned deploy audit")
      expect(frame).toContain("Running deploy plain")
      expect(frame).toContain("Plain A deploy note")
      expect(frame).not.toContain("Plain B deploy leak")
      const searchRequests = plainRun.requests.filter((url) => url.searchParams.get("search") === "deploy")
      expect(searchRequests.some((url) => url.searchParams.get("project") === "global")).toBe(false)
      expect(searchRequests.some((url) => url.searchParams.get("directory") === plainA && url.searchParams.get("pinned") === "false")).toBe(true)
    } finally {
      plainRun.destroy()
    }
  })
})
