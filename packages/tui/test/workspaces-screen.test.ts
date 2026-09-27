import { expect, mock, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { Global } from "@ycoding-ai/core/global"
import type { ProjectInventoryEntry } from "@ycoding-ai/client"
import { createEventStream, createFetch, directory, json, worktree, type FetchHandler } from "./fixture/tui-client"

const minutesAgo = (minutes: number) => Date.now() - minutes * 60_000

const inventory: ProjectInventoryEntry[] = [
  {
    projectID: "global",
    projectWorktree: "/",
    directory: "/tmp/scratch",
    sessions: 1,
    timeActive: minutesAgo(5),
    available: true,
  },
  {
    projectID: "proj_test",
    projectName: "ycoding",
    projectWorktree: worktree,
    directory: "/tmp/elsewhere/ycoding-old",
    sessions: 2,
    timeActive: minutesAgo(90),
    available: false,
  },
  {
    projectID: "proj_test",
    projectName: "ycoding",
    projectWorktree: worktree,
    directory: "/tmp/wt/ycoding-feature",
    strategy: "git_worktree",
    sessions: 1,
    timeActive: minutesAgo(10),
    available: true,
  },
  {
    projectID: "proj_test",
    projectName: "ycoding",
    projectWorktree: worktree,
    directory: worktree,
    sessions: 4,
    timeActive: minutesAgo(3),
    available: true,
  },
  {
    projectID: "proj_test",
    projectName: "ycoding",
    projectWorktree: worktree,
    directory,
    sessions: 3,
    timeActive: minutesAgo(1),
    available: true,
  },
]

type Recorded = { method: string; url: URL; body?: unknown }

async function launch(input: { width: number; handler?: FetchHandler }) {
  const setup = await createTestRenderer({ width: input.width, height: 34, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const setTitle = setup.renderer.setTerminalTitle.bind(setup.renderer)
  setup.renderer.setTerminalTitle = (title) => {
    if (title === "YCoding") started()
    setTitle(title)
  }
  const requests: Recorded[] = []
  const events = createEventStream()
  const calls = createFetch(async (url, request) => {
    const body =
      request.method === "GET"
        ? undefined
        : await request
            .clone()
            .json()
            .catch(() => undefined)
    requests.push({ method: request.method, url, body })
    const overridden = await input.handler?.(url, request)
    if (overridden) return overridden
    if (url.pathname === "/api/project/inventory") return json({ data: inventory, cursor: {} })
    return undefined
  }, events)
  const server = Bun.serve({ port: 0, fetch: (request) => calls.fetch(request) })
  const { run } = await import("../src/app")
  const task = Effect.runPromise(
    run({
      server: { endpoint: { url: server.url.toString() } },
      config: { get: async () => ({}), update: async () => ({}) },
      packages: { resolve: async () => undefined },
      args: {},
      log: () => {},
    }).pipe(Effect.provide(AppNodeBuilder.build(Global.node)), Effect.provide(FileSystem.layerNoop({}))),
  )
  await ready
  await Bun.sleep(100)
  const frame = () => setup.captureCharFrame()
  const waitFor = async (predicate: () => boolean) => {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (predicate()) return
      await Bun.sleep(20)
    }
    throw new Error(`condition not met; frame:\n${frame()}`)
  }
  const line = (text: string) =>
    frame()
      .split("\n")
      .find((item) => item.includes(text)) ?? ""
  const open = async () => {
    setup.mockInput.pressKey("p", { ctrl: true })
    await Bun.sleep(50)
    await setup.mockInput.typeText("Manage workspaces")
    await waitFor(() => frame().includes("Manage workspaces"))
    setup.mockInput.pressEnter()
    await waitFor(() => frame().includes("Search workspaces") && frame().includes("loaded"))
  }
  const inventoryRequests = () => requests.filter((item) => item.url.pathname === "/api/project/inventory")
  const stop = async () => {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    await task.catch(() => undefined)
    await server.stop()
    mock.restore()
  }
  return { setup, requests, frame, line, waitFor, open, inventoryRequests, stop }
}

test("the palette opens a grouped workspace inventory with kinds, glyphs, counts, and details", async () => {
  const app = await launch({
    width: 130,
    handler: (url) => {
      if (url.pathname === "/api/session" && url.searchParams.get("directory") === "/tmp/scratch")
        return json({
          data: [
            {
              id: "ses_recent",
              projectID: "global",
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: minutesAgo(30), updated: minutesAgo(5) },
              title: "Sketch inventory paging",
              location: { directory: "/tmp/scratch" },
            },
          ],
          cursor: {},
        })
      return undefined
    },
  })
  try {
    await app.open()
    await app.waitFor(() => app.frame().includes("Sketch inventory paging"))
    await app.waitFor(() => !app.frame().includes("Remote connection"))

    expect(app.line("Workspaces")).toContain("5 loaded")
    expect(app.line("Workspaces")).not.toContain("more available")
    expect(app.line("Workspaces")).toContain("esc")
    expect(app.inventoryRequests()[0]?.url.searchParams.get("limit")).toBe("50")
    expect(app.inventoryRequests()[0]?.url.searchParams.has("cursor")).toBe(false)
    expect(app.line("ycoding  ")).toContain(worktree)
    expect(app.line("folder")).toMatch(/✓ folder\s+\/tmp\/scratch\s+1 sess\s+5 min ago/)
    expect(app.line("checkout")).toMatch(/○ checkout\s+\/tmp\/elsewhere\/ycoding-old\s+2 sess\s+1 hr ago/)
    expect(app.line("copy")).toMatch(/✓ copy\s+\/tmp\/wt\/ycoding-feature\s+1 sess/)
    expect(app.line("✓ main")).toMatch(/✓ main\s+\/tmp\/ycoding\s+4 sess/)
    expect(app.line("/tmp/ycoding/packages/tui")).toMatch(/● subdir\s+\/tmp\/ycoding\/packages\/tui\s+3 sess/)
    expect(app.frame()).toContain("┃")
    expect(app.frame()).toContain("Recent sessions")
    expect(app.line("Kind")).toContain("folder")
    expect(app.line("Sessions")).toContain("1")
    expect(app.frame()).toContain(
      "↑↓ select · enter open · ctrl+d delete copy · ctrl+x forget · ctrl+r refresh · esc back",
    )

    app.setup.mockInput.pressEscape()
    await app.waitFor(() => app.frame().includes("What should we build?"))
  } finally {
    await app.stop()
  }
})

test("narrow terminals hide the details pane", async () => {
  const app = await launch({ width: 100 })
  try {
    await app.open()
    expect(app.line("/tmp/wt/ycoding-feature")).toContain("copy")
    expect(app.frame()).not.toContain("Recent sessions")
    expect(app.frame()).not.toContain("┃")
  } finally {
    await app.stop()
  }
})

test("selection near the end loads the next page once with the returned cursor and appends rows", async () => {
  const first = Array.from({ length: 12 }, (_, index) => ({
    projectID: "proj_test",
    projectName: "ycoding",
    projectWorktree: worktree,
    directory: `/tmp/pages/a${String(index).padStart(2, "0")}`,
    sessions: 1,
    timeActive: minutesAgo(1),
    available: true,
  }))
  const second = first.slice(0, 3).map((item, index) => ({ ...item, directory: `/tmp/pages/b${index}` }))
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const app = await launch({
    width: 100,
    handler: async (url) => {
      if (url.pathname !== "/api/project/inventory") return undefined
      if (url.searchParams.get("cursor") === "cursor-2") {
        await gate
        return json({ data: second, cursor: {} })
      }
      return json({ data: first, cursor: { next: "cursor-2" } })
    },
  })
  try {
    await app.open()
    expect(app.line("Workspaces")).toContain("12 loaded · more available")
    expect(app.inventoryRequests()).toHaveLength(1)

    app.setup.mockInput.pressArrow("down")
    await Bun.sleep(50)
    expect(app.inventoryRequests()).toHaveLength(1)
    app.setup.mockInput.pressArrow("down")
    await app.waitFor(() => app.inventoryRequests().length === 2)
    app.setup.mockInput.pressArrow("down")
    app.setup.mockInput.pressArrow("down")
    await Bun.sleep(50)
    expect(app.frame()).toContain("Loading more…")
    release()
    await app.waitFor(() => app.frame().includes("15 loaded"))

    const cursors = app.inventoryRequests().map((item) => item.url.searchParams.get("cursor"))
    expect(cursors).toEqual([null, "cursor-2"])
    expect(app.line("Workspaces")).not.toContain("more available")
    for (let index = 0; index < 12; index++) app.setup.mockInput.pressArrow("down")
    await app.waitFor(() => app.frame().includes("/tmp/pages/b2"))
    expect(app.inventoryRequests()).toHaveLength(2)
  } finally {
    await app.stop()
  }
})

test("search is debounced, sent to the server, and restarts from the first page", async () => {
  const app = await launch({
    width: 100,
    handler: (url) => {
      if (url.pathname !== "/api/project/inventory" || url.searchParams.get("search") !== "feature") return undefined
      return json({ data: [inventory[2]], cursor: {} })
    },
  })
  try {
    await app.open()
    await app.setup.mockInput.typeText("feature")
    await app.waitFor(() => app.line("Workspaces").includes("1 loaded"))
    const searches = app.inventoryRequests().map((item) => item.url.searchParams.get("search"))
    expect(searches).toEqual([null, "feature"])
    expect(app.inventoryRequests()[1]?.url.searchParams.has("cursor")).toBe(false)
    expect(app.frame()).not.toContain("/tmp/scratch")
  } finally {
    await app.stop()
  }
})

test("ignores inventory responses from an outdated search generation", async () => {
  let release!: () => void
  let staleFinished = false
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const app = await launch({
    width: 100,
    handler: async (url) => {
      if (url.pathname !== "/api/project/inventory") return undefined
      if (url.searchParams.get("search") === "feature") return json({ data: [inventory[2]], cursor: {} })
      await gate
      staleFinished = true
      return json({ data: inventory, cursor: {} })
    },
  })
  try {
    await app.open()
    await app.waitFor(() => app.inventoryRequests().length === 1)
    await app.setup.mockInput.typeText("feature")
    await app.waitFor(() => app.line("Workspaces").includes("1 loaded"))
    expect(app.frame()).toContain("/tmp/wt/ycoding-feature")
    release()
    await app.waitFor(() => staleFinished)
    expect(app.frame()).not.toContain("/tmp/scratch")
  } finally {
    release()
    await app.stop()
  }
})

test("ignores recent-session responses for a workspace that is no longer selected", async () => {
  let release!: () => void
  let staleFinished = false
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const app = await launch({
    width: 130,
    handler: async (url) => {
      if (url.pathname !== "/api/session" || url.searchParams.get("directory") !== "/tmp/scratch") return undefined
      await gate
      staleFinished = true
      return json({
        data: [{ id: "ses_stale", title: "Stale selection session", time: { created: 0, updated: 0 } }],
        cursor: {},
      })
    },
  })
  try {
    await app.open()
    await app.waitFor(() =>
      app.requests.some(
        (request) =>
          request.url.pathname === "/api/session" && request.url.searchParams.get("directory") === "/tmp/scratch",
      ),
    )
    app.setup.mockInput.pressArrow("down")
    await app.waitFor(() => app.frame().includes("No recent sessions"))
    release()
    await app.waitFor(() => staleFinished)
    expect(app.frame()).not.toContain("Stale selection session")
  } finally {
    release()
    await app.stop()
  }
})

test("forget confirms, deletes the directory record, and removes the row", async () => {
  const app = await launch({
    width: 100,
    handler: (url, request) => {
      if (url.pathname === "/api/project/proj_test/directories" && request.method === "DELETE")
        return new Response(null, { status: 204 })
      return undefined
    },
  })
  try {
    await app.open()
    app.setup.mockInput.pressArrow("down")
    await Bun.sleep(50)
    app.setup.mockInput.pressKey("x", { ctrl: true })
    await app.waitFor(() => app.frame().includes("Permanently deletes 2 sessions"))
    expect(app.frame()).toContain("/tmp/elsewhere/ycoding-old")
    expect(app.frame()).toContain("Files stay on disk")
    app.setup.mockInput.pressEnter()
    await app.waitFor(() => app.line("Workspaces").includes("4 loaded"))

    const deletes = app.requests.filter((item) => item.method === "DELETE")
    expect(deletes.map((item) => [item.url.pathname, item.body])).toEqual([
      ["/api/project/proj_test/directories", { directory: "/tmp/elsewhere/ycoding-old" }],
    ])
    expect(app.frame()).not.toContain("/tmp/elsewhere/ycoding-old")
  } finally {
    await app.stop()
  }
})

test("delete copy needs a second press and removes the project copy row", async () => {
  const app = await launch({
    width: 100,
    handler: (url, request) => {
      if (url.pathname === "/experimental/project/proj_test/copy" && request.method === "DELETE")
        return new Response(null, { status: 204 })
      return undefined
    },
  })
  try {
    await app.open()
    app.setup.mockInput.pressKey("d", { ctrl: true })
    await Bun.sleep(50)
    expect(app.frame()).not.toContain("again to delete copy")
    app.setup.mockInput.pressArrow("down")
    app.setup.mockInput.pressArrow("down")
    await Bun.sleep(50)
    app.setup.mockInput.pressKey("d", { ctrl: true })
    await app.waitFor(() => app.frame().includes("Press ctrl+d again to delete copy"))
    expect(app.requests.filter((item) => item.method === "DELETE")).toEqual([])
    app.setup.mockInput.pressKey("d", { ctrl: true })
    await app.waitFor(() => app.line("Workspaces").includes("4 loaded"))

    const deletes = app.requests.filter((item) => item.method === "DELETE")
    expect(deletes.map((item) => [item.url.pathname, item.body])).toEqual([
      ["/experimental/project/proj_test/copy", { directory: "/tmp/wt/ycoding-feature", force: false }],
    ])
    expect(app.frame()).not.toContain("/tmp/wt/ycoding-feature")
  } finally {
    await app.stop()
  }
})

test("enter opens home so the next new session is created in the selected directory", async () => {
  const created: unknown[] = []
  const app = await launch({
    width: 100,
    handler: async (url, request) => {
      if (url.pathname !== "/api/session" || request.method !== "POST") return undefined
      created.push(await request.json())
      return json({ name: "Error", data: { message: "stop" } }, { status: 500 })
    },
  })
  try {
    await app.open()
    app.setup.mockInput.pressArrow("down")
    await Bun.sleep(50)
    app.setup.mockInput.pressEnter()
    await app.waitFor(() => app.frame().includes("Directory is unavailable"))
    expect(app.frame()).toContain("Search workspaces")

    app.setup.mockInput.pressArrow("down")
    app.setup.mockInput.pressArrow("down")
    await Bun.sleep(50)
    app.setup.mockInput.pressEnter()
    await app.waitFor(() => app.frame().includes("What should we build?"))
    await app.setup.mockInput.typeText("hello")
    app.setup.mockInput.pressEnter()
    await app.waitFor(() => created.length > 0)
    expect(created[0]).toMatchObject({ location: { directory: worktree } })
  } finally {
    await app.stop()
  }
})
