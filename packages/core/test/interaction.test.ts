import { expect, test } from "bun:test"
import { Interaction } from "@ycoding-ai/schema/interaction"
import { SessionID } from "@ycoding-ai/schema/session-id"
import { Session } from "@ycoding-ai/schema/session"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../src/effect/app-node"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Image } from "../src/image"
import { makeAuthority } from "../src/interaction/authority"
import type { InteractionDriver, InteractionDriverKey } from "../src/interaction/driver"
import { InteractionRuntime } from "../src/interaction"
import { Permission } from "../src/permission"
import { SessionGuardrail } from "../src/session/guardrail"
import { SessionStore } from "../src/session/store"
import { ToolOutputStore } from "../src/tool-output-store"
import { InteractionTool } from "../src/tool/interaction"
import { ToolRegistry } from "../src/tool/registry"
import { imagePassthrough } from "./lib/image"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"

const target = { kind: "chrome-tab", id: Interaction.ID.create(), label: "Fixture", origin: "https://example.test", pathname: "/" } as const
const action = { platform: "chrome", type: "scroll", deltaY: 120 } as const
const png = { mimeType: "image/png", width: 1, height: 1,
  base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" } as const

function fixture(driver: Partial<InteractionDriver> = {}, options?: Parameters<typeof makeAuthority>[0], key?: InteractionDriverKey) {
  const authority = makeAuthority(options)
  const lease = { id: Interaction.ID.create() }
  const calls: Interaction.Action[] = []
  const native = authority.register({
    platform: "chrome",
    inventory: async () => [target],
    attach: async (_, proof) => {
      if (proof.authorization !== "native-proof") throw new Error("invalid proof")
      return lease
    },
    observe: async () => ({ revision: 1, elements: [], pathname: target.pathname }),
    perform: async (_, _revision, command) => {
      calls.push(command.action)
      return { outcome: "applied" }
    },
    preview: async () => png,
    resume: async () => true,
    detach: async () => {},
    ...driver,
  }, key)
  return { authority, native, calls, lease }
}

async function activate(f: ReturnType<typeof fixture>, sessionID: SessionID, selection: Interaction.Request = { platform: "chrome" }) {
  const pending = await f.authority.request(sessionID, selection)
  if (pending.state !== "pending") throw new Error("Expected a pending native request")
  const candidate = f.native.pending()[0]
  await f.native.inventory(candidate.candidateID)
  expect(await f.native.approve({ candidateID: candidate.candidateID, sessionID, targetID: target.id, authorization: "native-proof" })).toBe(true)
  return pending.generation
}

test("only the exact native candidate can attach; another Session cannot use or stop its lease", async () => {
  const f = fixture()
  const owner = SessionID.create()
  const other = SessionID.create()
  const pending = await f.authority.request(owner, { platform: "chrome" })
  if (pending.state !== "pending") throw new Error("Expected a pending native request")
  const proof = { candidateID: f.native.pending()[0].candidateID, sessionID: owner, targetID: target.id, authorization: "native-proof" }
  expect(await f.native.approve(proof)).toBe(false)
  await f.native.inventory(proof.candidateID)
  expect(await f.native.approve({ ...proof, sessionID: other })).toBe(false)
  expect(await f.native.approve({ ...proof, targetID: Interaction.ID.create() })).toBe(false)
  expect(f.authority.status(owner)).toEqual(pending)
  expect(await f.native.approve(proof)).toBe(true)
  expect(await f.native.approve(proof)).toBe(false)
  expect(f.authority.status(other)).toEqual({ state: "unavailable" })
  expect(f.authority.stop(other, pending.generation)).toBe(false)
  expect(await f.authority.preview(other, pending.generation)).toEqual({ state: "unavailable", generation: pending.generation })
  expect(await f.authority.observe(other, pending.generation).catch((error: unknown) => error)).toMatchObject({ code: "stale" })
  expect(f.authority.status(owner).state).toBe("active")
  f.native.disconnect()
})

test("Stop fences an in-flight action and late preview before cleanup completes", async () => {
  const actionEntered = Promise.withResolvers<void>()
  const actionDone = Promise.withResolvers<Interaction.ActionResult>()
  const previewEntered = Promise.withResolvers<void>()
  const previewDone = Promise.withResolvers<Interaction.Frame>()
  const detach = Promise.withResolvers<void>()
  const cleaned = Promise.withResolvers<void>()
  const sessionID = SessionID.create()
  const f = fixture({
    perform: async () => { actionEntered.resolve(); return actionDone.promise },
    preview: async () => { previewEntered.resolve(); return previewDone.promise },
    detach: () => detach.promise,
  }, { changed: (id) => {
    const status = f.authority.status(id)
    if (id === sessionID && status.state === "stopped" && status.cleanup === "complete") cleaned.resolve()
  } })
  const generation = await activate(f, sessionID)
  await f.authority.observe(sessionID, generation)
  const frame = f.authority.preview(sessionID, generation)
  await previewEntered.promise
  const callID = Interaction.ID.create()
  const inFlight = f.authority.perform(sessionID, generation, 1, callID, action)
  await actionEntered.promise
  expect(f.authority.stop(sessionID, generation)).toBe(true)
  expect(f.authority.status(sessionID)).toMatchObject({ state: "stopped", cleanup: "pending" })
  expect(await f.authority.perform(sessionID, generation, 1, callID, action)).toEqual({ outcome: "refused", reason: "stale" })
  expect(await inFlight).toEqual({ outcome: "uncertain" })
  expect(await frame).toEqual({ state: "unavailable", generation })
  actionDone.resolve({ outcome: "applied" })
  previewDone.resolve(png)
  detach.resolve()
  await cleaned.promise
  expect(await f.authority.preview(sessionID, generation)).toEqual({ state: "unavailable", generation })
  expect((await f.authority.request(sessionID, { platform: "chrome" })).state).toBe("pending")
  expect(f.authority.stop(sessionID, generation)).toBe(false)
  f.native.disconnect()
})

test("Stop aborts the pending native consent for its exact generation", async () => {
  const f = fixture()
  const offered = Promise.withResolvers<{ candidateID: Interaction.ID; signal: AbortSignal }>()
  const unsubscribe = f.native.onPending((request, signal) => offered.resolve({ candidateID: request.candidateID, signal }))
  const sessionID = SessionID.create()
  const pending = await f.authority.request(sessionID, { platform: "chrome" })
  if (pending.state !== "pending") throw new Error("Expected a pending native request")
  try {
    const candidate = await offered.promise
    expect(f.authority.stop(sessionID, Interaction.Generation.create())).toBe(false)
    expect(candidate.signal.aborted).toBe(false)
    expect(f.authority.stop(sessionID, pending.generation)).toBe(true)
    expect(candidate.signal.aborted).toBe(true)
    expect(await f.native.approve({ candidateID: candidate.candidateID, sessionID, targetID: target.id, authorization: "native-proof" })).toBe(false)
  } finally {
    unsubscribe()
    f.native.disconnect()
  }
})

test("macOS Interaction cannot offer or approve its own private helper window", async () => {
  const authority = makeAuthority()
  const privateWindow = { kind: "macos-window", id: Interaction.ID.create(), bundleID: "app.YCoding.Interaction", label: "Fixture" } as const
  const ordinaryWindow = { ...privateWindow, id: Interaction.ID.create(), bundleID: "com.example.fixture" }
  const native = authority.register({
    platform: "macos", inventory: async () => [privateWindow, ordinaryWindow],
    attach: async () => ({ id: Interaction.ID.create() }),
    observe: async () => ({ revision: 1, elements: [] }),
    perform: async () => ({ outcome: "applied" }), preview: async () => undefined, resume: async () => true, detach: async () => {},
  })
  const sessionID = SessionID.create()
  await authority.request(sessionID, { platform: "macos" })
  const candidateID = native.pending()[0].candidateID
  try {
    expect(await native.inventory(candidateID)).toEqual([ordinaryWindow])
    expect(await native.approve({ candidateID, sessionID, targetID: privateWindow.id, authorization: "native-proof" })).toBe(false)
  } finally {
    native.disconnect()
  }
})

test("preview rejects truncated, oversized, and mismatched image headers before publication", async () => {
  const oversized = Buffer.from(png.base64, "base64")
  oversized.writeUInt32BE(961, 16)
  const mappableJPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 2, 1, 1, 0x11, 0, 0xff, 0xd9])
  const previews = [png,
    { ...png, base64: "iVBORw0KGgo=" },
    { ...png, base64: oversized.toString("base64") },
    { ...png, mimeType: "image/jpeg" as const, base64: Buffer.from(mappableJPEG).toString("base64") },
  ]
  const f = fixture({ preview: async () => previews.shift() })
  const sessionID = SessionID.create()
  const generation = await activate(f, sessionID)
  try {
    expect(await f.authority.preview(sessionID, generation)).toEqual({ state: "ready", generation, frame: png })
    for (let index = 0; index < 3; index++)
      expect(await f.authority.preview(sessionID, generation)).toEqual({ state: "unavailable", generation })
  } finally {
    f.native.disconnect()
  }
})

test("a preview captured across an unresolved document transition cannot be published", async () => {
  const previewEntered = Promise.withResolvers<void>()
  const previewDone = Promise.withResolvers<Interaction.Frame>()
  const observeEntered = Promise.withResolvers<void>()
  const observeDone = Promise.withResolvers<Interaction.Observation>()
  const f = fixture({
    preview: async () => { previewEntered.resolve(); return previewDone.promise },
    observe: async () => { observeEntered.resolve(); return observeDone.promise },
  })
  const sessionID = SessionID.create()
  const generation = await activate(f, sessionID)
  try {
    const frame = f.authority.preview(sessionID, generation)
    await previewEntered.promise
    const observed = f.authority.observe(sessionID, generation).catch((error: unknown) => error)
    await observeEntered.promise
    previewDone.resolve(png)
    const exposed = await frame
    observeDone.resolve({ revision: 1, pathname: "/redirected", elements: [] })
    expect(await observed).toMatchObject({ code: "unavailable" })
    expect(exposed).toEqual({ state: "unavailable", generation })
    expect(f.authority.status(sessionID)).toMatchObject({ state: "stopped", reason: "target_lost" })
  } finally {
    f.native.disconnect()
  }
})

test("one fresh revision and one call ID permit at most one dispatch", async () => {
  const changes: Array<{ sessionID: SessionID; generation: Interaction.Generation }> = []
  const f = fixture({}, { changed: (sessionID, generation) => changes.push({ sessionID, generation }) })
  const sessionID = SessionID.create()
  const generation = await activate(f, sessionID)
  const callID = Interaction.ID.create()
  expect(await f.authority.perform(sessionID, generation, 1, callID, action)).toEqual({ outcome: "refused", reason: "stale" })
  await f.authority.observe(sessionID, generation)
  expect(await f.authority.perform(sessionID, generation, 1, callID, action)).toEqual({ outcome: "applied" })
  expect(await f.authority.perform(sessionID, generation, 1, callID, action)).toEqual({ outcome: "refused", reason: "stale" })
  expect(f.calls).toEqual([action])
  expect(changes).toEqual(Array.from({ length: 3 }, () => ({ sessionID, generation })))
  f.native.disconnect()
})

test("Chrome accepts a pathname-only observation at its pinned document", async () => {
  const observation = { revision: 1, pathname: target.pathname, elements: [] }
  const f = fixture({ observe: async () => observation })
  const sessionID = SessionID.create()
  const generation = await activate(f, sessionID)
  try {
    expect(await f.authority.observe(sessionID, generation).catch((error: unknown) => error)).toEqual(observation)
  } finally {
    f.native.disconnect()
  }
})

test("Chrome refuses a different path before dispatch and exact navigation invalidates the previous revision", async () => {
  const owned = { ...target, kind: "chrome-owned", pathname: "/approved", url: "https://example.test/approved?mode=fixture#section" } as const
  let revision = 0
  const f = fixture({ inventory: async () => [owned], observe: async () => ({
    revision: ++revision, elements: [], pathname: owned.pathname,
  }) })
  const sessionID = SessionID.create()
  const generation = await activate(f, sessionID, { platform: "chrome", mode: "owned", url: owned.url })
  const navigate = (url: string, revision: number) => f.authority.perform(sessionID, generation, revision, Interaction.ID.create(), {
    platform: "chrome", type: "navigate", url,
  })
  try {
    await f.authority.observe(sessionID, generation)
    expect(await navigate("https://example.test/admin", 1)).toEqual({ outcome: "refused", reason: "policy" })
    expect(await navigate("https://example.test/approved?mode=other#section", 1)).toEqual({ outcome: "refused", reason: "policy" })
    expect(f.calls).toEqual([])
    expect(await navigate(owned.url, 1)).toEqual({ outcome: "applied" })
    expect(await navigate(owned.url, 1)).toEqual({ outcome: "refused", reason: "stale" })
    await f.authority.observe(sessionID, generation)
    expect(await navigate(owned.url, 2)).toEqual({ outcome: "applied" })
    expect(f.calls).toEqual(Array.from({ length: 2 }, () => ({ platform: "chrome", type: "navigate", url: owned.url })))
  } finally {
    f.native.disconnect()
  }
})

test("paired disconnect does not revoke an approved isolated Chrome target or permit fallback", async () => {
  const f = fixture()
  const isolatedSession = SessionID.create()
  const isolatedTarget = { ...target, kind: "chrome-isolated", url: "https://example.test/private", pathname: "/private" } as const
  const selection = { platform: "chrome", mode: "isolated", url: isolatedTarget.url } as const
  expect(await f.authority.request(isolatedSession, selection)).toEqual({ state: "unavailable" })
  expect(f.native.pending()).toHaveLength(0)
  const isolated = f.authority.register({
    platform: "chrome",
    inventory: async () => [isolatedTarget, { ...isolatedTarget, id: Interaction.ID.create(), url: "https://example.test/other" }],
    attach: async () => ({ id: Interaction.ID.create() }),
    observe: async () => ({ revision: 1, elements: [], pathname: isolatedTarget.pathname }),
    perform: async () => ({ outcome: "applied" }),
    preview: async () => undefined,
    resume: async () => true,
    detach: async () => {},
  }, "chrome-isolated")
  const pending = await f.authority.request(isolatedSession, selection)
  if (pending.state !== "pending") throw new Error("Expected an isolated candidate")
  const candidate = isolated.pending()[0]
  expect(candidate).toMatchObject({ purpose: "attach", selection })
  expect(await isolated.inventory(candidate.candidateID)).toEqual([isolatedTarget])
  expect(await isolated.approve({ candidateID: candidate.candidateID, sessionID: isolatedSession,
    targetID: isolatedTarget.id, authorization: "isolated-native-proof" })).toBe(true)
  expect(await f.authority.request(isolatedSession, { platform: "chrome", mode: "tab" })).toMatchObject({ state: "active", generation: pending.generation })
  const pairedSession = SessionID.create()
  await activate(f, pairedSession)
  f.native.disconnect()
  expect(f.authority.status(pairedSession)).toMatchObject({ state: "stopped", reason: "disconnected" })
  expect(await f.authority.observe(isolatedSession, pending.generation)).toMatchObject({ revision: 1 })
  isolated.disconnect()
})

test("a destructive approval is bound to the exact action in the observed revision", async () => {
  const f = fixture()
  const sessionID = SessionID.create()
  const generation = await activate(f, sessionID)
  await f.authority.observe(sessionID, generation)
  const original = { platform: "chrome", type: "click", elementID: Interaction.ID.create(), destructive: true } as const
  const changed = { ...original, elementID: Interaction.ID.create() }
  expect(await f.authority.perform(sessionID, generation, 1, Interaction.ID.create(), original))
    .toEqual({ outcome: "refused", reason: "confirmation_required" })
  f.authority.confirmation(sessionID, generation, 1, original)
  const candidate = f.native.pending()[0]
  expect(candidate).toMatchObject({ purpose: "confirm", action: original, revision: 1 })
  await f.native.inventory(candidate.candidateID)
  expect(await f.native.approve({ candidateID: candidate.candidateID, sessionID, targetID: target.id, authorization: "native-action-proof" })).toBe(true)
  expect(await f.authority.perform(sessionID, generation, 1, Interaction.ID.create(), changed))
    .toEqual({ outcome: "refused", reason: "confirmation_required" })
  expect(await f.authority.perform(sessionID, generation, 1, Interaction.ID.create(), original)).toEqual({ outcome: "applied" })
  expect(f.calls).toEqual([original])
  f.native.disconnect()
})

test("isolated Chrome refuses action consent without creating a pending offer or dispatching", async () => {
  const isolated = { ...target, kind: "chrome-isolated", url: "https://example.test/" } as const
  const f = fixture({ inventory: async () => [isolated] }, undefined, "chrome-isolated")
  const sessionID = SessionID.create()
  const generation = await activate(f, sessionID, { platform: "chrome", mode: "isolated", url: isolated.url })
  try {
    const { revision } = await f.authority.observe(sessionID, generation)
    const destructive = { platform: "chrome", type: "click", elementID: Interaction.ID.create(), destructive: true } as const
    const refused = { outcome: "refused", reason: "unsupported" } as const
    expect(f.authority.confirmation(sessionID, generation, revision, destructive)).toEqual(refused)
    expect(f.native.pending()).toEqual([])
    expect(await f.authority.perform(sessionID, generation, revision, Interaction.ID.create(), destructive)).toEqual(refused)
    expect(f.calls).toEqual([])
    expect(await f.authority.perform(sessionID, generation, revision, Interaction.ID.create(), action)).toEqual({ outcome: "applied" })
    expect(f.calls).toEqual([action])
  } finally {
    f.native.disconnect()
  }
})

test("the Location tool applies a path-scoped deny before asking the Chrome driver for semantics", async () => {
  const sessionID = SessionID.create()
  const admin = { ...target, pathname: "/admin/settings" }
  const reads: string[] = []
  let observations = 0
  const f = fixture({
    inventory: async () => [admin],
    observe: async () => {
      observations++
      return { revision: 1, elements: [], pathname: admin.pathname }
    },
  })
  const generation = await activate(f, sessionID)
  const rules: Permission.Ruleset = [{ action: "browser_read", resource: "https://example.test/admin*", effect: "deny" }]
  try {
    const result = await runTool(f, sessionID, { operation: "observe", generation }, (input) => {
      if (input.action === "browser_read") reads.push(...input.resources)
      return input.resources.some((resource) => Permission.evaluate(input.action, resource, rules).effect === "deny")
        ? Effect.fail(new Permission.BlockedError({ rules, permission: input.action, resources: input.resources }))
        : Effect.void
    })
    expect(JSON.stringify(result)).toContain("Permission denied: browser_read")
    expect(reads).toEqual(["https://example.test/admin/settings"])
    expect(observations).toBe(0)
  } finally {
    f.native.disconnect()
  }
})

test("the Location tool reports a paused grant as status without driver reads or actions", async () => {
  const sessionID = SessionID.create()
  const driverCalls: string[] = []
  const f = fixture({
    observe: async () => { driverCalls.push("observe"); return { revision: 1, elements: [], pathname: target.pathname } },
    perform: async () => { driverCalls.push("perform"); return { outcome: "applied" } },
  })
  const generation = await activate(f, sessionID)
  f.native.pause(f.lease.id, "captcha")
  try {
    for (const input of [
      { operation: "observe", generation },
      { operation: "perform", generation, revision: 1, action },
      { operation: "confirm", generation, revision: 1, action: { ...action, destructive: true } },
    ]) {
      const text = JSON.stringify(await runTool(f, sessionID, input)).replaceAll("\\", "")
      expect(text).toContain(`"status":{"state":"paused","platform":"chrome","generation":"${generation}","label":"Selected Chrome tab","reason":"captcha"}`)
    }
    expect(driverCalls).toEqual([])
  } finally {
    f.native.disconnect()
  }
})

test("the Location tool runs a script only after interaction, browser_read and browser_script permission", async () => {
  const sessionID = SessionID.create()
  const runs: unknown[] = []
  const asked: Array<{ action: string; resources: readonly string[]; metadata?: Record<string, unknown> }> = []
  const f = fixture({ run: async (_lease, request) => { runs.push(request); return { outcome: "completed", value: 3, logs: [] } } })
  const generation = await activate(f, sessionID)
  try {
    const { revision } = await f.authority.observe(sessionID, generation)
    const source = "const rows = document.querySelectorAll('tr')\nreturn rows.length"
    const result = await runTool(f, sessionID, { operation: "run", generation, revision, script: { mode: "script", source } }, (input) => {
      asked.push({ action: input.action, resources: input.resources, metadata: input.metadata })
      return Effect.void
    })
    expect(JSON.stringify(result).replaceAll("\\", "")).toContain('{"type":"script","result":{"outcome":"completed","value":3,"logs":[]}}')
    expect(asked.map((entry) => [entry.action, entry.resources])).toEqual([
      ["interaction", ["https://example.test/"]], ["browser_read", ["https://example.test/"]], ["browser_script", ["https://example.test/"]],
    ])
    const scriptAsk = asked.find((entry) => entry.action === "browser_script")?.metadata
    expect(scriptAsk).toMatchObject({ operation: "run", mode: "script", sourcePreview: "const rows = document.querySelectorAll('tr') return rows.length" })
    expect(scriptAsk?.sourceDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(runs).toEqual([{ mode: "script", source, timeoutMs: 10_000 }])
  } finally {
    f.native.disconnect()
  }
})

test("the Location tool reports a paused run without asking any permission or dispatching", async () => {
  const sessionID = SessionID.create()
  let runs = 0
  const asked: string[] = []
  const f = fixture({ run: async () => { runs++; return { outcome: "completed", logs: [] } } })
  const generation = await activate(f, sessionID)
  try {
    const { revision } = await f.authority.observe(sessionID, generation)
    f.native.pause(f.lease.id, "dialog")
    const result = await runTool(f, sessionID, { operation: "run", generation, revision, script: { mode: "code", source: "1" } }, (input) => {
      asked.push(input.action)
      return Effect.void
    })
    expect(JSON.stringify(result).replaceAll("\\", "")).toContain('{"type":"script","result":{"outcome":"paused","reason":"dialog"}}')
    expect(asked).toEqual([])
    expect(runs).toBe(0)
  } finally {
    f.native.disconnect()
  }
})

function runTool(f: ReturnType<typeof fixture>, sessionID: SessionID, input: Record<string, unknown>,
  assert: Permission.Interface["assert"] = () => Effect.void,
) {
  const session = Schema.decodeUnknownSync(Session.Info)({
    id: sessionID, projectID: "global", scope: "bound", title: "Interaction fixture", location: { directory: "/fixture" },
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 0, updated: 0 },
  })
  const registration = makeLocationNode({
    name: "test/interaction-tool",
    layer: Layer.effectDiscard(registerToolPlugin(InteractionTool.Plugin)),
    deps: [ToolRegistry.toolsNode, InteractionRuntime.node, Permission.node, SessionGuardrail.node, SessionStore.node],
  })
  const layer = AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, registration]), [
    [InteractionRuntime.node, Layer.succeed(InteractionRuntime.Service, f.authority)],
    [Permission.node, Layer.mock(Permission.Service, { assert: (request) => Effect.suspend(() => assert(request)) })],
    [SessionGuardrail.node, Layer.mock(SessionGuardrail.Service, {
      reviewPolicy: { enabled: true, decideReviews: false, decideHardReviews: true },
      assert: () => Effect.succeed({ release: Effect.void }),
    })],
    [SessionStore.node, Layer.mock(SessionStore.Service, { get: () => Effect.succeed(session) })],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    [Image.node, imagePassthrough],
  ])
  return Effect.runPromise(Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    return yield* executeTool(registry, { sessionID, ...toolIdentity,
      call: { type: "tool-call", id: "interaction-call", name: "interaction", input },
    })
  }).pipe(Effect.provide(layer), Effect.scoped))
}

test.each(["redirect", "missing document"])("a Chrome %s cannot expose semantics or admit a stale action", async (reason) => {
  let revision = 0
  const f = fixture({ observe: async () => {
    revision++
    const elements = [{ id: Interaction.ID.create(), role: "button", label: "Private control", editable: false }]
    if (revision === 1) return { revision, pathname: target.pathname, elements: [] }
    return reason === "redirect" ? { revision, pathname: "/redirected", elements } : { revision, elements }
  } })
  const sessionID = SessionID.create()
  const generation = await activate(f, sessionID)
  await f.authority.observe(sessionID, generation)
  if (reason === "redirect") expect(await f.authority.perform(sessionID, generation, 1, Interaction.ID.create(), {
    platform: "chrome", type: "navigate", url: "https://example.test/",
  })).toEqual({ outcome: "applied" })
  expect(await f.authority.observe(sessionID, generation).catch((error: unknown) => error)).toMatchObject({ code: "unavailable" })
  expect(f.authority.status(sessionID)).toMatchObject({ state: "stopped", reason: "target_lost" })
  expect(await f.authority.perform(sessionID, generation, revision, Interaction.ID.create(), action)).toEqual({ outcome: "refused", reason: "stale" })
  expect(await f.authority.preview(sessionID, generation)).toEqual({ state: "unavailable", generation })
  f.native.disconnect()
})
