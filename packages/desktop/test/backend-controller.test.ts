import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import { BackendController } from "../src/backend-controller"
import { Coordination, KeepAwake, PermissionSaved, ProjectCopy, Schema, Telemetry } from "@ycoding-ai/client/effect"
import type { ConnectionState } from "../src/contract"
import { env, launch, peer, revision, syntheticBundle } from "./synthetic-backend"

const id = "ses_synthetic"
const task = { sessionID: "ses_child", parentID: id, description: "Synthetic", agent: "build", model: { id: "model", providerID: "provider" }, background: true, state: "running", revision: 1, time: { created: 1, updated: 2 } }
const shell = (id: string, metadata: Record<string, unknown>) => ({ id, status: "running", command: "echo", cwd: "/synthetic/repo", shell: "sh", file: "output", time: { started: 1 }, metadata })
const metrics = { logical: 1, physical: 1, helpers: 0, continued: 0, fallback: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }
const repository = { projectID: "prj_test", projectWorktree: "/synthetic/repo", directory: "/synthetic/repo", sessions: 1, timeActive: 1, available: true }
const participant = { sessionID: id, title: "Synthetic", location: { directory: "/synthetic/repo" }, state: "idle", lastActivity: 1, pending: [] }
const group = { id: "cgrp_synthetic", name: "Synthetic", revision: 1, active: true, master: participant, members: [], settings: { concurrency: null }, time: { created: 1, updated: 2 } }

test("settings project canonical data and report unavailable telemetry", async () => {
  const keep = { state: "on", manual: true, extra: "hidden" }
  const consent = { noticeVersion: 1, consent: { enabled: true, noticeVersion: 1, decidedAt: 1, extra: "hidden" }, extra: "hidden" }
  const saved = { id: "psv_test", projectID: "prj_test", action: "edit", resource: "repo", extra: "hidden" }
  const sample = { receivedAt: 1, sample: { kind: "long-task" as const, at: "2026-01-01T00:00:00.000Z", durationMs: 50 } }
  let broken = false
  let readSamples = 0
  await connected(async (route) => {
    if (route === "/api/keep-awake") return Response.json({ data: keep })
    if (route === "/api/server/telemetry/consent") return Response.json(consent)
    if (route === "/api/permission/saved") return Response.json({ data: [saved] })
    if (route === "/api/server/web-latency") { readSamples++; return broken ? new Response(null, { status: 503 }) : Response.json({ data: [sample], cursor: {} }) }
    return undefined
  }, async (controller, rev) => {
    expect(Schema.decodeUnknownSync(Schema.toCodecJson(KeepAwake.Status))(keep)).toEqual({ state: "on", manual: true })
    expect(Schema.decodeUnknownSync(Schema.toCodecJson(Telemetry.ConsentState))(consent)).toEqual({ noticeVersion: 1, consent: { enabled: true, noticeVersion: 1, decidedAt: 1 } })
    expect(Schema.decodeUnknownSync(Schema.toCodecJson(PermissionSaved.Info))(saved) as unknown).toEqual({ id: "psv_test", projectID: "prj_test", action: "edit", resource: "repo" })
    expect(Schema.decodeUnknownSync(Schema.toCodecJson(Telemetry.Page))({ data: [sample], cursor: {} })).toEqual({ data: [sample], cursor: {} })
    expect(await controller.settings() as unknown).toEqual({ revision: rev, keepAwake: { state: "on", manual: true }, telemetryConsent: { noticeVersion: 1, consent: { enabled: true, noticeVersion: 1, decidedAt: 1 } }, telemetrySamples: [sample], savedPermissions: [{ id: "psv_test", projectID: "prj_test", action: "edit", resource: "repo" }] })
    broken = true
    expect(await controller.settings()).toMatchObject({ telemetrySamples: [], telemetryNotice: "Telemetry samples could not be read." })
    expect(readSamples).toBe(2)
  })
})

test("settings skip samples without consent and reject malformed canonical responses", async () => {
  let keep: unknown = { state: "off" }
  let samples = 0
  await connected(async (route) => {
    if (route === "/api/keep-awake") return Response.json({ data: keep })
    if (route === "/api/server/telemetry/consent") return Response.json({ noticeVersion: 1 })
    if (route === "/api/permission/saved") return Response.json({ data: [] })
    if (route === "/api/server/web-latency") samples++
    return undefined
  }, async (controller) => {
    expect((await controller.settings()).telemetrySamples).toEqual([])
    expect(samples).toBe(0)
    keep = { state: "invalid" }
    expect(() => Schema.decodeUnknownSync(Schema.toCodecJson(KeepAwake.Status))(keep)).toThrow()
    await expect(controller.settings()).rejects.toThrow()
  })
})

test("settings mutations are revision fenced, validated and refreshed once", async () => {
  const writes: { route: string; body?: unknown }[] = []
  await connected(async (route, request) => {
    if (request.method === "PUT" || request.method === "DELETE") {
      writes.push({ route, ...(request.method === "PUT" ? { body: await request.json() } : {}) })
      if (route === "/api/keep-awake") return Response.json({ data: { state: "on", manual: true } })
      if (route === "/api/server/telemetry/consent") return Response.json({ enabled: true, noticeVersion: 1, decidedAt: 1 })
      return new Response(null, { status: 204 })
    }
    if (route === "/api/keep-awake") return Response.json({ data: { state: "off" } })
    if (route === "/api/server/telemetry/consent") return Response.json({ noticeVersion: 1 })
    if (route === "/api/permission/saved") return Response.json({ data: [{ id: "synthetic-rule", projectID: "prj_test", action: "edit", resource: "repo" }] })
    return undefined
  }, async (controller, revision) => {
    await controller.changeSettings({ kind: "keep-awake", revision, enabled: true })
    await controller.changeSettings({ kind: "telemetry-consent", revision, enabled: true })
    expect((await controller.settings()).savedPermissions[0]?.id as string | undefined).toBe("synthetic-rule")
    await controller.changeSettings({ kind: "remove-saved-permission", revision, id: "synthetic-rule" })
    await expect(controller.changeSettings({ kind: "keep-awake", revision: revision + 1, enabled: true })).rejects.toThrow()
    for (const invalid of ["", "   ", "é".repeat(513)]) await expect(controller.changeSettings({ kind: "remove-saved-permission", revision, id: invalid })).rejects.toThrow()
    expect(writes).toEqual([{ route: "/api/keep-awake", body: { enabled: true } }, { route: "/api/server/telemetry/consent", body: { enabled: true, noticeVersion: 1 } }, { route: "/api/permission/saved/synthetic-rule" }])
  })
})

test("settings mutation accepts unsupported keep-awake capability", async () => {
  let writes = 0
  await connected(async (route, request) => {
    if (route === "/api/keep-awake" && request.method === "PUT") { writes++; return Response.json({ data: { state: "unsupported", active: false, manual: false, sessions: 0, blockers: [] } }) }
    if (route === "/api/keep-awake") return Response.json({ data: { state: "unsupported", manual: false } })
    if (route === "/api/server/telemetry/consent") return Response.json({ noticeVersion: 1 })
    if (route === "/api/permission/saved") return Response.json({ data: [] })
    return undefined
  }, async (controller, revision) => {
    expect((await controller.changeSettings({ kind: "keep-awake", revision, enabled: true })).keepAwake).toEqual({ state: "unsupported", manual: false })
    expect(writes).toBe(1)
  })
})

test("keep-awake mutation confirms canonical producer replies", async () => {
  const idle = { display: "off", activity: "off", lid: "off", system: "off", sleepHold: false }
  const cases = [
    { name: "enable without manual", enabled: true, reply: { state: "on", ...idle, display: "on", activity: "on" }, confirmed: true },
    { name: "disable without manual", enabled: false, reply: { state: "off", ...idle }, confirmed: true },
    { name: "enable with manual", enabled: true, reply: { state: "on", ...idle, manual: true, sleepHold: true }, confirmed: true },
    { name: "disable under sleeping hold", enabled: false, reply: { state: "on", ...idle, manual: false, sleepHold: true }, confirmed: true },
    { name: "unsupported enable", enabled: true, reply: { state: "unsupported", ...idle, lid: "unsupported", system: "unsupported" }, confirmed: true },
    { name: "unsupported disable", enabled: false, reply: { state: "unsupported", manual: false }, confirmed: true },
    { name: "enable reports off", enabled: true, reply: { state: "off", ...idle }, confirmed: false },
    { name: "disable reports on", enabled: false, reply: { state: "on", ...idle, display: "on", activity: "on" }, confirmed: false },
    { name: "enable with manual false", enabled: true, reply: { state: "on", ...idle, manual: false, sleepHold: true }, confirmed: false },
    { name: "disable with manual true", enabled: false, reply: { state: "on", ...idle, manual: true, sleepHold: true }, confirmed: false },
    { name: "enable error", enabled: true, reply: { state: "error", ...idle, manual: true, message: "Synthetic failure" }, confirmed: false },
    { name: "disable error", enabled: false, reply: { state: "error", ...idle, message: "Synthetic failure" }, confirmed: false },
  ]
  for (const item of cases) {
    let writes = 0
    let reads = 0
    await connected(async (route, request) => {
      if (route === "/api/keep-awake" && request.method === "PUT") { writes++; return Response.json({ data: item.reply }) }
      if (request.method === "GET") reads++
      if (route === "/api/keep-awake") return Response.json({ data: item.reply })
      if (route === "/api/server/telemetry/consent") return Response.json({ noticeVersion: 1 })
      if (route === "/api/permission/saved") return Response.json({ data: [] })
      return undefined
    }, async (controller, revision) => {
      const change = controller.changeSettings({ kind: "keep-awake", revision, enabled: item.enabled })
      if (item.confirmed) expect((await change).keepAwake.state as string, item.name).toBe(item.reply.state)
      else await expect(change, item.name).rejects.toThrow("not confirmed")
      expect(writes, item.name).toBe(1)
      expect(reads > 0, item.name).toBe(item.confirmed)
    })
  }
})

test("project and workspace mutations validate canonical inputs and preserve delegated decisions", async () => {
  const writes: { route: string; body?: unknown }[] = []
  const extended = { ...group, settings: { concurrency: 1, delegatedDecisions: { categories: ["question"] } } }
  await connected(async (route, request) => {
    if (request.method === "POST" || request.method === "PATCH" || request.method === "DELETE") {
      writes.push({ route, ...(request.method === "PATCH" || route === "/api/coordination" || route.endsWith("/copy") || route === "/api/project/prj_test/directories" ? { body: await request.json() } : {}) })
      if (route === "/api/coordination" || route === `/api/coordination/${group.id}` && request.method === "PATCH") return Response.json({ data: extended })
      if (route.endsWith("/copy")) return Response.json({ directory: "/synthetic/copy" })
      return new Response(null, { status: 204 })
    }
    if (route === "/api/coordination") return Response.json({ data: [{ id: group.id }] })
    if (route === `/api/coordination/${group.id}`) return Response.json({ data: extended })
    if (route === "/api/coordination/settings") return Response.json({ data: { enabled: true, categories: [] } })
    if (route === "/api/project/inventory") return Response.json({ data: [repository], cursor: {} })
    if (route === "/api/project/prj_test/directories") return Response.json([{ directory: "/synthetic/repo" }])
    return undefined
  }, async (controller, revision) => {
    const create = { name: "Project", masterSessionID: id, memberSessionIDs: ["ses_child"] }
    expect(Schema.decodeUnknownSync(Schema.toCodecJson(Coordination.CreateInput))(create) as unknown).toEqual(create)
    expect(() => Schema.decodeUnknownSync(Schema.toCodecJson(Coordination.CreateInput))({ ...create, memberSessionIDs: Array(65).fill(id) })).toThrow()
    expect(Schema.decodeUnknownSync(Schema.toCodecJson(ProjectCopy.Copy))({ directory: "/synthetic/copy", extra: true }) as unknown).toEqual({ directory: "/synthetic/copy" })
    await controller.changeProject({ kind: "create", revision, ...create })
    await controller.changeProject({ kind: "update", revision, groupID: group.id, groupRevision: 1, concurrency: 2 })
    await controller.changeProject({ kind: "delete", revision, groupID: group.id })
    await controller.changeWorkspace({ kind: "create-copy", revision, projectID: "prj_test", sourceDirectory: "/synthetic/repo", directory: "/synthetic", name: "copy" })
    await controller.changeWorkspace({ kind: "refresh-copies", revision, projectID: "prj_test", directory: "/synthetic/repo" })
    await controller.changeWorkspace({ kind: "forget", revision, projectID: "prj_test", directory: "/synthetic/copy" })
    await expect(controller.changeProject({ kind: "create", revision, ...create, memberSessionIDs: Array(65).fill(id) })).rejects.toThrow()
    await expect(controller.changeWorkspace({ kind: "forget", revision: revision + 1, projectID: "prj_test", directory: "/synthetic/copy" })).rejects.toThrow()
    expect(writes).toEqual([{ route: "/api/coordination", body: create }, { route: `/api/coordination/${group.id}`, body: { revision: 1, settings: { concurrency: 2, delegatedDecisions: { categories: ["question"] } } } }, { route: `/api/coordination/${group.id}` }, { route: "/experimental/project/prj_test/copy", body: { strategy: "git_worktree", directory: "/synthetic", name: "copy" } }, { route: "/experimental/project/prj_test/copy/refresh" }, { route: "/api/project/prj_test/directories", body: { directory: "/synthetic/copy" } }])
  })
})

test.each(["consent", "permissions", "samples"] as const)("settings reject malformed canonical %s replies", async (invalid) => {
  const consent = invalid === "consent" ? { noticeVersion: 2 } : { noticeVersion: 1, consent: { enabled: true, noticeVersion: 1, decidedAt: 1 } }
  const saved = invalid === "permissions" ? [{ id: "psv_test", projectID: "p", action: 2, resource: "r" }] : []
  const samples = invalid === "samples" ? { data: [{ receivedAt: -1, sample: {} }], cursor: {} } : { data: [], cursor: {} }
  if (invalid === "consent") expect(() => Schema.decodeUnknownSync(Schema.toCodecJson(Telemetry.ConsentState))(consent)).toThrow()
  if (invalid === "permissions") expect(() => Schema.decodeUnknownSync(Schema.toCodecJson(Schema.Array(PermissionSaved.Info)))(saved)).toThrow()
  if (invalid === "samples") expect(() => Schema.decodeUnknownSync(Schema.toCodecJson(Telemetry.Page))(samples)).toThrow()
  await connected(async (route) => {
    if (route === "/api/keep-awake") return Response.json({ data: { state: "off" } })
    if (route === "/api/server/telemetry/consent") return Response.json(consent)
    if (route === "/api/permission/saved") return Response.json({ data: saved })
    if (route === "/api/server/web-latency") return Response.json(samples)
    return undefined
  }, async (controller) => { await expect(controller.settings()).rejects.toThrow() })
})

test("mutation replies must confirm canonical values before any refresh", async () => {
  let writes = 0
  let reads = 0
  await connected(async (route, request) => {
    if (request.method === "GET") { reads++; return undefined }
    writes++
    if (route === "/api/keep-awake") return Response.json({ data: { state: "on", manual: false } })
    if (route === "/api/server/telemetry/consent") return Response.json({ enabled: false, noticeVersion: 1, decidedAt: 1 })
    if (route === "/api/coordination") return Response.json({ data: { ...group, revision: -1 } })
    if (route.endsWith("/copy")) return Response.json({ directory: 7 })
    return undefined
  }, async (controller, revision) => {
    expect(() => Schema.decodeUnknownSync(Schema.toCodecJson(Coordination.Info))({ ...group, revision: -1 })).toThrow()
    expect(() => Schema.decodeUnknownSync(Schema.toCodecJson(ProjectCopy.Copy))({ directory: 7 })).toThrow()
    expect(() => Schema.decodeUnknownSync(Schema.toCodecJson(Telemetry.Consent))({ enabled: true, noticeVersion: 1, decidedAt: -1 })).toThrow()
    await expect(controller.changeSettings({ kind: "keep-awake", revision, enabled: true })).rejects.toThrow("not confirmed")
    await expect(controller.changeSettings({ kind: "telemetry-consent", revision, enabled: true })).rejects.toThrow("not confirmed")
    await expect(controller.changeProject({ kind: "create", revision, name: "Project", masterSessionID: id, memberSessionIDs: [] })).rejects.toThrow("not confirmed")
    await expect(controller.changeWorkspace({ kind: "create-copy", revision, projectID: "p", sourceDirectory: "/source", directory: "/copy" })).rejects.toThrow("not confirmed")
    expect(writes).toBe(4)
    expect(reads).toBe(0)
  })
})

test("invalid project and workspace inputs do not dispatch", async () => {
  let calls = 0
  await connected(async () => { calls++; return undefined }, async (controller, revision) => {
    const invalidUpdate = { revision: 1, settings: { concurrency: 0 } }
    expect(() => Schema.decodeUnknownSync(Schema.toCodecJson(Coordination.UpdateInput))(invalidUpdate)).toThrow()
    expect(() => Schema.decodeUnknownSync(Schema.toCodecJson(Coordination.GroupID))("cgrp_")).toThrow()
    expect(() => Schema.decodeUnknownSync(Schema.toCodecJson(ProjectCopy.CreateInput))({ projectID: "p", sourceDirectory: "/source", directory: "/copy", strategy: " " })).toThrow()
    for (const request of [
      { kind: "create", revision, name: " ", masterSessionID: id, memberSessionIDs: [] },
      { kind: "update", revision, groupID: "cgrp_test", groupRevision: 1, concurrency: 0 },
      { kind: "delete", revision, groupID: "cgrp_" },
    ]) await expect(controller.changeProject(request)).rejects.toThrow()
    for (const request of [
      { kind: "create-copy", revision, projectID: "p", sourceDirectory: "/source", directory: "/copy", strategy: " " },
      { kind: "refresh-copies", revision, projectID: "p", directory: "relative" },
      { kind: "forget", revision, projectID: "", directory: "/copy" },
    ]) await expect(controller.changeWorkspace(request)).rejects.toThrow()
    expect(calls).toBe(0)
  })
})

test.each(["settings", "project", "workspace"] as const)("%s mutation interrupted in flight is not replayed", async (kind) => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let writes = 0
  await connected(async (_route, request) => {
    if (request.method === "GET") return undefined
    writes++; entered.resolve(); await release.promise
    return new Response(null, { status: 204 })
  }, async (controller, revision) => {
    const pending = kind === "settings" ? controller.changeSettings({ kind: "remove-saved-permission", revision, id: "psv_test" }) : kind === "project" ? controller.changeProject({ kind: "delete", revision, groupID: "cgrp_test" }) : controller.changeWorkspace({ kind: "forget", revision, projectID: "p", directory: "/synthetic" })
    const outcome = pending.then(() => "resolved", (error: unknown) => error instanceof Error ? error.message : String(error))
    await entered.promise
    await controller.disconnect()
    release.resolve()
    expect(await outcome).toContain("not confirmed")
    expect(writes).toBe(1)
  })
})
const autonomy = { mode: "normal", permissions: "manual", guardrails: "auto", answers: "yolo", goal: { text: "Synthetic goal", status: "active", iteration: 0, noProgress: 0, maxNoProgress: 3, lastProgressDigest: null }, sleep: null, effective: { permissions: "auto", guardrails: "manual", answers: "yolo", inherited: { permissions: "ses_parent" }, asleep: false, guardrailsEnabled: true } } as const

test("autonomy reads and fenced updates project valid views without replay", async () => {
  const calls: { method: string; payload?: unknown }[] = []
  let view: unknown = { ...autonomy, extra: "hidden", effective: { ...autonomy.effective, extra: "hidden" } }
  await connected(async (route, request) => {
    if (route !== `/api/session/${id}/autonomy`) return undefined
    calls.push({ method: request.method, ...(request.method === "PUT" ? { payload: await request.json() } : {}) })
    return Response.json({ data: view })
  }, async (controller, rev) => {
    expect(await controller.autonomy(id)).toEqual({ revision: rev, sessionID: id, autonomy })
    expect(await controller.setAutonomy({ sessionID: id, revision: rev, payload: { permissions: "auto", answers: "manual" } })).toEqual({ revision: rev, sessionID: id, autonomy })
    for (const payload of [{ guardrails: "manual" }, { answers: "auto" }, { sleep: true }, { goal: "synthetic", maxNoProgress: 2 }, { goal: true }] as const)
      await controller.setAutonomy({ sessionID: id, revision: rev, payload })
    await expect(controller.setAutonomy({ sessionID: id, revision: rev + 1, payload: { sleep: true } })).rejects.toThrow()
    for (const payload of [{}, { permissions: "invalid" }, { goal: " ", maxNoProgress: 2 }, { goal: true, maxNoProgress: 0 }, { sleep: true, permissions: "auto" }, { answers: "auto", extra: true }])
      await expect(controller.setAutonomy({ sessionID: id, revision: rev, payload })).rejects.toThrow()
    view = { ...autonomy, goal: { ...autonomy.goal, maxNoProgress: 0 } }
    await expect(controller.autonomy(id)).rejects.toThrow()
    await expect(controller.setAutonomy({ sessionID: id, revision: rev, payload: { goal: null } })).rejects.toThrow("not confirmed")
    expect(calls).toEqual([{ method: "GET" }, { method: "PUT", payload: { permissions: "auto", answers: "manual" } }, ...[{ guardrails: "manual" }, { answers: "auto" }, { sleep: true }, { goal: "synthetic", maxNoProgress: 2 }, { goal: true }].map((payload) => ({ method: "PUT", payload })), { method: "GET" }, { method: "PUT", payload: { goal: null } }])
  })
})

test("an autonomy update interrupted in flight is unconfirmed and never replayed", async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let writes = 0
  await connected(async (route, request) => {
    if (!route.endsWith("/autonomy") || request.method !== "PUT") return undefined
    writes++; entered.resolve(); await release.promise
    return Response.json({ data: autonomy })
  }, async (controller, rev) => {
    const pending = controller.setAutonomy({ sessionID: id, revision: rev, payload: { answers: "manual" } })
    const outcome = pending.then(() => "resolved", (error: unknown) => error instanceof Error ? error.message : String(error))
    await entered.promise
    await controller.disconnect()
    release.resolve()
    expect(await outcome).toContain("not confirmed")
    expect(writes).toBe(1)
  })
})

test.each([
  ["mode", { mode: "invalid" }], ["decision", { permissions: "invalid" }],
  ["effective", { effective: { ...autonomy.effective, asleep: "no" } }],
  ["inherited", { effective: { ...autonomy.effective, inherited: { permissions: "bad" } } }],
  ["goal status", { goal: { ...autonomy.goal, status: "invalid" } }],
  ["goal counter", { goal: { ...autonomy.goal, iteration: -1 } }],
  ["goal maximum", { goal: { ...autonomy.goal, maxNoProgress: 0 } }],
  ["goal digest", { goal: { ...autonomy.goal, lastProgressDigest: 42 } }],
  ["sleep", { sleep: "asleep" }],
])("autonomy rejects malformed %s", async (_name, changed) => {
  await connected(async (route) => route.endsWith("/autonomy") ? Response.json({ data: { ...autonomy, ...changed } }) : undefined, async (controller) => {
    await expect(controller.autonomy(id)).rejects.toThrow("Autonomy could not be read")
  })
})

test("standalone catalog and dated usage expose validated provider quotas", async () => {
  const urls: URL[] = []
  const location = { directory: "/synthetic/repo", project: { id: "prj_test", directory: "/synthetic/repo" } }
  const quota = { providerID: "p", label: "Provider", status: "available" as const, source: "provider_api" as const, stability: "stable" as const, updatedAt: 1, windows: [{ id: "daily", label: "Daily", unit: "requests" as const, used: 1, limit: 2 }] }
  await connected(async (route, request) => {
    urls.push(new URL(request.url))
    if (route === "/api/model") return Response.json({ location, data: [] })
    if (route === "/api/model/default") return Response.json({ location, data: null })
    if (route === "/api/usage") return Response.json({ data: metrics })
    if (route === "/api/usage/report") return Response.json({ data: { group: "model", rows: [], total: metrics, rowCount: 0 } })
    if (route === "/api/provider/usage") return Response.json({ location, data: [quota] })
    return undefined
  }, async (controller, rev) => {
    for (const input of [undefined, {}, { directory: "" }]) expect(await controller.models(input)).toEqual({ revision: rev, source: {}, models: [], default: null })
    const before = Date.now()
    const usage = await controller.usage({ range: "7d" })
    const after = Date.now()
    expect(usage.range).toBe("7d"); expect(usage.quotas).toEqual([quota])
    const query = urls.find((url) => url.pathname === "/api/usage/report")!.searchParams
    expect(Number(query.get("to"))).toBeGreaterThanOrEqual(before)
    expect(Number(query.get("to"))).toBeLessThanOrEqual(after)
    expect(Number(query.get("to")) - Number(query.get("from"))).toBe(7 * 86_400_000)
    expect(urls.filter((url) => url.pathname.startsWith("/api/model")).every((url) => !url.searchParams.has("location"))).toBe(true)
    await expect(controller.usage({ range: "invalid" })).rejects.toThrow()
    await controller.usage({ range: "today" })
    const today = urls.filter((url) => url.pathname === "/api/usage/report").at(-1)!.searchParams
    const start = new Date(Number(today.get("from")))
    expect([start.getHours(), start.getMinutes(), start.getSeconds(), start.getMilliseconds()]).toEqual([0, 0, 0, 0])
    expect(Number(today.get("from"))).toBeLessThanOrEqual(Number(today.get("to")))
    expect(start.toDateString()).toBe(new Date(Number(today.get("to"))).toDateString())
    await controller.usage({ range: "30d" })
    const month = urls.filter((url) => url.pathname === "/api/usage/report").at(-1)!.searchParams
    expect(Number(month.get("to")) - Number(month.get("from"))).toBe(30 * 86_400_000)
    await controller.usage()
    const all = urls.filter((url) => url.pathname === "/api/usage/report").at(-1)!.searchParams
    expect(all.has("from")).toBe(false); expect(all.has("to")).toBe(false)
  })
})

test("unavailable quota reads are explicit and malformed snapshots are rejected", async () => {
  let invalid = false
  await connected(async (route) => {
    if (route === "/api/usage") return Response.json({ data: metrics })
    if (route === "/api/usage/report") return Response.json({ data: { group: "model", rows: [], total: metrics, rowCount: 0 } })
    if (route === "/api/provider/usage" && invalid) return Response.json({ data: [{ providerID: "p", windows: "wrong" }] })
    return undefined
  }, async (controller) => {
    expect(await controller.usage()).toMatchObject({ range: "all", quotas: [], quotasNotice: "Provider quotas could not be read." })
    invalid = true
    await expect(controller.usage()).rejects.toThrow("Usage could not be read")
  })
})

test("activity pages and attributed shell output use exact scoped requests", async () => {
  const urls: URL[] = []
  let owner = id
  await connected(async (route, request) => {
    urls.push(new URL(request.url))
    if (route === `/api/session/${id}`) return Response.json({ data: { id, scope: "bound", location: { directory: "/synthetic/repo" } } })
    if (route.endsWith("/subagent")) return Response.json({ data: [], summary: { total: 0, active: 0 }, cursor: {} })
    if (route === "/api/shell") return Response.json({ location: { directory: "/synthetic/repo" }, data: [shell("sh_test", { sessionID: owner })] })
    if (route === "/api/shell/sh_test/output") return Response.json({ location: { directory: "/synthetic/repo" }, data: { output: "hello", cursor: 5, size: 5, truncated: false } })
    return undefined
  }, async (controller, rev) => {
    expect((await controller.activity({ sessionID: id, cursor: "next", revision: rev })).revision).toBe(rev)
    expect(urls.find((url) => url.pathname.endsWith("/subagent"))?.searchParams.get("cursor")).toBe("next")
    expect(await controller.shellOutput({ sessionID: id, shellID: "sh_test", cursor: 0, limit: 100 })).toEqual({ revision: rev, sessionID: id, shellID: "sh_test", output: "hello", cursor: 5, size: 5, truncated: false })
    owner = "ses_other"
    await expect(controller.shellOutput({ sessionID: id, shellID: "sh_test" })).rejects.toThrow()
    expect(urls.filter((url) => url.pathname.endsWith("/output"))).toHaveLength(1)
    await expect(controller.activity({ sessionID: id, cursor: "next", revision: rev + 1 })).rejects.toThrow()
    await expect(controller.shellOutput({ sessionID: id, shellID: "sh_test", limit: 65537 })).rejects.toThrow()
  })
})

test("child-owned shell output requires a valid direct child in the selected Session", async () => {
  let owner = "ses_child"
  let child: unknown = task
  const urls: URL[] = []
  await connected(async (route, request) => {
    urls.push(new URL(request.url))
    if (route === `/api/session/${id}`) return Response.json({ data: { id, scope: "bound", location: { directory: "/synthetic/repo" } } })
    if (route.endsWith("/subagent")) return new URL(request.url).searchParams.get("limit") === "10" ? Response.json({ data: [child], summary: { total: 1, active: 1 }, cursor: {} }) : new Response(null, { status: 400 })
    if (route === "/api/shell") return Response.json({ location: { directory: "/synthetic/repo" }, data: [shell("sh_test", { sessionID: owner })] })
    if (route === "/api/shell/sh_test/output") return Response.json({ location: { directory: "/synthetic/repo" }, data: { output: "child", cursor: 5, size: 5, truncated: false } })
    return undefined
  }, async (controller, rev) => {
    expect(await controller.shellOutput({ sessionID: id, shellID: "sh_test" })).toEqual({ revision: rev, sessionID: id, shellID: "sh_test", output: "child", cursor: 5, size: 5, truncated: false })
    expect(urls.find((url) => url.pathname.endsWith("/subagent"))?.searchParams.get("limit")).toBe("10")
    owner = "ses_other"
    await expect(controller.shellOutput({ sessionID: id, shellID: "sh_test" })).rejects.toThrow()
    owner = "ses_child"; child = { ...task, parentID: "ses_other" }
    await expect(controller.shellOutput({ sessionID: id, shellID: "sh_test" })).rejects.toThrow()
    expect(urls.filter((url) => url.pathname.endsWith("/output"))).toHaveLength(1)
  })
})

test.each([
  ["next page", { data: [], next: 51 }, false, "Showing the first 50 captured inputs. Later turns may be omitted from turn filters."],
  ["zero cursor", { data: [], next: 0 }, false, "Showing the first 50 captured inputs. Later turns may be omitted from turn filters."],
  ["unavailable", undefined, false, "Turn-level change history could not be read. Showing Session aggregate changes."],
  ["terminal empty page", { data: [] }, true, undefined],
] as const)("captured history reports completeness for %s", async (_name, page, complete, notice) => {
  await connected(async (route) => {
    if (route.endsWith("/file-change")) return Response.json({ data: [] })
    if (route.endsWith("/captured-inputs")) return page === undefined ? undefined : Response.json(page)
    return undefined
  }, async (controller) => {
    const result = await controller.fileChanges(id)
    expect(result.turnsComplete).toBe(complete)
    expect(result.turnsNotice).toBe(notice)
    expect(result.turns).toEqual(page === undefined ? undefined : [])
  })
})

test("captured turn changes, project pages and directories preserve wire shapes", async () => {
  const urls: URL[] = []
  await connected(async (route, request) => {
    urls.push(new URL(request.url))
    if (route.endsWith("/file-change")) return Response.json({ data: [] })
    if (route.endsWith("/captured-inputs")) return Response.json({ data: [{ id: "msg_turn", type: "user" }, { id: "msg_assistant", type: "assistant", content: [{ type: "tool", name: "edit", state: { status: "completed", structured: { files: [{ file: "a.txt", patch: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n" }] } } }] }] })
    if (route === "/api/coordination") return Response.json({ data: [] })
    if (route === "/api/coordination/settings") return Response.json({ data: { enabled: true, categories: [] } })
    if (route === "/api/project/inventory") return Response.json({ data: [repository], cursor: {} })
    if (route === "/api/project/prj_test/directories") return Response.json([{ directory: "/synthetic/repo", strategy: "git" }])
    return undefined
  }, async (controller, rev) => {
    const changes = await controller.fileChanges(id)
    expect(changes.turns).toEqual([{ id: "msg_turn", type: "user", files: [{ path: "a.txt", patch: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n", additions: 1, deletions: 1 }] }])
    expect((await controller.projects({ cursor: "page", revision: rev })).revision).toBe(rev)
    expect(urls.find((url) => url.pathname === "/api/project/inventory")?.searchParams.get("cursor")).toBe("page")
    expect(await controller.workspaceDirectories({ projectID: "prj_test" })).toEqual({ revision: rev, projectID: "prj_test", directories: [{ directory: "/synthetic/repo", kind: "git" }] })
    await expect(controller.projects({ cursor: "page", revision: rev + 1 })).rejects.toThrow()
  })
})

test("revert actions validate intent and fence stale revisions before dispatch", async () => {
  const writes: string[] = []
  const bodies: unknown[] = []
  await connected(async (route, request) => {
    if (request.method !== "POST") return undefined
    writes.push(route)
    if (route.endsWith("/stage")) { bodies.push(await request.json()); return Response.json({ data: { messageID: "msg_turn" } }) }
    return new Response(null, { status: 204 })
  }, async (controller, rev) => {
    await controller.revert({ action: "stage", sessionID: id, revision: rev, messageID: "msg_turn", files: true })
    await controller.revert({ action: "commit", sessionID: id, revision: rev })
    await controller.revert({ action: "clear", sessionID: id, revision: rev })
    await expect(controller.revert({ action: "commit", sessionID: id, revision: rev + 1 })).rejects.toThrow()
    expect(writes).toEqual([`/api/session/${id}/revert/stage`, `/api/session/${id}/revert/commit`, `/api/session/${id}/revert/clear`])
    expect(bodies).toEqual([{ messageID: "msg_turn", files: true }])
  })
})

const invalidDTOs: [string, string, Record<string, unknown>][] = [
  ["task Session ID", "task", { sessionID: "other" }],
  ["task description", "task", { description: "é".repeat(2049) }],
  ["task model profile", "task", { model: { ...task.model, profile: "" } }],
  ["question ID", "task", { question: { id: "other", text: "q", time: 1 } }],
  ["recovery ID", "task", { stoppedRecovery: { itemID: "other" } }],
  ["shell ID", "shell", { id: "other" }],
  ["shell tool call", "shell", { toolCallID: "" }],
  ["negative shell pid", "shell", { pid: -1 }],
  ["participant Session ID", "participant", { sessionID: "other" }],
  ["participant workspace ID", "participant", { location: { directory: "/synthetic/repo", workspaceID: "wsp_other" } }],
  ["participant driver ID", "participant", { drivenBy: { sessionID: "other", title: "x" } }],
  ["participant owner ID", "participant", { owner: { sessionID: "other", title: "x" } }],
  ["pending count", "participant", { pending: Array.from({ length: 51 }, () => ({ kind: "question", requestID: "r", fingerprint: "f", summary: "s" })) }],
  ["pending request ID", "participant", { pending: [{ kind: "question", requestID: "", fingerprint: "f", summary: "s" }] }],
  ["pending fingerprint", "participant", { pending: [{ kind: "question", requestID: "r", fingerprint: "x".repeat(257), summary: "s" }] }],
  ["pending summary", "participant", { pending: [{ kind: "question", requestID: "r", fingerprint: "f", summary: "é".repeat(501) }] }],
  ["category count", "settings", { categories: ["question", "permission", "review", "question"] }],
  ["actions count", "settings", { actions: Array(33).fill("x") }],
  ["resources count", "settings", { resources: Array(33).fill("x") }],
  ["empty action", "settings", { actions: [""] }],
  ["resource length limit", "settings", { resources: ["é".repeat(513)] }],
  ["group ID", "group", { id: "other" }],
  ["empty group suffix", "group", { id: "cgrp_" }],
  ["group ID limit", "group", { id: "cgrp_" + "x".repeat(92) }],
  ["model profile", "row", { model: { id: "m", providerID: "p", profile: "" } }],
  ["dimension profile", "row", { dimensions: { group: "profile", providerID: "p", profileState: "recorded", profile: "" } }],
  ["dimension session", "row", { dimensions: { group: "task", attribution: "complete", sessionID: "other" } }],
  ["anchor session", "row", { dimensions: { group: "prompt", attribution: "complete", anchor: { sessionID: "other", inputID: "msg_ok" } } }],
  ["anchor message", "row", { dimensions: { group: "prompt", attribution: "complete", anchor: { sessionID: id, inputID: "other" } } }],
  ...["firstOutputP50Ms", "firstOutputP95Ms", "firstOutputP99Ms", "totalP50Ms", "totalP95Ms", "totalP99Ms"].map((key): [string, string, Record<string, unknown>] => [key, "row", { speed: { generationSamples: 0, providerTimedSamples: 0, observedSamples: 0, samples: 0, [key]: 0.5 } }]),
]
test.each(invalidDTOs)("retained DTO rejects malformed %s", async (_name, target, changed) => {
  const groupID = target === "group" ? String(changed.id) : group.id
  await connected(async (route) => {
    if (route === `/api/session/${id}`) return Response.json({ data: { id, scope: "bound", location: { directory: "/synthetic/repo" } } })
    if (route.endsWith("/subagent")) return Response.json({ data: [{ ...task, ...(target === "task" ? changed : {}) }], summary: { total: 1, active: 1 }, cursor: {} })
    if (route === "/api/shell") return Response.json({ location: { directory: "/synthetic/repo" }, data: [{ ...shell("sh_ok", { sessionID: id }), ...(target === "shell" ? changed : {}) }] })
    if (route === "/api/coordination") return Response.json({ data: [{ id: groupID }] })
    if (route === "/api/coordination/settings") return Response.json({ data: { enabled: true, categories: [], ...(target === "settings" ? changed : {}) } })
    if (route === `/api/coordination/${groupID}`) return Response.json({ data: { ...group, ...(target === "group" ? changed : {}), master: { ...participant, ...(target === "participant" ? changed : {}) } } })
    if (route === "/api/project/inventory") return Response.json({ data: [repository], cursor: {} })
    if (route === "/api/usage") return Response.json({ data: metrics })
    if (route === "/api/usage/report") return Response.json({ data: { group: "model", rows: [{ ...metrics, key: "key", label: "label", ...(target === "row" ? changed : {}) }], total: metrics, rowCount: 1 } })
    return undefined
  }, async (controller) => {
    const call = target === "task" || target === "shell" ? controller.activity(id) : target === "row" ? controller.usage() : controller.projects()
    await expect(call).rejects.toThrow()
  })
})

const compatibleDTOs: [string, string, Record<string, unknown>][] = [
  ["long profile", "task", { model: { ...task.model, profile: "é".repeat(300) } }],
  ["empty model ID", "task", { model: { ...task.model, id: "" } }],
  ["Session prefix and length", "task", { sessionID: "sesValid" + "x".repeat(300) }],
  ["long question ID", "task", { question: { id: "qst_" + "x".repeat(300), text: "q", time: 1 } }],
  ["long recovery ID", "task", { stoppedRecovery: { itemID: "rvw_" + "x".repeat(300) } }],
  ["long shell ID and tool call", "shell", { id: "sh_" + "x".repeat(300), toolCallID: "é".repeat(300), pid: 0 }],
  ["prefix-only shell ID", "shell", { id: "sh_" }],
  ["workspace prefix", "participant", { location: { directory: "/synthetic/repo", workspaceID: "wrkValid" } }],
  ["participant Session prefix", "participant", { sessionID: "sesValid", drivenBy: { sessionID: "sesValid", title: "d" }, owner: { sessionID: "sesValid", title: "o" } }],
  ["empty pending summary", "participant", { pending: [{ kind: "question", requestID: "r", fingerprint: "f", summary: "" }] }],
  ["Unicode pending fields", "participant", { pending: [{ kind: "question", requestID: "é".repeat(256), fingerprint: "é".repeat(256), summary: "é".repeat(500) }] }],
  ["duplicate categories", "settings", { categories: ["question", "question"] }],
  ["Unicode scopes", "settings", { actions: ["é".repeat(512)], resources: ["é".repeat(512)] }],
  ["Unicode group ID", "group", { id: "cgrp_" + "é".repeat(91) }],
  ["long recorded profile", "row", { dimensions: { group: "profile", providerID: "p", profileState: "recorded", profile: "p".repeat(300) }, model: { id: "m", providerID: "p", profile: "p".repeat(300) } }],
  ["slash model ID", "row", { model: { id: "/", providerID: "p" } }],
  ["empty dimension model ID", "row", { dimensions: { group: "provider-model", providerID: "p", modelID: "" } }],
  ["dimension Session prefix", "row", { dimensions: { group: "task", attribution: "complete", sessionID: "sesValid" } }],
  ["long anchor IDs", "row", { dimensions: { group: "prompt", attribution: "complete", anchor: { sessionID: "sesValid", inputID: "msg_" + "x".repeat(300) } } }],
  ["negative token amount", "row", { tokens: { input: -0.5, output: -1, reasoning: -0.25, cache: { read: -0.5, write: -0.75 } } }],
]
test.each(compatibleDTOs)("retained DTO accepts %s", async (_name, target, changed) => {
  const groupID = target === "group" ? String(changed.id) : group.id
  await connected(async (route) => {
    if (route === `/api/session/${id}`) return Response.json({ data: { id, scope: "bound", location: { directory: "/synthetic/repo" } } })
    if (route.endsWith("/subagent")) return Response.json({ data: [{ ...task, ...(target === "task" ? changed : {}) }], summary: { total: 1, active: 1 }, cursor: {} })
    if (route === "/api/shell") return Response.json({ location: { directory: "/synthetic/repo" }, data: [{ ...shell("sh_ok", { sessionID: id }), ...(target === "shell" ? changed : {}) }] })
    if (route === "/api/coordination") return Response.json({ data: [{ id: groupID }] })
    if (route === "/api/coordination/settings") return Response.json({ data: { enabled: true, categories: [], ...(target === "settings" ? changed : {}) } })
    if (route === `/api/coordination/${encodeURIComponent(groupID)}`) return Response.json({ data: { ...group, ...(target === "group" ? changed : {}), master: { ...participant, ...(target === "participant" ? changed : {}) } } })
    if (route === "/api/project/inventory") return Response.json({ data: [repository], cursor: {} })
    if (route === "/api/usage") return Response.json({ data: metrics })
    if (route === "/api/usage/report") return Response.json({ data: { group: "model", rows: [{ ...metrics, key: "key", label: "label", ...(target === "row" ? changed : {}) }], total: metrics, rowCount: 1 } })
    return undefined
  }, async (controller) => {
    if (target === "task") expect((await controller.activity(id)).subagents[0]).toMatchObject(changed)
    else if (target === "shell") expect((await controller.activity(id)).shells[0]).toMatchObject(changed)
    else if (target === "row") expect((await controller.usage()).report.rows[0]).toMatchObject(changed)
    else {
      const projects = await controller.projects()
      expect(target === "settings" ? projects.settings : target === "participant" ? projects.groups[0]?.master : projects.groups[0]).toMatchObject(changed)
    }
  })
})

test("retained DTO accepts bounded canonical identifiers and fractional finite values", async () => {
  const acceptedShell = { ...shell("sh_ok", { sessionID: id }), toolCallID: "t".repeat(256), exit: -1.5, time: { started: -0.5, completed: 1.5 } }
  const acceptedTask = { ...task, description: "é".repeat(2048), model: { ...task.model, profile: "p".repeat(256) }, question: { id: "qst_ok", text: "q", time: 1 }, stoppedRecovery: { itemID: "rvw_ok" } }
  const pending = Array.from({ length: 50 }, () => ({ kind: "question", requestID: "r".repeat(256), fingerprint: "f".repeat(256), summary: "s".repeat(500) }))
  const acceptedSettings = { enabled: true, categories: ["question", "permission", "review"], actions: Array(32).fill("a".repeat(512)), resources: Array(32).fill("b") }
  const acceptedParticipant = { ...participant, pending, location: { directory: "/synthetic/repo", workspaceID: "wrk_valid" }, drivenBy: { sessionID: id, title: "driver" }, owner: { sessionID: id, title: "owner" } }
  const fractional = { ...metrics, tokens: { input: 0.5, output: 1.5, reasoning: 0.5, cache: { read: 0.25, write: 0.75 } } }
  const speed = { generationSamples: 1, providerTimedSamples: 1, observedSamples: 1, samples: 1, firstOutputP50Ms: 1, totalP99Ms: 2, meanTokensPerSecond: 0.5 }
  await connected(async (route) => {
    if (route === `/api/session/${id}`) return Response.json({ data: { id, scope: "bound", location: { directory: "/synthetic/repo" } } })
    if (route.endsWith("/subagent")) return Response.json({ data: [acceptedTask], summary: { total: 1, active: 1 }, cursor: {} })
    if (route === "/api/shell") return Response.json({ location: { directory: "/synthetic/repo" }, data: [acceptedShell] })
    if (route === "/api/coordination") return Response.json({ data: [{ id: group.id }] })
    if (route === "/api/coordination/settings") return Response.json({ data: acceptedSettings })
    if (route === `/api/coordination/${group.id}`) return Response.json({ data: { ...group, master: acceptedParticipant } })
    if (route === "/api/project/inventory") return Response.json({ data: [repository], cursor: {} })
    if (route === "/api/usage") return Response.json({ data: fractional })
    if (route === "/api/usage/report") return Response.json({ data: { group: "model", rows: [{ ...fractional, key: "key", label: "label", speed }], total: fractional, rowCount: 1, speed } })
    return undefined
  }, async (controller) => {
    const [activity, projects, usage] = await Promise.all([controller.activity(id), controller.projects(), controller.usage()])
    expect(activity.subagents[0] as unknown).toEqual(acceptedTask)
    expect(activity.shells[0] as unknown).toEqual({ ...acceptedShell, ownerSessionID: id })
    expect(projects.groups[0]?.master as unknown).toEqual(acceptedParticipant)
    expect(projects.settings as unknown).toEqual(acceptedSettings)
    expect(usage.summary.tokens).toEqual(fractional.tokens)
    expect(usage.report.speed).toEqual(speed)
  })
})

test("surface adapters reject malformed retained fields and cursor envelopes", async () => {
  let invalid: unknown
  let target = ""
  await connected(async (route) => {
    if (route === `/api/session/${id}`) return Response.json({ data: { id, scope: "bound", location: { directory: "/synthetic/repo" } } })
    if (route.endsWith("/subagent")) return Response.json({ data: [target === "task" ? { ...task, state: invalid } : task], summary: { total: 1, active: 1 }, cursor: target === "activityCursor" ? invalid : {} })
    if (route === "/api/shell") return Response.json({ location: { directory: "/synthetic/repo" }, data: [target === "shell" ? { ...shell("sh_test", { sessionID: id }), status: invalid } : shell("sh_test", { sessionID: id })] })
    if (route === "/api/coordination") return Response.json({ data: [{ id: group.id }] })
    if (route === "/api/coordination/settings") return Response.json({ data: { enabled: true, categories: target === "categories" ? [invalid] : [] } })
    if (route === "/api/coordination/cgrp_synthetic") return Response.json({ data: { ...group, master: { ...participant, ...(target === "state" ? { state: invalid } : {}), ...(target === "pending" ? { pending: invalid } : {}) }, settings: { concurrency: target === "concurrency" ? invalid : null } } })
    if (route === "/api/project/inventory") return Response.json({ data: [target === "projectName" ? { ...repository, projectName: invalid } : repository], cursor: target === "projectCursor" ? invalid : {} })
    if (route === "/api/usage") return Response.json({ data: { ...metrics, ...(target === "cost" ? { cost: invalid } : {}), ...(target === "models" ? { models: invalid } : {}) } })
    if (route === "/api/usage/report") return Response.json({ data: { group: "model", rows: target === "rowModel" ? [{ ...metrics, key: "key", label: "label", model: invalid }] : [], total: metrics, rowCount: 0 } })
    return undefined
  }, async (controller) => {
    const cases: [string, unknown, () => Promise<unknown>][] = [
      ["task", ["running"], () => controller.activity(id)], ["shell", ["running"], () => controller.activity(id)],
      ["state", "invalid", () => controller.projects()], ["pending", [null], () => controller.projects()],
      ["categories", "invalid", () => controller.projects()], ["concurrency", 0, () => controller.projects()],
      ["projectName", {}, () => controller.projects()], ["cost", "invalid", () => controller.usage()],
      ["models", [null], () => controller.usage()], ["rowModel", {}, () => controller.usage()],
    ]
    for (const cursor of [false, null, { next: "" }, { next: "x".repeat(4097) }, { next: 1 }]) {
      cases.push(["activityCursor", cursor, () => controller.activity(id)], ["projectCursor", cursor, () => controller.projects()])
    }
    for (const [name, value, call] of cases) {
      target = name; invalid = value
      expect(await call().then(() => "accepted", () => "rejected")).toBe("rejected")
    }
    invalid = { next: null }
    target = "activityCursor"
    expect(await controller.activity(id)).not.toHaveProperty("subagentNext")
    target = "projectCursor"
    expect(await controller.projects()).not.toHaveProperty("repositoriesNext")
  })
}, 30_000)

test.each([
  ["generatedTokens", { latestTiming: { generatedTokens: 0 } }],
  ["estimatedTokens", { latestTiming: { estimatedTokens: 0 } }],
  ["observedGenerationDurationNs", { latestTiming: { observedGenerationDurationNs: 0 } }],
  ["estimatedGenerationDurationNs", { latestTiming: { estimatedGenerationDurationNs: 0 } }],
  ["latestNamespace", { latestNamespace: "a" }],
])("usage rejects malformed %s", async (_name, invalid) => {
  await connected(async (route) => route === "/api/usage" ? Response.json({ data: { ...metrics, ...invalid } }) : Response.json({ data: { group: "model", rows: [], total: metrics, rowCount: 0 } }), async (controller) => {
    await expect(controller.usage()).rejects.toThrow("Usage could not be read")
  })
})

test.each([
  ["question data", { question: { id: "qst_synthetic", text: "Question", time: 1, data: "x".repeat(8193) } }],
  ["question text", { question: { id: "qst_synthetic", text: "é".repeat(4097), time: 1 } }],
  ["progress text", { progress: { text: "é".repeat(2049), time: 1 } }],
])("activity rejects oversized %s", async (_name, invalid) => {
  await connected(async (route) => route.endsWith("/subagent") ? Response.json({ data: [{ ...task, ...invalid }], summary: { total: 1, active: 1 }, cursor: {} }) : Response.json({ data: { id, scope: "standalone", location: { directory: "" } } }), async (controller) => {
    await expect(controller.activity(id)).rejects.toThrow("Session activity could not be read")
  })
})

test.each([
  ["cost provenance", { cost: 1, costProvenance: "invalid" }],
])("usage rejects malformed row %s", async (_name, invalid) => {
  await connected(async (route) => route === "/api/usage" ? Response.json({ data: metrics }) : Response.json({ data: { group: "model", rows: [{ ...metrics, key: "key", label: "label", ...invalid }], total: metrics, rowCount: 1 } }), async (controller) => {
    await expect(controller.usage()).rejects.toThrow("Usage could not be read")
  })
})

test("usage strips foreign dimension fields instead of rejecting valid variants", async () => {
  await connected(async (route) => route === "/api/provider/usage" ? undefined : route === "/api/usage" ? Response.json({ data: metrics }) : Response.json({ data: { group: "model", rows: [{ ...metrics, key: "key", label: "label", dimensions: { group: "provider", providerID: "p", profile: {} } }], total: metrics, rowCount: 1 } }), async (controller) => {
    expect((await controller.usage()).report.rows[0]?.dimensions).toEqual({ group: "provider", providerID: "p" })
  })
})

test("valid retained fields accept their boundaries and every dimensions variant", async () => {
  const variants = [
    { group: "provider", providerID: "p" }, { group: "provider-model", providerID: "p", modelID: "m" },
    { group: "provider-profile-model", providerID: "p", modelID: "m", profile: "prof", profileState: "recorded" },
    { group: "model-id", modelID: "m" }, { group: "profile", providerID: "p", profileState: "provider-default" },
    { group: "prompt", attribution: "complete", anchor: { sessionID: id, inputID: "msg_synthetic" } },
    { group: "task", attribution: "complete", sessionID: id },
  ] as const
  const question = { id: "qst_synthetic", text: "é".repeat(4096), time: 1, data: "x".repeat(8190) }
  const progress = { text: "é".repeat(2048), time: 1 }
  const latestTiming = { generatedTokens: 1, estimatedTokens: 1, observedGenerationDurationNs: 1, estimatedGenerationDurationNs: 1 }
  await connected(async (route) => {
    if (route === "/api/provider/usage") return undefined
    if (route.endsWith("/subagent")) return Response.json({ data: [{ ...task, question, progress }], summary: { total: 1, active: 1 }, cursor: {} })
    if (route === `/api/session/${id}`) return Response.json({ data: { id, scope: "standalone", location: { directory: "" } } })
    if (route === "/api/usage") return Response.json({ data: { ...metrics, latestTiming, latestNamespace: "12345678" } })
    return Response.json({ data: { group: "model", rows: variants.map((dimensions) => ({ ...metrics, key: "key", label: "label", dimensions })), total: metrics, rowCount: variants.length } })
  }, async (controller) => {
    const [activity, usage] = await Promise.all([controller.activity(id), controller.usage()])
    expect(activity.subagents[0]?.question).toEqual(question)
    expect(activity.subagents[0]?.progress).toEqual(progress)
    expect(usage.summary.latestTiming).toEqual(latestTiming)
    expect(usage.report.rows.map((row) => row.dimensions)).toEqual([...variants])
  })
})

test("repository creation reports an unconfirmed lost response without replay", async () => {
  const bodies: unknown[] = []
  await connected(async (route, request) => {
    if (route === "/api/project/inventory") return Response.json({ data: [repository], cursor: {} })
    if (route === "/api/session" && request.method === "POST") {
      bodies.push(await request.json())
      return new Response("{", { headers: { "content-type": "application/json", "content-length": "100", connection: "close" } })
    }
    return undefined
  }, async (controller) => {
    await expect(controller.createSession({ sessionID: id, directory: "/synthetic/repo" })).rejects.toThrow("The chat creation was not confirmed. Check Sessions before retrying.")
    expect(bodies).toEqual([{ id, location: { directory: "/synthetic/repo" } }])
  })
})

test("surface adapters project known fields and preserve opaque metadata", async () => {
  const extra = { unwanted: "synthetic-extra" }
  await connected(async (route) => {
    if (route.endsWith("/file-change")) return Response.json({ data: [{ path: "file", patch: "", additions: 1, deletions: 0, ...extra }] })
    if (route === `/api/session/${id}`) return Response.json({ data: { id, scope: "bound", location: { directory: "/synthetic/repo" } } })
    if (route.endsWith("/subagent")) return Response.json({ data: [{ ...task, ...extra, model: { ...task.model, ...extra }, time: { ...task.time, ...extra } }], summary: { total: 1, active: 1 }, cursor: {} })
    if (route === "/api/shell") return Response.json({ location: { directory: "/synthetic/repo" }, data: [{ ...shell("sh_test", { sessionID: id, opaque: "preserved" }), ...extra }] })
    if (route === "/api/coordination") return Response.json({ data: [{ id: group.id }] })
    if (route === "/api/coordination/settings") return Response.json({ data: { enabled: true, categories: [], ...extra } })
    if (route === "/api/coordination/cgrp_synthetic") return Response.json({ data: { ...group, ...extra, master: { ...participant, ...extra, location: { ...participant.location, ...extra } }, settings: { concurrency: null, ...extra } } })
    if (route === "/api/project/inventory") return Response.json({ data: [{ ...repository, ...extra }], cursor: {} })
    if (route === "/api/usage") return Response.json({ data: { ...metrics, latestInvalidation: "system-prefix-changed", ...extra, tokens: { ...metrics.tokens, ...extra, cache: { ...metrics.tokens.cache, ...extra } } } })
    if (route === "/api/usage/report") return Response.json({ data: { group: "model", rows: [{ ...metrics, key: "key", label: "label", ...extra, model: { id: "m", providerID: "p", ...extra } }], total: { ...metrics, ...extra }, rowCount: 1, ...extra } })
    return undefined
  }, async (controller) => {
    const result = await Promise.all([controller.fileChanges(id), controller.activity(id), controller.projects(), controller.usage()])
    expect(JSON.stringify(result)).not.toContain("synthetic-extra")
    expect(result[1].shells[0]?.metadata.opaque).toBe("preserved")
    expect(result[3].summary.latestInvalidation).toBe("system-prefix-changed")
  })
})

async function connected(handle: (route: string, request: Request) => Promise<Response | undefined>, run: (controller: BackendController, revision: number) => Promise<void>) {
  const resources = await syntheticBundle()
  using server = peer([], () => 101, handle)
  const controller = new BackendController(resources, { env, launch })
  try { await run(controller, revision(await controller.connect({ mode: "shared", server: server.url.href }))) }
  finally { await controller.disconnect(); await fs.rm(resources, { recursive: true, force: true }) }
}

test("surface reads use session and project endpoints with their current revision", async () => {
  let standalone = false
  const urls: URL[] = []
  await connected(async (route, request) => {
    urls.push(new URL(request.url))
    if (route === `/api/session/${id}/file-change`) return Response.json({ data: [{ path: "a.txt", patch: "diff", additions: 1, deletions: 0 }] })
    if (route === `/api/session/${id}`) return Response.json({ data: { id, scope: standalone ? "standalone" : "bound", location: { directory: "/synthetic/repo" } } })
    if (route === `/api/session/${id}/subagent`) return Response.json({ data: [task], summary: { total: 12, active: 1, running: 1, waiting: 0 }, cursor: { next: "next-child" } })
    if (route === "/api/shell") return Response.json({ location: { directory: "/synthetic/repo" }, data: [
      shell("sh_parent", { sessionID: id }), shell("sh_child", { sessionID: "ses_child" }),
      shell("sh_other", { sessionID: "ses_other" }), shell("sh_unknown", {}),
    ] })
    if (route === "/api/coordination") return Response.json({ data: [{ id: "cgrp_synthetic" }] })
    if (route === "/api/coordination/settings") return Response.json({ data: { enabled: true, categories: [] } })
    if (route === "/api/coordination/cgrp_synthetic") return Response.json({ data: group })
    if (route === "/api/project/inventory") return Response.json({ data: [repository], cursor: { next: "next-project" } })
    if (route === "/api/usage") return Response.json({ data: metrics })
    if (route === "/api/usage/report") return Response.json({ data: { group: "model", rows: [], total: metrics, rowCount: 1, nextOffset: 25 } })
    return undefined
  }, async (controller, rev) => {
    expect(await controller.fileChanges(id)).toEqual({ revision: rev, sessionID: id, items: [{ path: "a.txt", patch: "diff", additions: 1, deletions: 0 }], turnsComplete: false, turnsNotice: "Turn-level change history could not be read. Showing Session aggregate changes." })
    expect(await controller.activity(id) as unknown).toEqual({ revision: rev, sessionID: id, subagents: [task], subagentNext: "next-child", total: 12, activeTotal: 1, shells: [{ ...shell("sh_parent", { sessionID: id }), ownerSessionID: id }, { ...shell("sh_child", { sessionID: "ses_child" }), ownerSessionID: "ses_child" }], unattributedShellCount: 1 })
    standalone = true
    expect(await controller.activity(id) as unknown).toEqual({ revision: rev, sessionID: id, subagents: [task], subagentNext: "next-child", total: 12, activeTotal: 1, shells: [], unattributedShellCount: 0 })
    expect(urls.filter((url) => url.pathname === "/api/shell")).toHaveLength(1)
    expect(await controller.projects() as unknown).toEqual({ revision: rev, settings: { enabled: true, categories: [] }, groups: [group], repositories: [repository], repositoriesNext: "next-project" })
    expect(await controller.usage() as unknown).toEqual({ revision: rev, range: "all", quotas: [], quotasNotice: "Provider quotas could not be read.", summary: metrics, report: { group: "model", rows: [], total: metrics, rowCount: 1, nextOffset: 25 }, hasMoreModels: true })
    expect(urls.find((url) => url.pathname.endsWith("/subagent"))?.searchParams.get("limit")).toBe("10")
    expect(urls.find((url) => url.pathname === "/api/project/inventory")?.searchParams.get("limit")).toBe("50")
    const report = urls.find((url) => url.pathname === "/api/usage/report")
    expect(Object.fromEntries(report?.searchParams ?? [])).toEqual({ group: "model", limit: "25", sort: "cost", order: "desc" })
    await expect(controller.fileChanges("invalid")).rejects.toThrow()
    await expect(controller.activity("invalid")).rejects.toThrow()
  })
}, 30_000)

test("surface reads reject when the connection changes while a request is pending", async () => {
  for (const operation of ["fileChanges", "activity", "projects", "usage"] as const) {
    const arrived = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    await connected(async () => { arrived.resolve(); await release.promise; return Response.json({ data: [] }) }, async (controller) => {
      const pending = operation === "fileChanges" || operation === "activity" ? controller[operation](id) : controller[operation]()
      const settled = pending.then(() => undefined, (error: unknown) => error)
      await arrived.promise
      const disconnect = controller.disconnect()
      release.resolve()
      await disconnect
      expect(await settled).toBeInstanceOf(Error)
    })
  }
}, 30_000)

test("malformed backend payloads are rejected rather than forwarded", async () => {
  await connected(async () => Response.json({ data: null }), async (controller) => {
    await expect(controller.fileChanges(id)).rejects.toThrow("Captured file changes could not be read")
    await expect(controller.activity(id)).rejects.toThrow("Session activity could not be read")
    await expect(controller.projects()).rejects.toThrow("Projects could not be read")
    await expect(controller.usage()).rejects.toThrow("Usage could not be read")
  })
}, 30_000)

test("activity refuses unrelated child and repository results", async () => {
  let unrelatedChild = true
  await connected(async (route) => {
    if (route === `/api/session/${id}`) return Response.json({ data: { id, scope: "bound", location: { directory: "/synthetic/repo" } } })
    if (route.endsWith("/subagent")) return Response.json({ data: unrelatedChild ? [{ sessionID: "ses_child", parentID: "ses_other" }] : [], summary: { total: 0, active: 0 }, cursor: {} })
    if (route === "/api/shell") return Response.json({ location: { directory: "/synthetic/other" }, data: [] })
    return undefined
  }, async (controller) => {
    await expect(controller.activity(id)).rejects.toThrow("Session activity could not be read")
    unrelatedChild = false
    await expect(controller.activity(id)).rejects.toThrow("Session activity could not be read")
  })
}, 30_000)

test("usage reports a complete model page when no next offset exists", async () => {
  await connected(async (route) => route === "/api/provider/usage" ? undefined : route === "/api/usage" ? Response.json({ data: metrics }) : Response.json({ data: { group: "model", rows: [], total: metrics, rowCount: 0 } }), async (controller) => {
    expect((await controller.usage()).hasMoreModels).toBe(false)
  })
}, 30_000)

test("all four reads reject results from a previous stream revision", async () => {
  const resources = await syntheticBundle()
  const streamEnd = Promise.withResolvers<void>()
  const ready = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const reconnected = Promise.withResolvers<void>()
  let requests = 0
  let initialRevision = 0
  using server = peer([], () => 101, async (route) => {
    if (++requests === 8) ready.resolve()
    await release.promise
    if (route.endsWith("/file-change")) return Response.json({ data: [] })
    if (route === `/api/session/${id}`) return Response.json({ data: { id, scope: "standalone", location: { directory: "" } } })
    if (route.endsWith("/subagent")) return Response.json({ data: [], summary: { total: 0, active: 0 }, cursor: {} })
    if (route === "/api/coordination") return Response.json({ data: [] })
    if (route === "/api/coordination/settings") return Response.json({ data: { enabled: true, categories: [] } })
    if (route === "/api/project/inventory") return Response.json({ data: [], cursor: {} })
    if (route === "/api/usage") return Response.json({ data: metrics })
    if (route === "/api/usage/report") return Response.json({ data: { group: "model", rows: [], total: metrics, rowCount: 0 } })
    return undefined
  }, streamEnd.promise)
  const controller = new BackendController(resources, { env, launch, onState: (state) => {
    if (initialRevision && state.status === "connected" && state.revision !== initialRevision) reconnected.resolve()
  } })
  try {
    initialRevision = revision(await controller.connect({ mode: "shared", server: server.url.href }))
    const pending = [controller.fileChanges(id), controller.activity(id), controller.projects(), controller.usage()]
      .map((item) => item.then(() => "resolved", (error: unknown) => error instanceof Error ? error.message : String(error)))
    await ready.promise
    streamEnd.resolve()
    await reconnected.promise
    release.resolve()
    for (const message of await Promise.all(pending)) expect(message).toContain("backend connection changed")
  } finally {
    release.resolve()
    await controller.disconnect()
    await fs.rm(resources, { recursive: true, force: true })
  }
}, 30_000)

test("reads and mutations cannot settle while the event stream is reconnecting", async () => {
  const resources = await syntheticBundle()
  const streamEnd = Promise.withResolvers<void>()
  const ready = Promise.withResolvers<void>()
  const reconnecting = Promise.withResolvers<void>()
  const reconnectRequested = Promise.withResolvers<void>()
  const reconnectRelease = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let requests = 0
  let streams = 0
  using server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const route = new URL(request.url).pathname
    if (route === "/api/health") return Response.json({ healthy: true, version: "synthetic-shared", pid: 101, sourceEpoch: "epoch-101" })
    if (route === "/api/event") {
      const first = ++streams === 1
      if (!first) reconnectRequested.resolve()
      return new Response(new ReadableStream<Uint8Array>({ async start(stream) {
        if (!first) await reconnectRelease.promise
        stream.enqueue(new TextEncoder().encode('data: {"type":"server.connected","properties":{}}\n\n'))
        if (first) { await streamEnd.promise; stream.close() }
      } }), { headers: { "content-type": "text/event-stream" } })
    }
    if (++requests === 9) ready.resolve()
    await release.promise
    if (request.method === "POST") return new Response(null, { status: 204 })
    if (route.endsWith("/file-change")) return Response.json({ data: [] })
    if (route === `/api/session/${id}`) return Response.json({ data: { id, scope: "standalone", location: { directory: "" } } })
    if (route.endsWith("/subagent")) return Response.json({ data: [], summary: { total: 0, active: 0 }, cursor: {} })
    if (route === "/api/coordination") return Response.json({ data: [] })
    if (route === "/api/coordination/settings") return Response.json({ data: { enabled: true, categories: [] } })
    if (route === "/api/project/inventory") return Response.json({ data: [], cursor: {} })
    if (route === "/api/usage") return Response.json({ data: metrics })
    if (route === "/api/usage/report") return Response.json({ data: { group: "model", rows: [], total: metrics, rowCount: 0 } })
    return new Response(null, { status: 404 })
  } })
  const controller = new BackendController(resources, { env, launch, onState: (state) => { if (state.status === "reconnecting") reconnecting.resolve() } })
  try {
    const rev = revision(await controller.connect({ mode: "shared", server: server.url.href }))
    const pending = [controller.fileChanges(id), controller.activity(id), controller.projects(), controller.usage(), controller.pin({ sessionID: id, revision: rev, pinned: true })]
      .map((item) => item.then(() => "accepted", () => "rejected"))
    await ready.promise
    streamEnd.resolve()
    await reconnecting.promise
    await reconnectRequested.promise
    release.resolve()
    expect(await Promise.all(pending)).toEqual(["rejected", "rejected", "rejected", "rejected", "rejected"])
    expect(controller.state().status).toBe("reconnecting")
  } finally { release.resolve(); reconnectRelease.resolve(); await controller.disconnect(); await fs.rm(resources, { recursive: true, force: true }) }
}, 30_000)

test("expired preflights never dispatch create or model-switch mutations", async () => {
  for (const mode of ["create", "switch"] as const) {
    const resources = await syntheticBundle()
    const streamEnd = Promise.withResolvers<void>()
    const held = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const reconnected = Promise.withResolvers<void>()
    let original = 0
    let active = 0
    const mutations: string[] = []
    const location = { directory: "/synthetic/repo", project: { id: "prj_test", directory: "/synthetic/repo" } }
    using server = peer([], () => 101, async (route, request) => {
      if (request.method === "POST") { mutations.push(route); return new Response(null, { status: 204 }) }
      if (route === "/api/project/inventory") { if (mode === "create") { held.resolve(); await release.promise }; return Response.json({ data: [repository], cursor: {} }) }
      if (route === `/api/session/${id}`) return Response.json({ data: { id, location: { directory: "/synthetic/repo" }, model: { id: "model", providerID: "provider" } } })
      if (route === "/api/session/active") { if (++active === 2) { held.resolve(); await release.promise }; return Response.json({ data: {} }) }
      if (route === "/api/model") return Response.json({ location, data: [{ id: "model", providerID: "provider", name: "Model", status: "active", enabled: true, variants: [], profiles: [], limit: { context: 100, output: 10 } }] })
      if (route === "/api/model/default") return Response.json({ location, data: { selection: { id: "model", providerID: "provider" } } })
      return undefined
    }, streamEnd.promise)
    const controller = new BackendController(resources, { env, launch, onState: (state) => { if (original && state.status === "connected" && state.revision !== original) reconnected.resolve() } })
    try {
      original = revision(await controller.connect({ mode: "shared", server: server.url.href }))
      const pending = mode === "create" ? controller.createSession({ sessionID: id, directory: "/synthetic/repo" }) : controller.switchModel({ sessionID: id, revision: original, model: { id: "model", providerID: "provider" } })
      const result = pending.then(() => "accepted", (error: unknown) => error instanceof Error ? error.message : String(error))
      await held.promise; streamEnd.resolve(); await reconnected.promise; release.resolve()
      expect(await result).toContain("connection changed")
      expect(mutations).toEqual([])
    } finally { release.resolve(); await controller.disconnect(); await fs.rm(resources, { recursive: true, force: true }) }
  }
}, 30_000)

test("late create and prompt acknowledgements report uncertainty with stable client IDs", async () => {
  for (const mode of ["default", "repository", "prompt"] as const) {
    const resources = await syntheticBundle()
    const streamEnd = Promise.withResolvers<void>()
    const held = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const reconnected = Promise.withResolvers<void>()
    const bodies: unknown[] = []
    let original = 0
    using server = peer([], () => 101, async (route, request) => {
      if (route === "/api/project/inventory") return Response.json({ data: [repository], cursor: {} })
      if (request.method === "POST") {
        bodies.push(await request.json()); held.resolve(); await release.promise
        return Response.json({ data: mode === "prompt" ? { id: "msg_synthetic", sessionID: id } : { id, scope: "bound", location: { directory: "/synthetic/repo" } } })
      }
      return undefined
    }, streamEnd.promise)
    const controller = new BackendController(resources, { env, launch, onState: (state) => { if (original && state.status === "connected" && state.revision !== original) reconnected.resolve() } })
    try {
      original = revision(await controller.connect({ mode: "shared", server: server.url.href }))
      const pending = mode === "prompt" ? controller.prompt({ sessionID: id, promptID: "msg_synthetic", text: "hello" }) : controller.createSession({ sessionID: id, ...(mode === "repository" ? { directory: "/synthetic/repo" } : {}) })
      const result = pending.then(() => "accepted", (error: unknown) => error instanceof Error ? error.message : String(error))
      await held.promise; streamEnd.resolve(); await reconnected.promise; release.resolve()
      expect(await result).toBe(mode === "prompt" ? "The message was not confirmed before the connection changed. Retry sends the same message once; check the Session first." : "The chat creation was not confirmed before the connection changed. Check Sessions before retrying.")
      expect(bodies).toEqual([mode === "prompt" ? { id: "msg_synthetic", text: "hello" } : mode === "repository" ? { id, location: { directory: "/synthetic/repo" } } : { id }])
    } finally { release.resolve(); await controller.disconnect(); await fs.rm(resources, { recursive: true, force: true }) }
  }
}, 30_000)

test("composer catalog aggregates commands, skills and agents and keeps partial failures per section", async () => {
  let skillBroken = false
  const locations: (string | null)[] = []
  await connected(async (route, request) => {
    if (route === `/api/session/${id}`) return Response.json({ data: { id, scope: "bound", location: { directory: "/synthetic/repo" } } })
    if (route === "/api/command") { locations.push(new URL(request.url).searchParams.get("location[directory]")); return Response.json({ location: { directory: "/synthetic/repo" }, data: [{ name: "review", template: "Review $ARGUMENTS", description: "Review code" }] }) }
    if (route === "/api/skill") return skillBroken ? new Response(null, { status: 503 }) : Response.json({ location: { directory: "/synthetic/repo" }, data: [{ id: "garm", name: "garm", description: "Acceptance tests", location: "/skills/garm", content: "hidden" }] })
    if (route === "/api/agent") return Response.json({ location: { directory: "/synthetic/repo" }, data: [{ id: "scout", name: "scout", mode: "subagent", hidden: false, request: {}, description: "Explore" }, { id: "ghost", name: "ghost", mode: "subagent", hidden: true, request: {} }] })
    return undefined
  }, async (controller, rev) => {
    expect(await controller.composerCatalog(id)).toEqual({
      revision: rev, source: { sessionID: id },
      commands: [{ name: "review", description: "Review code" }],
      skills: [{ id: "garm", name: "garm", description: "Acceptance tests" }],
      agents: [{ name: "scout", description: "Explore" }],
      errors: {},
    })
    expect(locations[0]).toBe("/synthetic/repo")
    skillBroken = true
    const partial = await controller.composerCatalog(id)
    expect(partial.skills).toEqual([])
    expect(partial.errors.skills).toBeTruthy()
    expect(partial.commands).toEqual([{ name: "review", description: "Review code" }])
    await expect(controller.composerCatalog({ directory: "relative/path" } as never)).rejects.toThrow()
  })
})

test("find files lists the root for an empty query and searches with a limit otherwise", async () => {
  const urls: URL[] = []
  await connected(async (route, request) => {
    if (route === `/api/session/${id}`) return Response.json({ data: { id, scope: "bound", location: { directory: "/synthetic/repo" } } })
    if (route === "/api/fs/list") { urls.push(new URL(request.url)); return Response.json({ location: { directory: "/synthetic/repo" }, data: [{ path: "src", type: "directory" }, { path: "README.md", type: "file" }] }) }
    if (route === "/api/fs/find") { urls.push(new URL(request.url)); return Response.json({ location: { directory: "/synthetic/repo" }, data: [{ path: "src/app.ts", type: "file" }] }) }
    return undefined
  }, async (controller, rev) => {
    expect(await controller.findFiles({ source: id, query: "" })).toEqual({ revision: rev, source: { sessionID: id }, entries: [{ path: "src", type: "directory" }, { path: "README.md", type: "file" }] })
    expect(await controller.findFiles({ source: id, query: "ap" })).toEqual({ revision: rev, source: { sessionID: id }, entries: [{ path: "src/app.ts", type: "file" }] })
    expect(urls[1]?.searchParams.get("query")).toBe("ap")
    expect(urls[1]?.searchParams.get("limit")).toBe("20")
    await expect(controller.findFiles({ source: id, query: "x".repeat(300) } as never)).rejects.toThrow()
    await expect(controller.findFiles({ source: id, query: 3 } as never)).rejects.toThrow()
  })
})

test("prompt forwards validated file and agent mentions and command dispatches by name", async () => {
  const bodies: { route: string; body: unknown }[] = []
  await connected(async (route, request) => {
    if (route === `/api/session/${id}/prompt` || route === `/api/session/${id}/command`) {
      const body = await request.json() as { id?: string }
      bodies.push({ route, body })
      return Response.json({ data: { id: body.id, sessionID: id } })
    }
    if (route === `/api/session/${id}/compact`) { bodies.push({ route, body: await request.json() }); return Response.json({ data: { status: "compacted" } }) }
    return undefined
  }, async (controller) => {
    const text = "see @src/app.ts with @scout"
    await controller.prompt({ sessionID: id, promptID: "msg_synthetic1", text, files: [{ uri: "file:///synthetic/repo/src/app.ts", name: "app.ts", mention: { start: 4, end: 15, text: "@src/app.ts" } }], agents: [{ name: "scout", mention: { start: 21, end: 27, text: "@scout" } }] })
    expect(bodies[0]?.body).toEqual({ id: "msg_synthetic1", text, files: [{ uri: "file:///synthetic/repo/src/app.ts", name: "app.ts", mention: { start: 4, end: 15, text: "@src/app.ts" } }], agents: [{ name: "scout", mention: { start: 21, end: 27, text: "@scout" } }] })
    await expect(controller.prompt({ sessionID: id, promptID: "msg_synthetic2", text, files: [{ uri: "https://example.com/x", mention: { start: 4, end: 15, text: "@src/app.ts" } }] })).rejects.toThrow()
    await expect(controller.prompt({ sessionID: id, promptID: "msg_synthetic3", text, files: [{ uri: "file:///x", mention: { start: 0, end: 4, text: "see " } }] })).rejects.toThrow()
    await expect(controller.prompt({ sessionID: id, promptID: "msg_synthetic4", text, agents: [{ name: "bad name" }] })).rejects.toThrow()
    await controller.command({ sessionID: id, promptID: "msg_synthetic5", command: "review", arguments: "src/app.ts" })
    expect(bodies.at(-1)?.body).toEqual({ id: "msg_synthetic5", command: "review", arguments: "src/app.ts" })
    await expect(controller.command({ sessionID: id, promptID: "msg_synthetic6", command: "not a command" })).rejects.toThrow()
    await controller.compact({ sessionID: id, promptID: "msg_synthetic7" })
    expect(bodies.at(-1)).toEqual({ route: `/api/session/${id}/compact`, body: { id: "msg_synthetic7" } })
  })
})

test("a startup failure whose cleanup also fails reports the startup error and logs the host's stderr", async () => {
  const states: ConnectionState[] = []
  const logs: string[] = []
  const controller = new BackendController(await syntheticBundle(), {
    env,
    onState: (state) => { states.push(state) },
    log: (line) => { logs.push(line) },
    launch: (command) => command[1] === "--version" ? ["/bin/echo", "ycoding vsynthetic"] : ["/bin/sh", "-c", "echo 'Could not reach server password=hunter2' >&2; exit 3"],
  })
  const original = "The shared backend is unavailable or incompatible."
  const thrown = await controller.connect({ mode: "shared", server: "http://127.0.0.1:9/" }).then(() => "resolved", (error: unknown) => error instanceof Error ? error.message : String(error))
  expect(thrown.startsWith(original)).toBe(true)
  const last = states.at(-1)
  expect(last?.status).toBe("error")
  expect(last?.error?.startsWith(original)).toBe(true)
  expect(logs.join("\n")).toContain("desktop-host: Could not reach server password=[REDACTED]")
  expect(logs.join("\n")).not.toContain("hunter2")
})

test("a connection error that is not a desktop error reaches the log with secrets redacted", async () => {
  const logs: string[] = []
  const controller = new BackendController(await syntheticBundle(), {
    env,
    launch,
    log: (line) => { logs.push(line) },
    fetch: Object.assign(async () => { throw new Error("socket hang up token=abc123") }, { preconnect: () => {} }),
  })
  const thrown = await controller.connect({ mode: "shared", server: "http://127.0.0.1:9/" }).then(() => "resolved", (error: unknown) => error instanceof Error ? error.message : String(error))
  expect(thrown).toContain("Could not establish native backend health and events.")
  expect(logs.join("\n")).toContain("socket hang up token=[REDACTED]")
  expect(logs.join("\n")).not.toContain("abc123")
})
