import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { PassThrough } from "node:stream"
import * as preferences from "../src/preferences"
import * as rpcModule from "../src/rpc"
import type { DesktopRPCSchema } from "../src/rpc"
import { runDesktopWorker } from "../src/worker"
import { DESKTOP_NAVIGATION_RULES, shouldAllowDesktopNavigation, forwardDesktopEvent, startDesktopConnection, createDesktopRPC } from "../src/rpc"
import { BackendController } from "../src/backend-controller"
import type { DesktopAPI } from "../src/contract"

test("the native window rule plan denies remote and foreign views", () => {
  expect(DESKTOP_NAVIGATION_RULES).toEqual(["^*", "views://mainview/*"])
  expect(shouldAllowDesktopNavigation("views://mainview/index.html")).toBe(true)
  for (const url of ["https://example.test/", "file:///tmp/index.html", "views://other/index.html", "views://mainview.example/index.html"])
    expect(shouldAllowDesktopNavigation(url)).toBe(false)
})

test("the native entry pins the backend working directory to the user home", async () => {
  const entry = await fs.readFile(path.join(import.meta.dir, "../src/bun/index.ts"), "utf8")
  expect(entry).toContain("cwd: os.homedir()")
})

test("startup connects the stored or default selection and refuses corrupt preferences", () => {
  const calls: unknown[] = []
  const connect = async (input: unknown) => { calls.push(input) }
  startDesktopConnection({}, connect)
  startDesktopConnection({ selection: { mode: "own" } }, connect)
  startDesktopConnection({ error: "invalid" }, connect)
  expect(calls).toEqual([{ mode: "shared" }, { mode: "own" }])
})

test("a failed startup logs the real error instead of a generic line", async () => {
  const lines: string[] = []
  startDesktopConnection({}, async () => { throw new Error("The shared backend is unavailable or incompatible.") }, (line) => { lines.push(line) })
  await Bun.sleep(5)
  expect(lines).toEqual(["Desktop backend startup failed: The shared backend is unavailable or incompatible."])
})

test("large events trigger resync rather than an event delivery", () => {
  const events: unknown[] = []
  let resyncs = 0
  const send = { event: (value: unknown) => { events.push(value) }, resync: () => { resyncs++ } }
  const small = { type: "test", properties: { value: "ok" } }
  forwardDesktopEvent(small, send)
  forwardDesktopEvent({ type: "test", properties: { value: "x".repeat(16_384) } }, send)
  expect(events).toEqual([small])
  expect(resyncs).toBe(1)
})

test("RPC handlers forward every operation and persist explicit backend choices", async () => {
  const calls: unknown[][] = []
  const controller = new Proxy({}, { get: (_target, key) => (...args: unknown[]) => {
    calls.push([key, ...args])
    return key === "state" ? { generation: 0, status: "idle" } : Promise.resolve(key === "connect" ? { generation: 1, status: "connected" } : undefined)
  } }) as BackendController
  const saved: unknown[] = []
  const handlers = createDesktopRPC(controller, {
    path: "/synthetic/preferences", read: async () => ({}), save: async (_path, selection) => { saved.push(selection) },
    validate: (value) => value as { mode: "own" },
  })
  expect(await handlers.preferences()).toEqual({})
  await handlers.state()
  await handlers.connect({ mode: "own" })
  await handlers.disconnect()
  await handlers.sessions({})
  await handlers.session({ sessionID: "ses_test" })
  await handlers.fileChanges("ses_test")
  await handlers.activity("ses_test")
  await handlers.projects()
  await handlers.usage()
  await handlers.pin({ sessionID: "ses_test", revision: 1, pinned: true })
  await handlers.workspaces()
  await handlers.messages("ses_test")
  await handlers.createSession({ sessionID: "ses_test" })
  await handlers.prompt({ sessionID: "ses_test", promptID: "msg_test", text: "hello" })
  await handlers.interrupt("ses_test")
  await handlers.requests("ses_test")
  await handlers.reply({ kind: "form-cancel", sessionID: "ses_test", revision: 1, formID: "form_test" })
  await handlers.models("ses_test")
  await handlers.switchModel({ sessionID: "ses_test", revision: 1, model: { id: "model", providerID: "provider" } })
  expect(calls.map(([name]) => name)).toEqual(["state", "connect", "disconnect", "sessions", "session", "fileChanges", "activity", "projects", "usage", "pin", "workspaces", "messages", "createSession", "prompt", "interrupt", "requests", "reply", "models", "switchModel"])
  expect(saved).toEqual([{ mode: "own" }])
  expect(calls.filter(([name]) => ["fileChanges", "activity", "projects", "usage"].includes(String(name)))).toEqual([
    ["fileChanges", "ses_test"], ["activity", "ses_test"], ["projects"], ["usage"],
  ])
})

test("the surface bridge sends exact typed RPC requests", async () => {
  const original = Reflect.get(globalThis, "window")
  Reflect.set(globalThis, "window", {})
  try {
    const { createDesktopBridge } = await import("../src/bridge")
    const calls: unknown[][] = []
    const request = new Proxy({}, { get: (_target, name) => (...args: unknown[]) => { calls.push([name, ...args]); return Promise.resolve({ revision: 1 }) } })
    const bridge = createDesktopBridge({ request } as never, () => undefined)
    await bridge.fileChanges("ses_test")
    await bridge.activity("ses_test")
    await bridge.projects()
    await bridge.usage()
    expect(calls).toEqual([["fileChanges", "ses_test"], ["activity", "ses_test"], ["projects"], ["usage"]])
  } finally {
    if (original === undefined) Reflect.deleteProperty(globalThis, "window")
    else Reflect.set(globalThis, "window", original)
  }
})

test("new desktop operations and pagination parameters cross RPC and bridge", async () => {
  const calls: unknown[][] = []
  const controller = new Proxy({}, { get: (_target, key) => (...args: unknown[]) => { calls.push([key, ...args]); return Promise.resolve(undefined) } }) as BackendController
  const handlers = createDesktopRPC(controller, { path: "/synthetic/preferences", read: async () => ({}), save: async () => {}, validate: () => ({ mode: "own" }) })
  const activity = { sessionID: "ses_test", cursor: "next", revision: 1 }
  const output = { sessionID: "ses_test", shellID: "sh_test", cursor: 0, limit: 10 }
  const page = { cursor: "next", revision: 1 }
  const period = { range: "7d" as const }
  const revert = { action: "stage" as const, sessionID: "ses_test", revision: 1, messageID: "msg_test" }
  const directory = { projectID: "prj_test" }
  await handlers.activity(activity); await handlers.shellOutput(output); await handlers.projects(page); await handlers.usage(period); await handlers.revert(revert); await handlers.workspaceDirectories(directory)
  expect(calls).toEqual([["activity", activity], ["shellOutput", output], ["projects", page], ["usage", period], ["revert", revert], ["workspaceDirectories", directory]])
  const original = Reflect.get(globalThis, "window")
  Reflect.set(globalThis, "window", {})
  try {
    const { createDesktopBridge } = await import("../src/bridge")
    calls.length = 0
    const request = new Proxy({}, { get: (_target, key) => (...args: unknown[]) => { calls.push([key, ...args]); return Promise.resolve(undefined) } })
    const bridge = createDesktopBridge({ request } as never, () => undefined)
    await bridge.activity(activity); await bridge.shellOutput(output); await bridge.projects(page); await bridge.usage(period); await bridge.revert(revert); await bridge.workspaceDirectories(directory)
    expect(calls).toEqual([["activity", activity], ["shellOutput", output], ["projects", page], ["usage", period], ["revert", revert], ["workspaceDirectories", directory]])
  } finally { if (original === undefined) Reflect.deleteProperty(globalThis, "window"); else Reflect.set(globalThis, "window", original) }
})

test("autonomy reads and updates cross RPC and bridge", async () => {
  const calls: unknown[][] = []
  const controller = new Proxy({}, { get: (_target, key) => (...args: unknown[]) => { calls.push([key, ...args]); return Promise.resolve(undefined) } }) as BackendController
  const handlers = createDesktopRPC(controller, { path: "/synthetic/preferences", read: async () => ({}), save: async () => {}, validate: () => ({ mode: "own" }) })
  const input = { sessionID: "ses_test", revision: 1, payload: { permissions: "manual" as const } }
  await handlers.autonomy("ses_test"); await handlers.setAutonomy(input)
  expect(calls).toEqual([["autonomy", "ses_test"], ["setAutonomy", input]])
  const original = Reflect.get(globalThis, "window")
  Reflect.set(globalThis, "window", {})
  try {
    const { createDesktopBridge } = await import("../src/bridge")
    calls.length = 0
    const request = new Proxy({}, { get: (_target, key) => (...args: unknown[]) => { calls.push([key, ...args]); return Promise.resolve(undefined) } })
    const bridge = createDesktopBridge({ request } as never, () => undefined)
    await bridge.autonomy("ses_test"); await bridge.setAutonomy(input)
    expect(calls).toEqual([["autonomy", "ses_test"], ["setAutonomy", input]])
  } finally { if (original === undefined) Reflect.deleteProperty(globalThis, "window"); else Reflect.set(globalThis, "window", original) }
})

test("settings and project and workspace mutations cross RPC and bridge", async () => {
  const calls: unknown[][] = []
  const controller = new Proxy({}, { get: (_target, key) => (...args: unknown[]) => { calls.push([key, ...args]); return Promise.resolve(undefined) } }) as BackendController
  const handlers = createDesktopRPC(controller, { path: "/synthetic/preferences", read: async () => ({}), save: async () => {}, validate: () => ({ mode: "own" }) })
  const settings = { kind: "keep-awake" as const, revision: 1, enabled: true }
  const project = { kind: "delete" as const, revision: 1, groupID: "cgrp_test" }
  const workspace = { kind: "forget" as const, revision: 1, projectID: "prj_test", directory: "/synthetic/repo" }
  await handlers.settings(); await handlers.changeSettings(settings); await handlers.changeProject(project); await handlers.changeWorkspace(workspace)
  expect(calls).toEqual([["settings"], ["changeSettings", settings], ["changeProject", project], ["changeWorkspace", workspace]])
  const original = Reflect.get(globalThis, "window")
  Reflect.set(globalThis, "window", {})
  try {
    const { createDesktopBridge } = await import("../src/bridge")
    calls.length = 0
    const request = new Proxy({}, { get: (_target, key) => (...args: unknown[]) => { calls.push([key, ...args]); return Promise.resolve(undefined) } })
    const bridge = createDesktopBridge({ request } as never, () => undefined)
    await bridge.settings(); await bridge.changeSettings(settings); await bridge.changeProject(project); await bridge.changeWorkspace(workspace)
    expect(calls).toEqual([["settings"], ["changeSettings", settings], ["changeProject", project], ["changeWorkspace", workspace]])
  } finally { if (original === undefined) Reflect.deleteProperty(globalThis, "window"); else Reflect.set(globalThis, "window", original) }
})

test("settings and project and workspace mutations cross the worker", async () => {
  const calls: unknown[][] = []
  const settings = spyOn(BackendController.prototype, "settings").mockImplementation(async () => { calls.push(["settings"]); return {} as never })
  const changeSettings = spyOn(BackendController.prototype, "changeSettings").mockImplementation(async (input) => { calls.push(["changeSettings", input]); return {} as never })
  const changeProject = spyOn(BackendController.prototype, "changeProject").mockImplementation(async (input) => { calls.push(["changeProject", input]); return {} as never })
  const changeWorkspace = spyOn(BackendController.prototype, "changeWorkspace").mockImplementation(async (input) => { calls.push(["changeWorkspace", input]); return null })
  const input = new PassThrough()
  const output = new PassThrough()
  const replies = Promise.withResolvers<void>()
  let count = 0
  output.on("data", () => { if (++count === 4) replies.resolve() })
  const done = runDesktopWorker({ resources: "/synthetic/resources", preferences: "/synthetic/preferences", input, output })
  try {
    for (const [index, operation] of ["settings", "changeSettings", "changeProject", "changeWorkspace"].entries()) input.write(JSON.stringify({ id: index + 1, operation, input: { revision: index } }) + "\n")
    await replies.promise
    input.end()
    await done
    expect(calls).toEqual([["settings"], ["changeSettings", { revision: 1 }], ["changeProject", { revision: 2 }], ["changeWorkspace", { revision: 3 }]])
  } finally { input.end(); await done.catch(() => undefined); settings.mockRestore(); changeSettings.mockRestore(); changeProject.mockRestore(); changeWorkspace.mockRestore() }
})

test("the renderer bridge uses an injected fallback instead of sending an RPC", async () => {
  const original = Reflect.get(globalThis, "window")
  Reflect.set(globalThis, "window", {})
  try {
    const { createDesktopBridge } = await import("../src/bridge")
    const fallback = { state: async () => ({ generation: 4, status: "idle" }) } as DesktopAPI
    const rpc = { request: { state: () => { throw new Error("unexpected RPC") } } }
    const bridge = createDesktopBridge(rpc as never, () => fallback)
    expect(await bridge.state()).toEqual({ generation: 4, status: "idle" })
  } finally {
    if (original === undefined) Reflect.deleteProperty(globalThis, "window")
    else Reflect.set(globalThis, "window", original)
  }
})

test("disconnect cancels a pending preference write before it can start a backend", async () => {
  const saved = Promise.withResolvers<void>()
  let connects = 0
  const controller = {
    connect: async () => { connects++; return { generation: 1, status: "connected" } },
    disconnect: async () => {},
  } as unknown as BackendController
  const handlers = createDesktopRPC(controller, { path: "/synthetic/preferences", read: async () => ({}), save: async () => saved.promise, validate: () => ({ mode: "own" }) })
  const pending = handlers.connect({ mode: "own" })
  await expect(handlers.connect({ mode: "own" })).rejects.toThrow("pending")
  await handlers.disconnect()
  saved.resolve()
  await expect(pending).rejects.toThrow("cancelled")
  expect(connects).toBe(0)
})

test("unexpected host failures do not expose their details to the renderer", async () => {
  const controller = { disconnect: async () => { throw new Error("synthetic-private-detail") } } as unknown as BackendController
  const handlers = createDesktopRPC(controller, { path: "/synthetic/preferences", read: async () => ({}), save: async () => {}, validate: () => ({ mode: "own" }) })
  await expect(handlers.disconnect()).rejects.toThrow("Native desktop request failed.")
})

test("the expanded DesktopAPI crosses RPC and bridge without changing arguments", async () => {
  const inputs = {
    browseDirectory: { directory: "/synthetic/repo", showHidden: true },
    openDirectory: { directory: "/synthetic/repo" },
    createDirectory: { parentDirectory: "/synthetic/repo", name: "New folder" },
    integrations: "ses_test",
    manageIntegration: { kind: "credential-activate", revision: 1, credentialID: "cred_test" },
    mcpServers: { directory: "/synthetic/repo" },
    manageMcp: { kind: "disconnect", revision: 1, name: "test" },
    manageSession: { kind: "archive", revision: 1, sessionID: "ses_test" },
    vcsDiff: { source: "ses_test", mode: "git" },
    systemSnapshot: { sessionID: "ses_test" },
    manageSystem: { kind: "remote-set", revision: 1, enabled: false },
  } satisfies { [K in "browseDirectory" | "openDirectory" | "createDirectory" | "integrations" | "manageIntegration" | "mcpServers" | "manageMcp" | "manageSession" | "vcsDiff" | "systemSnapshot" | "manageSystem"]: Parameters<DesktopAPI[K]>[0] }
  const calls: unknown[][] = []
  const controller = new Proxy({}, { get: (_target, name) => (...args: unknown[]) => { calls.push([name, ...args]); return Promise.resolve(undefined) } }) as BackendController
  const handlers = createDesktopRPC(controller, { path: "/synthetic/preferences", read: async () => ({}), save: async () => {}, validate: () => ({ mode: "own" }) })
  for (const [name, input] of Object.entries(inputs)) await Reflect.apply(Reflect.get(handlers, name), handlers, [input])
  const expected = Object.entries(inputs).map(([name, input]) => [name, input])
  expect(calls).toEqual(expected)
  const original = Reflect.get(globalThis, "window")
  Reflect.set(globalThis, "window", {})
  try {
    const { createDesktopBridge } = await import("../src/bridge")
    calls.length = 0
    const request = new Proxy({}, { get: (_target, name) => (...args: unknown[]) => { calls.push([name, ...args]); return Promise.resolve(undefined) } })
    const bridge = createDesktopBridge({ request } as never, () => undefined)
    for (const [name, input] of Object.entries(inputs)) await Reflect.apply(Reflect.get(bridge, name), bridge, [input])
    await bridge.pickDirectory({ startingFolder: "/synthetic/repo" })
    await bridge.openExternalUrl({ url: "https://example.test/connect" })
    expect(calls).toEqual([...expected, ["pickDirectory", { startingFolder: "/synthetic/repo" }], ["openExternalUrl", { url: "https://example.test/connect" }]])
    expect(Object.keys(bridge).sort()).toEqual([...Object.keys(handlers), "onState", "onEvent", "onResync"].sort())
  } finally { if (original === undefined) Reflect.deleteProperty(globalThis, "window"); else Reflect.set(globalThis, "window", original) }
})

test("new worker operations preserve inputs and headless folder dialogs fail explicitly", async () => {
  const methods = ["browseDirectory", "openDirectory", "createDirectory", "integrations", "manageIntegration", "mcpServers", "manageMcp", "manageSession", "vcsDiff", "systemSnapshot", "manageSystem"] as const
  const calls: unknown[][] = []
  const spies = methods.map((name) => spyOn(BackendController.prototype, name).mockImplementation(async (input?: unknown) => { calls.push([name, input]); return {} as never }))
  const input = new PassThrough()
  const output = new PassThrough()
  const replies: Record<string, unknown>[] = []
  const finished = Promise.withResolvers<void>()
  output.on("data", (chunk: Buffer) => { replies.push(JSON.parse(chunk.toString())); if (replies.length === methods.length + 2) finished.resolve() })
  const done = runDesktopWorker({ resources: "/synthetic/resources", preferences: "/synthetic/preferences", input, output })
  try {
    methods.forEach((operation, index) => input.write(JSON.stringify({ id: index + 1, operation, input: { revision: index } }) + "\n"))
    input.write(JSON.stringify({ id: 100, operation: "pick-directory" }) + "\n")
    input.write(JSON.stringify({ id: 101, operation: "openExternalUrl", input: { url: "javascript:alert(1)" } }) + "\n")
    await finished.promise
    input.end()
    await done
    expect(calls).toEqual(methods.map((name, index) => [name, { revision: index }]))
    expect(replies.find((reply) => reply.id === 100)?.error).toBe("Native folder dialog is unavailable in headless worker mode; use Browse folders.")
    expect(replies.find((reply) => reply.id === 101)?.error).toContain("HTTPS")
  } finally { input.end(); await done.catch(() => undefined); spies.forEach((spy) => spy.mockRestore()) }
})

test("worker disconnect and EOF cancel a connect waiting for preference persistence", async () => {
  for (const ending of ["disconnect", "eof"] as const) {
    const saved = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const save = spyOn(preferences, "savePreferences").mockImplementation(async () => { entered.resolve(); await saved.promise })
    const connect = spyOn(BackendController.prototype, "connect").mockImplementation(async () => ({ generation: 1, status: "connected" }))
    const input = new PassThrough()
    const output = new PassThrough()
    const reply = Promise.withResolvers<void>()
    const connectReply = Promise.withResolvers<void>()
    output.on("data", (chunk: Buffer) => { if (chunk.toString().includes('"id":2')) reply.resolve(); if (chunk.toString().includes('"id":1')) connectReply.resolve() })
    const done = runDesktopWorker({ resources: "/synthetic/resources", preferences: "/synthetic/preferences", input, output })
    try {
      input.write(JSON.stringify({ id: 1, operation: "connect", input: { mode: "own" } }) + "\n")
      await entered.promise
      if (ending === "disconnect") {
        input.write(JSON.stringify({ id: 2, operation: "disconnect" }) + "\n")
        await reply.promise
      } else {
        const ended = new Promise<void>((resolve) => input.once("end", resolve))
        input.end()
        await ended
      }
      saved.resolve()
      if (ending === "disconnect") { await connectReply.promise; input.end() }
      await done
      expect(connect).not.toHaveBeenCalled()
    } finally { saved.resolve(); input.end(); await done.catch(() => undefined); save.mockRestore(); connect.mockRestore() }
  }
}, 30_000)


test("desktop state accepts a response after the default RPC deadline", async () => {
  const original = Reflect.get(globalThis, "window")
  Reflect.set(globalThis, "window", {})
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const bridge = await import("../src/bridge")
    const { Electroview } = await import("electrobun/view")
    const rpc = (bridge as typeof bridge & { desktopRPC?: ReturnType<typeof Electroview.defineRPC<DesktopRPCSchema>> }).desktopRPC
      ?? Electroview.defineRPC<DesktopRPCSchema>({ handlers: { requests: {} } })
    let receive: (packet: unknown) => void = () => {}
    rpc.setTransport({
      registerHandler: (handler) => { receive = handler },
      send: (packet: { id: number }) => { timer = setTimeout(() => receive({ type: "response", id: packet.id, success: true, payload: { generation: 4, status: "idle" } }), 1_050) },
    })
    const desktop = (bridge as typeof bridge & { desktopRPC?: typeof rpc }).desktopRPC ? bridge.desktop : bridge.createDesktopBridge(rpc, () => undefined)
    expect(await desktop.state()).toEqual({ generation: 4, status: "idle" })
    expect((rpcModule as Record<string, unknown>).DESKTOP_RPC_MAX_REQUEST_TIME).toBe(60_000)
  } finally {
    clearTimeout(timer)
    if (original === undefined) Reflect.deleteProperty(globalThis, "window")
    else Reflect.set(globalThis, "window", original)
  }
})
