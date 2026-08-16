import { expect, mock, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { Global } from "@ycoding-ai/core/global"
import { createEventStream, createFetch, directory, json } from "./fixture/tui-client"

test("SIGHUP clears title and disposes scoped resources once", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const titles: string[] = []
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const setTitle = setup.renderer.setTerminalTitle.bind(setup.renderer)
  setup.renderer.setTerminalTitle = (title) => {
    titles.push(title)
    if (title === "YCoding") started()
    setTitle(title)
  }
  const listeners = new Set(process.listeners("SIGHUP"))
  const events = createEventStream()
  const calls = createFetch(undefined, events)
  const server = Bun.serve({ port: 0, fetch: (request) => calls.fetch(request) })
  try {
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
    process.emit("SIGHUP")
    await task

    expect(setup.renderer.isDestroyed).toBe(true)
    expect(titles.at(-1)).toBe("")
    expect(process.listeners("SIGHUP").every((listener) => listeners.has(listener))).toBe(true)
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    await server.stop()
    mock.restore()
  }
})

test("Escape never exits and Ctrl+C requires two presses", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
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
  const events = createEventStream()
  const calls = createFetch(undefined, events)
  const server = Bun.serve({ port: 0, fetch: (request) => calls.fetch(request) })

  try {
    const { run } = await import("../src/app")
    let resolved = false
    const task = Effect.runPromise(
      run({
        server: { endpoint: { url: server.url.toString() } },
        config: { get: async () => ({}), update: async () => ({}) },
        packages: { resolve: async () => undefined },
        args: {},
        log: () => {},
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node)), Effect.provide(FileSystem.layerNoop({}))),
    ).then(() => {
      resolved = true
    })

    await ready
    setup.mockInput.pressKey("ESCAPE")
    await Bun.sleep(10)
    expect(resolved).toBe(false)

    setup.mockInput.pressKey("c", { ctrl: true })
    await Bun.sleep(10)
    expect(resolved).toBe(false)

    setup.mockInput.pressKey("c", { ctrl: true })
    await task
    expect(resolved).toBe(true)
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    await server.stop()
    mock.restore()
  }
})

test("session lifecycle updates the terminal title and prints the epilogue after cleanup", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  let initialTitle!: () => void
  const initialTitleSet = new Promise<void>((resolve) => {
    initialTitle = resolve
  })
  let renamedTitle!: () => void
  const renamedTitleSet = new Promise<void>((resolve) => {
    renamedTitle = resolve
  })
  const setTitle = setup.renderer.setTerminalTitle.bind(setup.renderer)
  setup.renderer.setTerminalTitle = (title) => {
    if (title === "YC | Demo session") initialTitle()
    if (title === "YC | Renamed session") renamedTitle()
    setTitle(title)
  }
  const events = createEventStream()
  const calls = createFetch((url) => {
    const session = {
      id: "dummy",
      title: "Demo session",
      projectID: "project",
      location: { directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 0, updated: 0 },
    }
    if (url.pathname === "/api/session")
      return json({
        data: [session],
        cursor: {},
      })
    if (url.pathname === "/api/session/dummy") return json({ data: session })
    if (url.pathname === "/api/session/dummy/message") return json({ data: [], cursor: {} })
    if (url.pathname === "/api/session/dummy/pending") return json({ data: [] })
    if (url.pathname === "/api/session/dummy/permission") return json({ data: [] })
    if (url.pathname === "/api/vcs/branch") return json({ location: { directory }, data: {} })
    return undefined
  }, events)
  const server = Bun.serve({ port: 0, fetch: (request) => calls.fetch(request) })
  const originalWrite = process.stdout.write.bind(process.stdout)
  let stdout = ""
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  }) as typeof process.stdout.write

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        server: { endpoint: { url: server.url.toString() } },
        config: { get: async () => ({}), update: async () => ({}) },
        packages: { resolve: async () => undefined },
        args: { sessionID: "dummy" },
        log: () => {},
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node)), Effect.provide(FileSystem.layerNoop({}))),
    )

    await initialTitleSet
    events.emit({
      id: "evt_renamed",
      created: 1,
      type: "session.renamed",
      durable: { aggregateID: "dummy", seq: 1, version: 1 },
      data: { sessionID: "dummy", title: "Renamed session" },
    })
    await renamedTitleSet
    setup.renderer.destroy()
    await task

    expect(stdout).toContain("Renamed session")
    expect(stdout).toContain("ycoding -s dummy")
    expect(stdout.toLowerCase()).not.toContain(["open", "code"].join(""))
  } finally {
    process.stdout.write = originalWrite
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    await server.stop()
    mock.restore()
  }
})

test("explicit session bootstrap restores its location-scoped model without an invalid-model warning", async () => {
  const setup = await createTestRenderer({ width: 120, height: 32, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))

  const defaultDirectory = "/tmp/ycoding/default"
  const sessionDirectory = "/tmp/ycoding/session-workspace"
  const defaultLocation = { directory: defaultDirectory, project: { id: "proj_default", directory: defaultDirectory } }
  const sessionLocation = { directory: sessionDirectory, project: { id: "proj_session", directory: sessionDirectory } }
  const session = {
    id: "ses_resume",
    title: "Resume target",
    projectID: "proj_session",
    location: { directory: sessionDirectory },
    agent: "build",
    model: { providerID: "openrouter", id: "deepseek-v4-flash" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  const citation = {
    id: "msg_citation",
    type: "assistant",
    agent: "build",
    model: { providerID: "openrouter", id: "deepseek-v4-flash" },
    content: [
      {
        type: "text",
        text: "Read the documentation.\n\nSource: Effect Documentation\nhttps://effect.website/docs",
      },
    ],
    finish: "stop",
    time: { created: 0, completed: 1 },
  }
  const model = {
    id: "deepseek-v4-flash",
    modelID: "deepseek/deepseek-v4-flash",
    providerID: "openrouter",
    name: "DeepSeek V4 Flash",
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 1_048_576, output: 32_768 },
  }
  const provider = { id: "openrouter", name: "OpenRouter", package: "@openrouter/ai-sdk-provider" }
  const agent = {
    id: "build",
    name: "Build",
    request: { headers: {}, body: {} },
    mode: "primary",
    hidden: false,
    permissions: [],
  }

  const modelDirectories: Array<string | null> = []
  const events = createEventStream()
  const calls = createFetch((url) => {
    const requestedDirectory = url.searchParams.get("location[directory]")
    const location = requestedDirectory === sessionDirectory ? sessionLocation : defaultLocation
    if (url.pathname === "/api/fs/list") return json({ location: defaultLocation, data: [] })
    if (url.pathname === "/api/location") return json(location)
    if (url.pathname === "/api/session") return json({ data: [], cursor: {} })
    if (url.pathname === "/api/session/ses_resume") return json({ data: session })
    if (url.pathname === "/api/session/ses_resume/message") return json({ data: [citation], cursor: {} })
    if (url.pathname === "/api/session/ses_resume/pending") return json({ data: [] })
    if (url.pathname === "/api/session/ses_resume/permission") return json({ data: [] })
    if (url.pathname === "/api/vcs/branch") return json({ location, data: {} })
    // The rail docks from 120 columns, so this 120-column session also loads its rail sections.
    if (url.pathname === "/api/session/ses_resume/todo") return json({ data: [] })
    if (url.pathname === "/api/session/ses_resume/subagent") return json({ data: [] })
    if (url.pathname === "/api/session/ses_resume/skills") return json({ data: [] })
    if (url.pathname === "/api/session/ses_resume/guardrail/request") return json({ data: [] })
    if (url.pathname === "/api/session/ses_resume/guardrail")
      return json({
        data: {
          rootSessionID: "ses_resume",
          profile: "standard",
          customRules: 0,
          approvals: 0,
          blocked: 0,
          counters: [],
          invalidFiles: [],
        },
      })
    if (url.pathname === "/api/model") {
      modelDirectories.push(requestedDirectory)
      return json({ location, data: requestedDirectory === sessionDirectory ? [model] : [] })
    }
    if (url.pathname === "/api/provider")
      return json({ location, data: requestedDirectory === sessionDirectory ? [provider] : [] })
    if (url.pathname === "/api/agent") return json({ location, data: [agent] })
    if (["/api/integration", "/api/command", "/api/skill", "/api/reference"].includes(url.pathname))
      return json({ location, data: [] })
    if (url.pathname === "/api/mcp") return json({ location, data: [] })
    if (url.pathname === "/api/mcp/resource") return json({ location, data: { resources: [], templates: [] } })
    if (url.pathname === "/api/shell") return json({ location, data: [] })
    if (url.pathname === "/api/permission/request") return json({ location, data: [] })
    if (url.pathname === "/api/form/request") return json({ location, data: [] })
    return undefined
  }, events)
  const server = Bun.serve({ port: 0, fetch: (request) => calls.fetch(request) })

  let titled!: () => void
  const titleReady = new Promise<void>((resolve) => {
    titled = resolve
  })
  const setTitle = setup.renderer.setTerminalTitle.bind(setup.renderer)
  setup.renderer.setTerminalTitle = (title) => {
    if (title === "YC | Resume target") titled()
    setTitle(title)
  }

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        server: { endpoint: { url: server.url.toString() } },
        config: { get: async () => ({}), update: async () => ({}) },
        packages: { resolve: async () => undefined },
        args: { sessionID: "ses_resume" },
        log: () => {},
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node)), Effect.provide(FileSystem.layerNoop({}))),
    )

    await titleReady
    await Bun.sleep(100)
    const frame = setup.captureCharFrame()
    expect(frame).toContain("session-workspace")
    expect(frame).not.toContain("/tmp/ycodin...n-workspace")
    expect(frame).toContain("Build · DeepSeek V4 Flash")
    expect(frame).toContain("DeepSeek V4 Flash")
    expect(frame).toContain("Source: Effect Documentation")
    expect(frame).toContain("https://effect.website/docs")
    expect(frame).not.toContain("Model openrouter/deepseek-v4-flash is not valid")
    expect(modelDirectories).toContain(sessionDirectory)
    expect(modelDirectories).not.toContain(defaultDirectory)
    setup.renderer.destroy()
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    await server.stop()
    mock.restore()
  }
})

test("passive mouse selection never writes to the clipboard", async () => {
  const source = await Bun.file(new URL("../src/app.tsx", import.meta.url)).text()
  expect(source).not.toContain("MouseButton.RIGHT")
  expect(source).not.toContain("onMouseUp={\n        copyOnSelectEnabled()")
  expect(source).toContain("Selection.handleSelectionKey")
})
