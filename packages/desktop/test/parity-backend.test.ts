import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { BackendController } from "../src/backend-controller"
import { createDesktopRPC } from "../src/rpc"
import { env, launch, revision, syntheticBundle } from "./synthetic-backend"

const hidden = "synthetic-secret-never-return"
const extra = { auth: hidden, password: hidden, authorization: hidden, headers: { authorization: hidden } }
const sessionInfo = { id: "ses_test", title: "Synthetic", location: { directory: "/synthetic/repo" }, time: { created: 1, updated: 2 }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 }
type Call = { method: string; route: string; query: URLSearchParams; body: Record<string, unknown> }

function safe(value: unknown) {
  expect(JSON.stringify(value)).not.toContain(hidden)
  if (Array.isArray(value)) { value.forEach(safe); return }
  if (typeof value !== "object" || value === null) return
  for (const [key, item] of Object.entries(value)) {
    expect(["auth", "password", "authorization"]).not.toContain(key.toLowerCase())
    safe(item)
  }
}

async function fixture(handle: (call: Call) => unknown | Promise<unknown> = () => undefined) {
  const resources = await syntheticBundle()
  const calls: Call[] = []
  const controller = new BackendController(resources, { env, launch, cwd: resources, fetch: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.pathname === "/api/health") return Response.json({ healthy: true, version: "synthetic", pid: 101, sourceEpoch: "synthetic" })
    if (url.pathname === "/api/event") return new Response(new ReadableStream({ start(stream) {
      stream.enqueue(new TextEncoder().encode('data: {"type":"server.connected","properties":{}}\n\n'))
      request.signal.addEventListener("abort", () => stream.close(), { once: true })
    } }), { headers: { "content-type": "text/event-stream" } })
    const call = { method: request.method, route: url.pathname, query: url.searchParams, body: request.body ? await request.json() as Record<string, unknown> : {} }
    calls.push(call)
    const value = await handle(call)
    if (value instanceof Response) return value
    if (value !== undefined) return Response.json(value)
    if (url.pathname === "/api/coordination") return Response.json({ data: [] })
    if (url.pathname === "/api/coordination/settings") return Response.json({ data: { enabled: false, categories: [] } })
    if (url.pathname === "/api/project/inventory") return Response.json({ data: [], cursor: {} })
    return new Response(null, { status: 204 })
  }, { preconnect: () => {} }) })
  const connected = await controller.connect({ mode: "shared", server: "http://synthetic.invalid" })
  return { controller, calls, resources, revision: revision(connected), async close() { await controller.disconnect(); await fs.rm(resources, { recursive: true, force: true }) } }
}

test("folder browsing works disconnected, sorts directories first, filters hidden entries and follows only valid symlinks", async () => {
  const root = await syntheticBundle()
  const controller = new BackendController(root, { cwd: root })
  try {
    await fs.mkdir(path.join(root, "Zoo"))
    await fs.writeFile(path.join(root, "a.txt"), hidden)
    await fs.writeFile(path.join(root, ".hidden"), hidden)
    await fs.symlink(path.join(root, "Zoo"), path.join(root, "linked"))
    await fs.symlink(path.join(root, "missing"), path.join(root, "broken"))
    const listing = await controller.browseDirectory()
    expect(listing.directory).toBe(root)
    expect(listing.parent).toBe(path.dirname(root))
    expect(listing.entries.some((entry) => entry.name === ".hidden" || entry.name === "broken")).toBe(false)
    expect(listing.entries.find((entry) => entry.name === "linked")?.kind).toBe("directory")
    expect(listing.entries.findIndex((entry) => entry.name === "Zoo")).toBeLessThan(listing.entries.findIndex((entry) => entry.name === "a.txt"))
    expect((await controller.browseDirectory({ directory: root, showHidden: true })).entries.some((entry) => entry.name === ".hidden")).toBe(true)
    await expect(controller.browseDirectory({ directory: "relative" })).rejects.toThrow()
    await expect(controller.browseDirectory({ directory: path.join(root, "a.txt") })).rejects.toThrow()
    await Promise.all(Array.from({ length: 501 }, (_, i) => fs.mkdir(path.join(root, `folder-${i}`))))
    const capped = await controller.browseDirectory({ directory: root })
    expect(capped.entries).toHaveLength(500)
    expect(capped.truncated).toBe(true)
    safe(capped)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test("opening and creating folders register exact directories without exposing backend configuration", async () => {
  const owned = await fixture((call) => call.route === "/api/location" ? { directory: call.query.get("location[directory]"), project: { id: "prj_test", ...extra }, ...extra } : undefined)
  try {
    expect(await owned.controller.openDirectory({ directory: owned.resources })).toEqual({ revision: owned.revision, directory: owned.resources, projectID: "prj_test" })
    const created = await owned.controller.createDirectory({ parentDirectory: owned.resources, name: " New folder " })
    expect(created).toEqual({ revision: owned.revision, directory: path.join(owned.resources, "New folder"), projectID: "prj_test" })
    expect((await fs.stat(created.directory)).isDirectory()).toBe(true)
    await expect(owned.controller.createDirectory({ parentDirectory: owned.resources, name: "New folder" })).rejects.toThrow("already exists")
    for (const name of ["", " ", ".", "..", "../escape", "a\\b", "a\0b", "a\nb", "é".repeat(128)])
      await expect(owned.controller.createDirectory({ parentDirectory: owned.resources, name })).rejects.toThrow()
    expect(owned.calls.filter((call) => call.route === "/api/location")).toHaveLength(2)
    safe(created)
  } finally { await owned.close() }
})

test("Project searches trim and bound UTF-8 input while retaining coordination settings", async () => {
  const owned = await fixture()
  try {
    const snapshot = await owned.controller.projects({ search: "  repository  " })
    expect(snapshot.settings).toEqual({ enabled: false, categories: [] })
    expect(snapshot.groups).toEqual([])
    expect(owned.calls.find((call) => call.route === "/api/project/inventory")?.query.get("search")).toBe("repository")
    await owned.controller.projects({ search: "é".repeat(128) })
    const before = owned.calls.length
    for (const search of ["é".repeat(129), 1, null]) await expect(owned.controller.projects({ search })).rejects.toThrow()
    expect(owned.calls).toHaveLength(before)
    await owned.controller.projects({ search: " " })
    expect(owned.calls.at(-1)?.query.has("search")).toBe(false)
  } finally { await owned.close() }
})

test("Project creation registers a folder and reports a reusable Master Session after coordination failure", async () => {
  const owned = await fixture((call) => {
    if (call.route === "/api/location") return { directory: call.query.get("location[directory]"), project: { id: "prj_test" } }
    if (call.route === "/api/session") return { data: { ...sessionInfo, location: { directory: owned.resources } } }
    if (call.method === "POST" && call.route === "/api/coordination") return new Response(JSON.stringify({ message: hidden }), { status: 409 })
    return undefined
  })
  try {
    await expect(owned.controller.changeProject({ kind: "create-in-directory", revision: owned.revision, name: " Team ", directory: owned.resources, memberSessionIDs: [] })).rejects.toThrow("Master Session ses_test was created, but Project creation failed:")
    expect(owned.calls.map((call) => call.route)).toEqual(["/api/location", "/api/session", "/api/coordination"])
    expect(owned.calls[1]?.body).toMatchObject({ title: "Team" })
    expect(owned.calls[2]?.body).toMatchObject({ name: "Team", masterSessionID: "ses_test", memberSessionIDs: [] })
  } finally { await owned.close() }
})

test("integration discovery and all credential flows keep only display fields and never return supplied keys", async () => {
  const owned = await fixture((call) => {
    if (call.route === "/api/integration") return { data: [{ id: "test", name: "Test", methods: [{ type: "key", ...extra }, { type: "oauth", id: "web", label: "Web", ...extra }], connections: [{ type: "credential", id: "cred_test", label: "Work", active: true, kind: "key", ...extra }], ...extra }] }
    if (call.route.endsWith("/connect/oauth") && call.method === "POST") return { data: { attemptID: "con_test", url: "https://example.test/connect", mode: "code", instructions: "Enter the code", manualCode: true, time: { created: 1, expires: 2 }, ...extra } }
    if (call.route.endsWith("/connect/command") && call.method === "POST") return { data: { attemptID: "con_test", time: { created: 1, expires: 2 }, ...extra } }
    if (call.method === "GET") return { data: { status: "pending", time: { created: 1, expires: 2 }, ...extra } }
    return undefined
  })
  try {
    const list = await owned.controller.integrations()
    expect(list.items[0]?.connections[0]).toMatchObject({ id: "cred_test", label: "Work" })
    safe(list)
    const start = await owned.controller.manageIntegration({ kind: "oauth-start", revision: owned.revision, integrationID: "test", methodID: "web" })
    expect(start.attempt).toMatchObject({ attemptID: "con_test", kind: "oauth", mode: "code", status: "pending" })
    safe(start)
    const inputs = [
      { kind: "connect-key", integrationID: "test", key: hidden },
      { kind: "oauth-status", integrationID: "test", attemptID: "con_test" },
      { kind: "oauth-complete", integrationID: "test", attemptID: "con_test", code: "synthetic-code" },
      { kind: "oauth-cancel", integrationID: "test", attemptID: "con_test" },
      { kind: "command-start", integrationID: "test", methodID: "cli" },
      { kind: "command-status", integrationID: "test", attemptID: "con_test" },
      { kind: "command-cancel", integrationID: "test", attemptID: "con_test" },
      { kind: "wellknown-add", url: "https://example.test" },
      { kind: "credential-activate", credentialID: "cred_test" },
      { kind: "credential-rename", credentialID: "cred_test", label: "Team" },
      { kind: "credential-remove", credentialID: "cred_test" },
    ]
    for (const input of inputs) safe(await owned.controller.manageIntegration({ ...input, revision: owned.revision }))
    expect(owned.calls.find((call) => call.route.endsWith("/connect/key"))?.body).toEqual({ key: hidden })
    expect(owned.calls.filter((call) => call.route !== "/api/integration").map((call) => `${call.method} ${call.route}`)).toEqual([
      "POST /api/integration/test/connect/oauth", "POST /api/integration/test/connect/key", "GET /api/integration/test/connect/oauth/con_test", "POST /api/integration/test/connect/oauth/con_test/complete", "DELETE /api/integration/test/connect/oauth/con_test", "POST /api/integration/test/connect/command", "GET /api/integration/test/connect/command/con_test", "DELETE /api/integration/test/connect/command/con_test", "POST /api/experimental/integration/wellknown", "POST /api/credential/cred_test/activate", "PATCH /api/credential/cred_test", "DELETE /api/credential/cred_test",
    ])
    const before = owned.calls.length
    await expect(owned.controller.manageIntegration({ kind: "connect-key", revision: owned.revision - 1, integrationID: "test", key: hidden })).rejects.toThrow()
    expect(owned.calls).toHaveLength(before)
    safe(await owned.controller.manageIntegration({ kind: "connect-key", revision: owned.revision, integrationID: "mcp:sample/server", key: hidden }))
    expect(owned.calls.at(-1)?.route).toBe("/api/integration/mcp%3Asample%2Fserver/connect/key")
  } finally { await owned.close() }
})

test("MCP projection retains needs_auth values, tolerates unavailable resources and sends only clean runtime configs", async () => {
  const owned = await fixture((call) => {
    if (call.route === "/api/mcp") return { data: [{ name: "test", status: { status: "needs_auth", ...extra }, ...extra }] }
    if (call.route === "/api/mcp/resource") return new Response(null, { status: 503 })
    return undefined
  })
  try {
    const snapshot = await owned.controller.mcpServers()
    expect(snapshot.items).toEqual([{ name: "test", status: "needs_auth", resources: [] }])
    expect(snapshot.resourcesNotice).toBeDefined()
    safe(snapshot)
    for (const kind of ["connect", "disconnect", "remove"]) safe(await owned.controller.manageMcp({ kind, revision: owned.revision, name: "test" }))
    safe(await owned.controller.manageMcp({ kind: "add", revision: owned.revision, name: "test", config: { type: "local", command: ["synthetic-mcp"] } }))
    expect(owned.calls.find((call) => call.method === "PUT")?.body).toEqual({ config: { type: "local", command: ["synthetic-mcp"] } })
    await expect(owned.controller.manageMcp({ kind: "add", revision: owned.revision, name: "test", config: { type: "remote", url: "https://example.test", headers: { authorization: hidden } } })).rejects.toThrow()
  } finally { await owned.close() }
})

test("Session lifecycle routes preserve explicit targets, project forks and reject stale or malformed mutations", async () => {
  const owned = await fixture((call) => {
    if (call.route.endsWith("/fork")) return { data: { ...sessionInfo, id: "ses_fork", ...extra } }
    if (call.route.endsWith("/daybreak")) return { data: sessionInfo }
    if (call.route.endsWith("/subagent/ses_child/cancel")) return { data: {} }
    if (call.method === "GET" && call.route === "/api/session/ses_test") return { data: sessionInfo }
    if (call.route === "/api/shell") return { location: sessionInfo.location, data: [{ id: "sh_test", metadata: { sessionID: "ses_test" } }] }
    return undefined
  })
  try {
    const fork = await owned.controller.manageSession({ kind: "fork", sessionID: "ses_test", revision: owned.revision, messageID: "msg_test" })
    expect(fork.item?.id).toBe("ses_fork")
    safe(fork)
    for (const input of [{ kind: "rename", title: " New title " }, { kind: "archive" }, { kind: "unarchive" }, { kind: "background" }, { kind: "daybreak", daybreak: "daybreak_blue" }, { kind: "cancel-subagent", childSessionID: "ses_child" }, { kind: "resolve-skill-conflict", winner: "kept", loser: "dropped" }, { kind: "kill-shell", shellID: "sh_test" }, { kind: "delete" }])
      safe(await owned.controller.manageSession({ ...input, sessionID: "ses_test", revision: owned.revision }))
    expect(owned.calls.some((call) => call.route === "/api/session/ses_test/subagent/ses_child/cancel")).toBe(true)
    expect(owned.calls.find((call) => call.route.endsWith("/daybreak"))?.body).toEqual({ daybreak: "daybreak_blue" })
    const before = owned.calls.length
    await expect(owned.controller.manageSession({ kind: "archive", sessionID: "ses_test", revision: owned.revision - 1 })).rejects.toThrow()
    await expect(owned.controller.manageSession({ kind: "rename", sessionID: "ses_test", revision: owned.revision, title: " " })).rejects.toThrow()
    expect(owned.calls).toHaveLength(before)
  } finally { await owned.close() }
})

test("guardrail and review replies re-read pending identity and use the owning Session without echoing metadata", async () => {
  const owned = await fixture((call) => {
    if (call.route.endsWith("/permission") || call.route.endsWith("/form")) return { data: [] }
    if (call.route.endsWith("/guardrail/request")) return { data: [{ id: "grq_test", sessionID: "ses_child", rootSessionID: "ses_test", action: "edit", resources: [], ruleIDs: [], reason: "Review", standard: true, metadata: extra, ...extra }] }
    if (call.route.endsWith("/review")) return { data: [{ itemID: "rvw_test", sessionID: "ses_child", rootSessionID: "ses_test", sessionTitle: "Child", kind: "recovery", reason: "restart", created: 1, origin: { requestID: "recovery" }, payload: { type: "recovery", tools: [{ messageID: "msg_test", callID: "call", name: "shell" }] }, ...extra }] }
    return undefined
  })
  try {
    const pending = await owned.controller.requests("ses_test")
    expect(pending.guardrails?.[0]?.id).toBe("grq_test")
    expect(pending.reviews?.[0]?.itemID).toBe("rvw_test")
    safe(pending)
    await owned.controller.reply({ kind: "guardrail", sessionID: "ses_test", revision: owned.revision, requestID: "grq_test", reply: "reject" })
    await owned.controller.reply({ kind: "review", sessionID: "ses_test", revision: owned.revision, itemID: "rvw_test", decision: { kind: "recovery", choice: "stop" } })
    expect(owned.calls.filter((call) => call.method === "POST").map((call) => [call.route, call.body])).toEqual([
      ["/api/session/ses_child/guardrail/request/grq_test/reply", { reply: "reject" }],
      ["/api/session/ses_child/review/rvw_test/decide", { decision: { kind: "recovery", choice: "stop" } }],
    ])
  } finally { await owned.close() }
})

test("VCS diff and system snapshots project nested status, server URLs and catalogs without endpoint credentials", async () => {
  const owned = await fixture((call) => {
    if (call.route === "/api/session/ses_test") return { data: sessionInfo }
    if (call.route === "/api/vcs/branch") return { location: sessionInfo.location, data: { current: "topic", default: "main", ...extra } }
    if (call.route === "/api/vcs/status") return { location: sessionInfo.location, data: [{ file: "a.ts", additions: 1, deletions: 1, status: "modified", ...extra }] }
    if (call.route === "/api/vcs/diff") return { location: sessionInfo.location, data: [{ file: "a.ts", patch: "@@ -1 +1 @@\n-old\n+new", additions: 1, deletions: 1, status: "modified", ...extra }] }
    if (call.route === "/api/server") return { urls: ["http://localhost:1234", `https://user:${hidden}@example.test`], ...extra }
    if (call.route === "/api/remote") return { data: { state: "disabled", ...extra } }
    if (call.route === "/api/dots") return { data: { access: { enabled: false, revision: 0, ...extra }, ...extra } }
    if (call.route.endsWith("/browser")) return { data: { state: "unavailable", ...extra } }
    if (call.route.endsWith("/browser/isolated")) return { data: { mode: "isolated", state: "stopped", ...extra } }
    if (call.route.endsWith("/tabs") || call.route.endsWith("/skills") || call.route === "/api/skill" || call.route === "/api/artifact" || call.route === "/api/plugin") return { data: [] }
    return undefined
  })
  try {
    const diff = await owned.controller.vcsDiff({ source: "ses_test", mode: "branch" })
    expect(diff.branch).toEqual({ current: "topic", default: "main" })
    expect(diff.files[0]?.file).toBe("a.ts")
    safe(diff)
    await owned.controller.vcsDiff({ source: "ses_test", mode: "git" })
    expect(owned.calls.filter((call) => call.route === "/api/vcs/diff").map((call) => call.query.get("mode"))).toEqual(["branch", "working"])
    const system = await owned.controller.systemSnapshot({ sessionID: "ses_test" })
    expect(system.server?.urls).toEqual(["http://localhost:1234/"])
    safe(system)
    safe(await owned.controller.manageSystem({ kind: "remote-set", revision: owned.revision, enabled: false }))
    expect(owned.calls.find((call) => call.method === "PUT" && call.route === "/api/remote")?.body).toEqual({ enabled: false })
  } finally { await owned.close() }
})

test("native folder selection registers when connected and external URLs are HTTPS-only", async () => {
  const opened: string[] = []
  const controller = { state: () => ({ status: "connected" }), openDirectory: async (input: { directory: string }) => { opened.push(input.directory) } } as unknown as BackendController
  const urls: string[] = []
  const rpc = createDesktopRPC(controller, { path: "/synthetic/preferences", read: async () => ({}), save: async () => {}, validate: () => ({ mode: "own" }) }, {
    pickDirectory: async () => "/synthetic/repo", openExternal: async (url) => { urls.push(url); return true },
  })
  expect(await rpc.pickDirectory()).toEqual({ directory: "/synthetic/repo" })
  expect(opened).toEqual(["/synthetic/repo"])
  expect(await rpc.openExternalUrl({ url: "https://example.test/connect" })).toEqual({ opened: true })
  for (const url of ["http://example.test", "file:///tmp/a", "javascript:alert(1)", "views://mainview/index.html", "https://user:secret@example.test"])
    await expect(rpc.openExternalUrl({ url })).rejects.toThrow()
  expect(urls).toEqual(["https://example.test/connect"])
})

test("system management forwards explicit browser and artifact expectations, returns only pairing display data and refuses unsupported plugin writes", async () => {
  const owned = await fixture((call) => {
    if (call.route === "/api/session/ses_test") return { data: sessionInfo }
    if (call.route.endsWith("/browser/start")) return { data: { secret: "synthetic-pairing-code", expiresAt: 1234, ...extra } }
    if (call.route.endsWith("/browser/isolated/start")) return { data: { mode: "isolated", state: "running", ...extra } }
    if (call.route === "/api/server") return { urls: [] }
    if (call.route === "/api/remote") return { data: { state: "disabled", ...extra } }
    if (call.route === "/api/dots") return { data: { access: { enabled: false, revision: 0, ...extra } } }
    if (call.method === "GET") return new Response(null, { status: 503 })
    return undefined
  })
  try {
    const paired = await owned.controller.manageSystem({ kind: "browser-start", sessionID: "ses_test", revision: owned.revision })
    expect(paired.pairing).toEqual({ secret: "synthetic-pairing-code", expiresAt: 1234 })
    safe(paired)
    expect(paired.notices.Skills).toBeDefined()
    const artifact = { scope: "project", kind: "skill", id: "sample", expectedRevision: 3, expectedVersionID: "pav_test", expectedDigest: "a".repeat(64) }
    for (const input of [{ kind: "browser-forget" }, { kind: "isolated-browser-start", url: "https://example.test" }, { kind: "isolated-browser-stop" }, { kind: "artifact-enable", artifact }, { kind: "artifact-disable", artifact }])
      safe(await owned.controller.manageSystem({ ...input, sessionID: "ses_test", revision: owned.revision }))
    expect(owned.calls.filter((call) => call.method === "POST" && call.route.startsWith("/api/artifact")).map((call) => [call.route, call.body])).toEqual([
      ["/api/artifact/project/skill/sample/enable", { expectedRevision: 3, expectedVersionID: "pav_test", expectedDigest: "a".repeat(64) }],
      ["/api/artifact/project/skill/sample/disable", { expectedRevision: 3, expectedVersionID: "pav_test", expectedDigest: "a".repeat(64) }],
    ])
    const before = owned.calls.length
    await expect(owned.controller.manageSystem({ kind: "plugin-add", spec: "synthetic-plugin", revision: owned.revision })).rejects.toThrow("plugin discovery only")
    await expect(owned.controller.manageSystem({ kind: "browser-start", revision: owned.revision })).rejects.toThrow("Choose a Session")
    await expect(owned.controller.manageSystem({ kind: "remote-set", revision: owned.revision - 1, enabled: true })).rejects.toThrow()
    expect(owned.calls).toHaveLength(before)
  } finally { await owned.close() }
})

test("management reads and multi-step mutations reject a connection retired while their first request is pending", async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const owned = await fixture(async (call) => {
    if (call.route === "/api/session/ses_test") { entered.resolve(); await release.promise; return { data: sessionInfo } }
    return undefined
  })
  try {
    const pending = owned.controller.manageMcp({ kind: "connect", source: "ses_test", revision: owned.revision, name: "test" })
    const outcome = pending.then(() => "unexpected success", (error: unknown) => error instanceof Error ? error.message : "unknown failure")
    await entered.promise
    await owned.controller.disconnect()
    release.resolve()
    expect(await outcome).toContain("not confirmed")
    expect(owned.calls.map((call) => call.route)).toEqual(["/api/session/ses_test"])
  } finally { release.resolve(); await owned.close() }
})
