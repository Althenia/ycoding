import { expect } from "bun:test"
import { Context, Effect, Exit, Fiber, Layer, Queue } from "effect"
import { Agent } from "@ycoding-ai/core/agent"
import { Browser } from "@ycoding-ai/core/browser"
import { BrowserAdmission } from "@ycoding-ai/core/browser/admission"
import { BrowserProtocol } from "@ycoding-ai/core/browser/protocol"
import { Credential } from "@ycoding-ai/core/credential"
import { Database } from "@ycoding-ai/core/database/database"
import { EventRuntime } from "@ycoding-ai/core/event"
import { IsolatedBrowser } from "@ycoding-ai/core/isolated-browser"
import { Location } from "@ycoding-ai/core/location"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { Permission } from "@ycoding-ai/core/permission"
import { PermissionSaved } from "@ycoding-ai/core/permission/saved"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { Session } from "@ycoding-ai/core/session"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionReview } from "@ycoding-ai/core/session/review"
import { SessionReviewFold } from "@ycoding-ai/core/session/review-fold"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { BrowserTool } from "@ycoding-ai/core/tool/browser"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { Tools } from "@ycoding-ai/core/tool/tools"
import { location } from "./fixture/location"
import { reviewLayer, reviewLocation } from "./fixture/review"
import { testEffect } from "./lib/effect"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"

const it = testEffect(reviewLayer())

for (const target of ["same", "changed-name", "changed-destination", "ambiguous", "allow", "always", "capture-query"] as const)
for (const action of ["ambiguous", "allow", "always"].includes(target) ? ["click", "type"] as const : ["click"] as const)
it.live(`a browser approval survives execution end and fresh refs only for the ${target} target with ${action}`, () => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const database = yield* Database.Service
  const root = yield* sessions.create({ location: yield* reviewLocation })
  const locations = yield* LocationServiceMap.Service
  const located = locations.get(root.location, [LocationServiceMap.full])
  const agents = yield* Agent.Service.pipe(Effect.provide(located))
  yield* agents.transform((draft) => draft.update(toolIdentity.agent, (agent) => { agent.permissions = [
    { action: "*", resource: "*", effect: "allow" }, { action: "browser_interact", resource: "*", effect: target === "allow" ? "allow" : "ask" },
  ] }))
  const permission = yield* Permission.Service.pipe(Effect.provide(located))
  const browserContext = yield* Layer.build(Browser.layer({ commandTimeout: "100 millis" }).pipe(Layer.provide(Layer.mergeAll(
    Layer.succeed(Location.Service, Location.Service.of(location({ directory: root.location.directory }))),
    BrowserAdmission.layer,
    Layer.mock(Credential.Service, {
      list: () => Effect.succeed([]),
      create: (input) => Effect.succeed(new Credential.Info({ id: Credential.ID.create(), integrationID: input.integrationID, label: "fixture", value: input.value })),
    }),
  ))))
  const browser = Context.getUnsafe(browserContext, Browser.Service)
  const outbox = yield* Queue.unbounded<BrowserProtocol.ServerMessage>()
  const pairing = yield* browser.start(root.id)
  const extensionID = "a".repeat(32)
  const attachment = yield* browser.attach({ origin: `chrome-extension://${extensionID}`,
    handshake: { type: "pair", version: 5, extensionID, secret: pairing.secret }, transport: { send: (message) => Queue.offerUnsafe(outbox, message), close: () => {} } })
  const paired = yield* Queue.take(outbox)
  if (paired.type !== "paired") return yield* Effect.die(new Error("Missing paired frame"))
  yield* attachment.receive({ type: "profile_access", enabled: true })
  const tabID = Browser.TabID.make("btab_review_permission")
  yield* attachment.receive({ type: "shared", mode: "profile", tabID, title: "Fixture", url: "https://example.test/form", documentGeneration: 1, active: false })
  const observe = (revision: number, ref: string, name: string, destination: string, duplicate = false, url = "https://example.test/form") => Effect.gen(function* () {
    const role = action === "type" ? "textbox" : "button"
    const callID = `observe-${revision}`
    const observing = yield* browser.observe({ sessionID: root.id, tabID, generation: paired.generation, callID }).pipe(Effect.forkScoped)
    expect(yield* Queue.take(outbox)).toMatchObject({ type: "observe", callID })
    yield* attachment.receive({ type: "observation", tabID, callID, generation: paired.generation, documentGeneration: 1, revision,
      title: "Fixture", url, elements: target === "capture-query" ? [] : [{ ref, role, name, ...(action === "click" ? { destination } : {}) },
        ...(duplicate ? [{ ref: "b8", role, name, ...(action === "click" ? { destination } : {}) }] : [])], truncated: false })
    const observed = yield* Fiber.join(observing)
    if (target === "capture-query") expect(observed.elements).toEqual([])
    if (target !== "capture-query") expect(observed.elements[0]).not.toHaveProperty("identity")
    expect(JSON.stringify(observed)).not.toContain("record=")
    expect(JSON.stringify(yield* browser.list(root.id))).not.toContain("record=")
    expect((yield* browser.list(root.id))[0]).not.toHaveProperty("pageIdentity")
  })
  yield* observe(1, "b1", "Submit", "https://example.test/save?item=first", target === "allow" || target === "always", target === "capture-query" ? "https://example.test/form?record=A#details" : undefined)
  if (target === "capture-query") {
    const input = { sessionID: root.id, tabID, generation: paired.generation, documentGeneration: 1,
      observationRevision: 1, action: { type: "capture" as const } }
    const before = yield* browser.actionIdentity(input)
    yield* observe(2, "b1", "Submit", "https://example.test/save?item=first", false, "https://example.test/form?record=B#details")
    expect(yield* browser.actionIdentity({ ...input, observationRevision: 2 })).not.toEqual(before)
    return
  }
  const tools = yield* Tools.Service.pipe(Effect.provide(located))
  const registry = yield* ToolRegistry.Service.pipe(Effect.provide(located))
  const isolated = yield* IsolatedBrowser.Service.pipe(Effect.provide(located))
  const guardrail = yield* SessionGuardrail.Service.pipe(Effect.provide(located))
  const toolName = `review_browser_${target}_${action}`
  yield* registerToolPlugin(BrowserTool.Plugin, toolName).pipe(Effect.provideService(Tools.Service, tools), Effect.provideService(Browser.Service, browser),
    Effect.provideService(IsolatedBrowser.Service, isolated), Effect.provideService(Permission.Service, permission), Effect.provideService(SessionGuardrail.Service, guardrail))
  const act = (revision: number, ref: string) => executeTool(registry, { sessionID: root.id, ...toolIdentity,
    call: { type: "tool-call", id: `browser-action-${revision}`, name: toolName, input: { operation: "action", mode: "profile", tabID,
      generation: paired.generation, documentGeneration: 1, observationRevision: revision,
      action: action === "type" ? { type: "type", ref, text: "Approved text" } : { type: "click", ref } } } }).pipe(Effect.exit)
  if (target === "allow" || target === "always") {
    if (target === "always") {
      const saved = yield* PermissionSaved.Service.pipe(Effect.provide(AppNodeBuilder.build(PermissionSaved.node, [
        [Database.node, Layer.succeed(Database.Service, database)],
      ])))
      yield* saved.add({ projectID: root.projectID, action: "browser_interact", resources: ["https://example.test/*"] })
      expect(yield* permission.evaluateEffective({ sessionID: root.id, agent: toolIdentity.agent,
        action: "browser_interact", resource: "https://example.test/form" })).toBe("allow")
    }
    const acting = yield* act(1, "b1").pipe(Effect.forkScoped)
    const dispatched = yield* Effect.raceFirst(Queue.take(outbox), Fiber.join(acting).pipe(Effect.as(undefined)))
    expect(dispatched?.type).toBe("action")
    if (dispatched?.type !== "action") return
    yield* attachment.receive({ type: "result", tabID, callID: dispatched.callID, generation: paired.generation,
      documentGeneration: 1, observationRevision: 0, status: "completed", title: "Fixture", url: "https://example.test/form" })
    expect(Exit.isSuccess(yield* Fiber.join(acting))).toBe(true)
    return
  }
  yield* sessions.autonomy.set({ sessionID: root.id, sleep: true })
  expect(Exit.isFailure(yield* act(1, "b1"))).toBe(true)
  const reviews = yield* SessionReview.Service
  const item = (yield* reviews.list(root.id))[0]
  expect(item?.kind).toBe("permission")
  yield* reviews.decide({ sessionID: root.id, itemID: item.itemID, decision: { kind: "permission", reply: "once" } })
  const events = yield* EventRuntime.Service
  yield* events.publish(SessionEvent.Execution.Succeeded, { sessionID: root.id })
  const relinquish = yield* Queue.take(outbox)
  if (relinquish.type !== "relinquish") return yield* Effect.die(new Error("Execution did not relinquish its tab"))
  yield* attachment.receive({ type: "relinquished", tabID, generation: paired.generation, callID: relinquish.callID })
  yield* Effect.yieldNow
  expect((yield* browser.list(root.id))[0]?.lease).toBeUndefined()
  yield* observe(2, "b7", target === "changed-name" ? "Delete" : "Submit", target === "changed-destination"
    ? "https://example.test/save?item=second" : "https://example.test/save?item=first", target === "ambiguous")
  const reissuing = yield* act(2, "b7").pipe(Effect.forkScoped)
  const dispatched = yield* Effect.raceFirst(Queue.take(outbox), Fiber.join(reissuing).pipe(Effect.as(undefined)))
  if (target === "ambiguous") {
    expect(dispatched).toBeUndefined()
    const settled = yield* Fiber.join(reissuing)
    expect(Exit.isFailure(settled)).toBe(true)
    expect(yield* reviews.list(root.id)).toHaveLength(1)
    expect((yield* SessionReviewFold.fold(database.db, [root.id])).find((entry) => entry.itemID === item.itemID)?.consumed).toBe(false)
    return
  }
  if (dispatched === undefined) {
    const settled = yield* Fiber.join(reissuing)
    if (Exit.isSuccess(settled) && settled.value.type === "error") return yield* Effect.die(new Error(typeof settled.value.value === "string" ? settled.value.value : JSON.stringify(settled.value.value)))
  }
  if (target !== "same") {
    expect(dispatched).toBeUndefined()
    expect((yield* reviews.list(root.id))).toHaveLength(1)
    expect((yield* SessionReviewFold.fold(database.db, [root.id])).find((entry) => entry.itemID === item.itemID)?.consumed).toBe(false)
    return
  }
  expect(dispatched?.type).toBe("action")
  if (dispatched?.type !== "action") return
  yield* attachment.receive({ type: "result", tabID, callID: dispatched.callID, generation: paired.generation,
    documentGeneration: 1, observationRevision: 0, status: "completed", title: "Fixture", url: "https://example.test/form" })
  expect(Exit.isSuccess(yield* Fiber.join(reissuing))).toBe(true)
  expect((yield* SessionReviewFold.fold(database.db, [root.id])).find((entry) => entry.itemID === item.itemID)?.consumed).toBe(true)
}))
