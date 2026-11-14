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
import type { DesktopAPI, Preferences, Selection } from "../src/contract"

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
    expect(Object.keys(bridge).sort()).toEqual([...Object.keys(handlers), "onState", "onEvent", "onResync", "onMenuAction"].sort())
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

test("buildDesktopApplicationMenu defines macOS App, File, Edit, View, and Window menus without action conflicts on responder roles", () => {
  type MenuItem = { label?: string; role?: string; action?: string; accelerator?: string; type?: string; submenu?: MenuItem[] }
  const buildMenu = (rpcModule as unknown as { buildDesktopApplicationMenu: (appName: string) => MenuItem[] }).buildDesktopApplicationMenu
  const menus = buildMenu("YCoding Desktop")
  const byLabel = (label: string) => menus.find((menu) => menu.label === label)

  const appMenu = byLabel("YCoding Desktop")
  expect(appMenu).toBeDefined()
  const appItems = appMenu?.submenu ?? []
  expect(appItems).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: "about" }),
    expect.objectContaining({ action: "check-for-updates", label: "Check for Updates…" }),
    expect.objectContaining({ action: "open-settings", label: "Settings…", accelerator: "CmdOrCtrl+," }),
    expect.objectContaining({ role: "hide" }),
    expect.objectContaining({ role: "hideOthers" }),
    expect.objectContaining({ role: "showAll" }),
    expect.objectContaining({ role: "quit" }),
  ]))

  const fileMenu = byLabel("File")
  expect(fileMenu).toBeDefined()
  expect(fileMenu?.submenu ?? []).toEqual(expect.arrayContaining([
    expect.objectContaining({ action: "new-chat", label: "New Chat", accelerator: "CmdOrCtrl+N" }),
    expect.objectContaining({ role: "close" }),
  ]))

  const editMenu = byLabel("Edit")
  expect(editMenu).toBeDefined()
  const editItems = editMenu?.submenu ?? []
  for (const role of ["undo", "redo", "cut", "copy", "paste", "pasteAndMatchStyle", "delete", "selectAll"]) {
    const match = editItems.find((item) => item.role === role)
    expect(match).toBeDefined()
    expect(match).not.toHaveProperty("action")
  }
  for (const menu of menus) {
    for (const item of menu.submenu ?? []) {
      if (item.role !== undefined) expect(item).not.toHaveProperty("action")
    }
  }

  const viewMenu = byLabel("View")
  expect(viewMenu).toBeDefined()
  expect(viewMenu?.submenu ?? []).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: "toggleFullScreen" }),
  ]))

  const windowMenu = byLabel("Window")
  expect(windowMenu).toBeDefined()
  expect(windowMenu?.submenu ?? []).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: "minimize" }),
    expect.objectContaining({ role: "zoom" }),
    expect.objectContaining({ role: "bringAllToFront" }),
  ]))
})

test("menuActionFromEvent extracts supported desktop menu actions across Electrobun event shapes and ignores unknown actions", () => {
  const parse = (rpcModule as unknown as {
    menuActionFromEvent: (event: unknown) => "check-for-updates" | "open-settings" | "new-chat" | undefined
  }).menuActionFromEvent
  expect(parse({ data: { action: "open-settings" } })).toBe("open-settings")
  expect(parse({ action: "check-for-updates" })).toBe("check-for-updates")
  expect(parse({ data: { action: "new-chat" } })).toBe("new-chat")
  expect(parse({ data: { action: "|EB|menuData_1|new-chat" } })).toBe("new-chat")
  expect(parse({ action: "|EB|menuData_2|open-settings" })).toBe("open-settings")
  expect(parse({ data: { action: "unknown-action" } })).toBeUndefined()
  expect(parse({ data: { action: "|EB|menuData_3|quit" } })).toBeUndefined()
  expect(parse({})).toBeUndefined()
  expect(parse(null)).toBeUndefined()
})

test("the native entry registers ApplicationMenu and forwards application-menu-clicked actions to the webview", async () => {
  const entry = await fs.readFile(path.join(import.meta.dir, "../src/bun/index.ts"), "utf8")
  expect(entry).toMatch(/ApplicationMenu\.setApplicationMenu\(\s*buildDesktopApplicationMenu\(/)
  expect(entry).toMatch(/ApplicationMenu\.on\(\s*["']application-menu-clicked["']/)
  expect(entry).toMatch(/rpc\.send\.menuAction\(/)
})

test("clipboard, update, and menuAction operations round-trip across RPC and createDesktopBridge with payload validation", async () => {
  const clipboardSnapshot = { text: "copied snippet", imageBase64: "aGVsbG8=", formats: ["text", "image"] }
  const updateSnapshot = {
    currentVersion: "0.11.1",
    latestVersion: "0.11.2",
    updateAvailable: true,
    releaseUrl: "https://github.com/Althenia/ycoding/releases/tag/v0.11.2",
    publishedAt: "2026-11-14T10:00:00Z",
    releaseNotes: "Release notes for 0.11.2",
    canInstall: true,
  }
  const installSnapshot = { installedVersion: "0.11.2", relaunching: true }
  const written: string[] = []
  const updateCalls: unknown[][] = []
  const controller = new Proxy({}, {
    get: (_target, key) => (...args: unknown[]) => {
      if (key === "readClipboard") return Promise.resolve(clipboardSnapshot)
      if (key === "writeClipboard") {
        const first = args[0] as string | { text: string }
        written.push(typeof first === "string" ? first : first.text)
        return Promise.resolve({ written: true })
      }
      if (key === "checkForUpdates") {
        updateCalls.push(["checkForUpdates"])
        return Promise.resolve(updateSnapshot)
      }
      if (key === "installUpdate") {
        const first = args[0] as string | { version?: string } | undefined
        updateCalls.push(["installUpdate", typeof first === "string" ? first : first?.version])
        return Promise.resolve(installSnapshot)
      }
      return Promise.resolve(undefined)
    },
  }) as BackendController

  const handlers = createDesktopRPC(
    controller,
    { path: "/synthetic/preferences", read: async () => ({}), save: async () => {}, validate: () => ({ mode: "own" as const }) },
    {
      readClipboard: async () => clipboardSnapshot,
      writeClipboard: async (text) => {
        written.push(text)
      },
      checkForUpdates: async () => {
        updateCalls.push(["checkForUpdates"])
        return updateSnapshot
      },
      installUpdate: async ({ version }) => {
        updateCalls.push(["installUpdate", version])
        return installSnapshot
      },
    },
  )

  expect(await handlers.readClipboard()).toEqual(clipboardSnapshot)
  await handlers.writeClipboard({ text: "copied snippet" })
  expect(written).toEqual(["copied snippet"])

  for (const invalid of [null, {}, { text: 123 }, { text: "x".repeat(10 * 1024 * 1024 + 1) }]) {
    let caught: unknown
    try {
      await (handlers.writeClipboard as (input: unknown) => Promise<void>)(invalid)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).not.toBe("Native desktop request failed.")
  }
  expect(written).toEqual(["copied snippet"])

  expect(await handlers.checkForUpdates()).toEqual(updateSnapshot)
  await handlers.installUpdate({ version: "0.11.2" })
  expect(updateCalls).toEqual([["checkForUpdates"], ["installUpdate", "0.11.2"]])

  const original = Reflect.get(globalThis, "window")
  Reflect.set(globalThis, "window", {})
  try {
    const bridgeModule = await import("../src/bridge")
    const bridgeCalls: unknown[][] = []
    let receive: (packet: unknown) => void = () => {}
    bridgeModule.desktopRPC.setTransport({
      registerHandler: (handler) => { receive = handler },
      send: (packet: { id: number; method: string; params?: unknown }) => {
        bridgeCalls.push([packet.method, ...(packet.params === undefined ? [] : [packet.params])])
        const payload = packet.method === "readClipboard"
          ? clipboardSnapshot
          : packet.method === "checkForUpdates"
            ? updateSnapshot
            : { ok: true }
        queueMicrotask(() => receive({ type: "response", id: packet.id, success: true, payload }))
      },
    })
    const bridge = bridgeModule.createDesktopBridge(bridgeModule.desktopRPC, () => undefined) as unknown as {
      readClipboard: () => Promise<typeof clipboardSnapshot>
      writeClipboard: (input: { text: string }) => Promise<unknown>
      checkForUpdates: () => Promise<typeof updateSnapshot>
      installUpdate: (input: { version: string }) => Promise<unknown>
      onMenuAction: (listener: (action: "check-for-updates" | "open-settings" | "new-chat") => void) => () => void
    }
    expect(await bridge.readClipboard()).toEqual(clipboardSnapshot)
    await bridge.writeClipboard({ text: "bridge text" })
    expect(await bridge.checkForUpdates()).toEqual(updateSnapshot)
    await bridge.installUpdate({ version: "0.11.2" })
    expect(bridgeCalls).toEqual([
      ["readClipboard"],
      ["writeClipboard", { text: "bridge text" }],
      ["checkForUpdates"],
      ["installUpdate", { version: "0.11.2" }],
    ])

    const receivedActions: string[] = []
    const unsubscribe = bridge.onMenuAction((action) => { receivedActions.push(action) })
    receive({ type: "message", id: "menuAction", payload: "new-chat" })
    receive({ type: "message", id: "menuAction", payload: "open-settings" })
    unsubscribe()
    receive({ type: "message", id: "menuAction", payload: "check-for-updates" })
    expect(receivedActions).toEqual(["new-chat", "open-settings"])
  } finally {
    if (original === undefined) Reflect.deleteProperty(globalThis, "window")
    else Reflect.set(globalThis, "window", original)
  }
})

test("startDesktopConnection retries with bounded backoff, stops immediately on abort, and skips corrupt preferences", async () => {
  type RetryOptions = { readonly delaysMs?: readonly number[]; readonly signal?: AbortSignal }
  const startWithOptions = startDesktopConnection as unknown as (
    preferences: Preferences,
    connect: (selection: Selection) => Promise<unknown>,
    log?: (line: string) => void,
    options?: RetryOptions,
  ) => unknown

  let attempts = 0
  const selections: unknown[] = []
  const lines: string[] = []
  const run = startWithOptions(
    { selection: { mode: "shared" } },
    async (selection) => {
      selections.push(selection)
      attempts++
      if (attempts < 3) throw new Error(`transient startup failure ${attempts}`)
      return { generation: 1, status: "connected" }
    },
    (line) => { lines.push(line) },
    { delaysMs: [5, 10] },
  )
  if (run instanceof Promise) await run
  else await Bun.sleep(45)
  expect(attempts).toBe(3)
  expect(selections).toEqual([{ mode: "shared" }, { mode: "shared" }, { mode: "shared" }])
  expect(lines).toHaveLength(2)
  expect(lines[0]).toContain("transient startup failure 1")
  expect(lines[1]).toContain("transient startup failure 2")

  const preAborted = new AbortController()
  preAborted.abort()
  let preAbortedCalls = 0
  startWithOptions(
    { selection: { mode: "shared" } },
    async () => { preAbortedCalls++ },
    undefined,
    { delaysMs: [5, 10], signal: preAborted.signal },
  )
  await Bun.sleep(20)
  expect(preAbortedCalls).toBe(0)

  const midAbort = new AbortController()
  let abortedCalls = 0
  startWithOptions(
    { selection: { mode: "shared" } },
    async () => {
      abortedCalls++
      midAbort.abort()
      throw new Error("aborted startup failure")
    },
    undefined,
    { delaysMs: [5, 10], signal: midAbort.signal },
  )
  await Bun.sleep(35)
  expect(abortedCalls).toBe(1)

  let corruptCalls = 0
  startWithOptions(
    { error: "invalid preferences", selection: { mode: "own" } },
    async () => { corruptCalls++ },
    undefined,
    { delaysMs: [5, 10] },
  )
  await Bun.sleep(25)
  expect(corruptCalls).toBe(0)
})
