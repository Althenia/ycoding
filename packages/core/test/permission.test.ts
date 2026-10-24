import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { Agent } from "@ycoding-ai/core/agent"
import { Database } from "@ycoding-ai/core/database/database"
import { Decision } from "@ycoding-ai/core/decision"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Location } from "@ycoding-ai/core/location"
import { Permission } from "@ycoding-ai/core/permission"
import { PermissionTable } from "@ycoding-ai/core/permission/sql"
import { PermissionSaved } from "@ycoding-ai/core/permission/saved"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SessionPermissionCeiling } from "@ycoding-ai/core/session/permission-ceiling"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { eq } from "drizzle-orm"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventRuntime.node,
      SessionStore.node,
      SessionAutonomy.node,
      PermissionSaved.node,
      Agent.node,
      Permission.node,
    ]),
    [
      [Location.node, current],
      [Decision.node, Layer.mock(Decision.Service, { evaluate: () => Effect.fail(new Decision.Error({ reason: "unavailable" })) })],
    ],
  ),
)

function setup(rules: Permission.Ruleset = []) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: Session.ID.make("ses_test"),
        project_id: Project.ID.global,
        directory: "/project",
        title: "test",
        agent: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* setRules(rules)
  })
}

function setRules(rules: Permission.Ruleset) {
  return Effect.gen(function* () {
    const agents = yield* Agent.Service
    yield* agents.transform((editor) =>
      editor.update(Agent.ID.make("test"), (agent) => {
        agent.permissions = [...rules]
      }),
    )
  })
}

function assertion(input: Partial<Permission.AssertInput> = {}) {
  return {
    id: Permission.ID.create("per_test"),
    sessionID: Session.ID.make("ses_test"),
    action: "read",
    resources: ["src/index.ts"],
    ...input,
  } satisfies Permission.AssertInput
}

function waitForRequest(input: Partial<Permission.AssertInput> = {}) {
  return Effect.gen(function* () {
    const service = yield* Permission.Service
    const events = yield* EventRuntime.Service
    const asked = yield* Deferred.make<Permission.Request>()
    const value = assertion(input)
    const unsubscribe = yield* events.listen((event) =>
      event.type === Permission.Event.Asked.type &&
      Schema.is(Permission.Request)(event.data) &&
      event.data.id === value.id
        ? Deferred.succeed(asked, event.data as Permission.Request).pipe(Effect.asVoid)
        : Effect.void,
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    const fiber = yield* service.assert(value).pipe(Effect.forkScoped)
    const request = yield* Effect.race(
      Deferred.await(asked),
      Fiber.join(fiber).pipe(Effect.as(undefined)),
    )
    if (!request) return yield* Effect.die(new Error("Permission settled without a prompt"))
    return { service, fiber, request }
  })
}

describe("Permission", () => {
  it.effect("system temp scope settles without an outside-directory ask while preserving explicit denies and ceilings", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "external_directory", resource: "*", effect: "ask" }])
      const service = yield* Permission.Service
      const input = assertion({ action: "external_directory", resources: ["/private/tmp/ycoding-scope/*"] })
      expect(yield* service.ask(input)).toMatchObject({ effect: "allow" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([{ action: "external_directory", resource: "*", effect: "deny" }])
      expect(yield* service.ask(input)).toMatchObject({ effect: "deny" })
      yield* setRules([{ action: "external_directory", resource: "*", effect: "ask" }])
      const database = yield* Database.Service
      yield* database.db.update(SessionTable).set({
        permission: SessionPermissionCeiling.denyOnly([{ action: "external_directory", resource: "*", effect: "deny" }]),
      }).where(eq(SessionTable.id, Session.ID.make("ses_test"))).run().pipe(Effect.orDie)
      expect(yield* service.ask(input)).toMatchObject({ effect: "deny" })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("assert waits for an explicit human reply when approval is mandatory", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const { service, fiber, request } = yield* waitForRequest({ requireHuman: true })
      expect(request.metadata?.requireHuman).toBe(true)
      yield* service.reply({ requestID: request.id, reply: "once" })
      yield* Fiber.join(fiber)
    }),
  )

  it.effect("requires a one-shot human decision despite allow rules, saved approvals, and automation", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* Permission.Service
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.set({ sessionID: Session.ID.make("ses_test"), autoPermission: true })
      yield* autonomy.setYolo({ sessionID: Session.ID.make("ses_test"), yolo: true })
      const value = assertion({ requireHuman: true, save: ["src/*"] })
      expect(yield* service.ask(value)).toEqual({ id: value.id, effect: "ask" })
      expect((yield* service.get(value.id))?.save).toBeUndefined()
      yield* service.reply({ requestID: value.id, reply: "once" })
      yield* setRules([])
      const next = assertion({ id: Permission.ID.create("per_next"), requireHuman: true })
      expect(yield* service.ask(next)).toEqual({ id: next.id, effect: "ask" })
      yield* service.reply({ requestID: next.id, reply: "reject" })
    }),
  )

  it.effect("remembered replies never settle another human-required request", () =>
    Effect.gen(function* () {
      yield* setup([])
      const service = yield* Permission.Service
      const ordinary = assertion({ save: ["src/*"] })
      const human = assertion({ id: Permission.ID.create("per_human"), requireHuman: true, save: ["src/*"] })
      yield* service.ask(ordinary)
      yield* service.ask(human)
      yield* service.reply({ requestID: ordinary.id, reply: "always" })
      expect((yield* service.list()).map((request) => request.id)).toEqual([human.id])
      yield* service.reply({ requestID: human.id, reply: "once" })
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      expect((yield* service.ask(assertion({ requireHuman: true }))).effect).toBe("deny")
    }),
  )

  it.effect("returns the evaluated effect and only queues prompts", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* Permission.Service
      expect(yield* service.ask(assertion())).toEqual({ id: Permission.ID.create("per_test"), effect: "allow" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion())).toEqual({ id: Permission.ID.create("per_test"), effect: "deny" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([])
      expect(yield* service.ask(assertion())).toEqual({ id: Permission.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(Permission.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("auto allows ask decisions only with the autoPermission rule flag and records the rule fact", () =>
    Effect.gen(function* () {
      yield* setup()
      const autonomy = yield* SessionAutonomy.Service
      const service = yield* Permission.Service
      const sessionID = Session.ID.make("ses_test")
      yield* autonomy.setYolo({ sessionID, yolo: true })
      expect(yield* service.ask(assertion())).toEqual({ id: Permission.ID.create("per_test"), effect: "ask" })
      yield* service.reply({ requestID: Permission.ID.create("per_test"), reply: "once" })
      yield* autonomy.setYolo({ sessionID, yolo: false })
      yield* autonomy.set({ sessionID, autoPermission: true })
      expect(yield* service.ask(assertion())).toEqual({ id: Permission.ID.create("per_test"), effect: "allow" })
      yield* service.assert(assertion())
      expect(yield* service.list()).toEqual([])
      const events = yield* EventRuntime.Service
      const assessed = (yield* events.log({ aggregateID: sessionID, follow: false }).pipe(Stream.runCollect)).filter(
        (event) => event.type === "session.permission.assessed",
      )
      expect(assessed.flatMap((event) => "data" in event ? [event.data] : [])).toEqual([
        expect.objectContaining({ sessionID, outcome: "allow", via: "auto-permission", reply: "once" }),
        expect.objectContaining({ sessionID, outcome: "allow", via: "auto-permission", reply: "once" }),
      ])
    }),
  )

  it.effect("an active goal does not auto allow ask decisions at YOLO 0", () =>
    Effect.gen(function* () {
      yield* setup()
      const autonomy = yield* SessionAutonomy.Service
      const service = yield* Permission.Service
      yield* autonomy.setGoal({ sessionID: Session.ID.make("ses_test"), text: "Ship safely" })
      expect(yield* service.ask(assertion())).toEqual({ id: Permission.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(Permission.ID.create("per_test"))).toBeDefined()
      yield* service.reply({ requestID: Permission.ID.create("per_test"), reply: "once" })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("preserves explicit deny rules in yolo mode", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "deny" }])
      const autonomy = yield* SessionAutonomy.Service
      const service = yield* Permission.Service
      yield* autonomy.setMode({ sessionID: Session.ID.make("ses_test"), mode: "yolo" })

      expect(yield* service.ask(assertion())).toMatchObject({ effect: "deny" })
      expect(yield* service.assert(assertion()).pipe(Effect.flip)).toBeInstanceOf(Permission.BlockedError)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("preserves the session permission ceiling in goal mode", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const { db } = yield* Database.Service
      const autonomy = yield* SessionAutonomy.Service
      const service = yield* Permission.Service
      yield* db
        .update(SessionTable)
        .set({
          permission: SessionPermissionCeiling.denyOnly([{ action: "read", resource: "src/*", effect: "deny" }]),
        })
        .where(eq(SessionTable.id, Session.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      yield* autonomy.setGoal({ sessionID: Session.ID.make("ses_test"), text: "Ship safely" })

      expect(yield* service.ask(assertion())).toMatchObject({ effect: "deny" })
      expect(yield* service.ask(assertion({ resources: ["README.md"] }))).toMatchObject({ effect: "allow" })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("evaluates against an explicit provider-turn agent", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const agents = yield* Agent.Service
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("reviewer"), (agent) => {
          agent.permissions.push({ action: "read", resource: "*", effect: "deny" })
        }),
      )
      const service = yield* Permission.Service

      expect(yield* service.ask(assertion())).toMatchObject({ effect: "allow" })
      expect(yield* service.ask(assertion({ agent: Agent.ID.make("reviewer") }))).toMatchObject({ effect: "deny" })
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("reviewer"), (agent) => {
          agent.permissions = []
        }),
      )
      expect(yield* service.ask(assertion({ agent: Agent.ID.make("reviewer") }))).toMatchObject({ effect: "ask" })
      expect(yield* service.get(Permission.ID.create("per_test"))).not.toHaveProperty("agent")
    }),
  )

  it.effect("allows and denies from explicit rules without asking", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* Permission.Service
      yield* service.assert(assertion())
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      const blocked = yield* service.assert(assertion()).pipe(Effect.flip)
      expect(blocked).toBeInstanceOf(Permission.BlockedError)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("enforces the session ceiling after agent allows and remembered approvals", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({
          permission: SessionPermissionCeiling.denyOnly([{ action: "read", resource: "src/*", effect: "deny" }]),
        })
        .where(eq(SessionTable.id, Session.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ projectID: Project.ID.global, action: "read", resources: ["src/index.ts"] })

      const service = yield* Permission.Service
      expect(yield* service.ask(assertion())).toMatchObject({ effect: "deny" })
      expect(yield* service.ask(assertion({ resources: ["README.md"] }))).toMatchObject({ effect: "allow" })
    }),
  )

  it.effect("exposes the same effective decision used by permission enforcement", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "subagent", resource: "reviewer", effect: "allow" }])
      const sessionID = Session.ID.make("ses_test")

      expect(
        yield* Permission.evaluateEffective({
          sessionID,
          agent: Agent.ID.make("test"),
          action: "subagent",
          resource: "reviewer",
        }),
      ).toBe("allow")
      expect(
        yield* Permission.evaluateEffective({
          sessionID,
          agent: Agent.ID.make("test"),
          action: "subagent",
          resource: "analyst",
        }),
      ).toBe("ask")

      const saved = yield* PermissionSaved.Service
      yield* saved.add({ projectID: Project.ID.global, action: "subagent", resources: ["analyst"] })
      expect(
        yield* Permission.evaluateEffective({
          sessionID,
          agent: Agent.ID.make("test"),
          action: "subagent",
          resource: "analyst",
        }),
      ).toBe("allow")

      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({
          permission: SessionPermissionCeiling.denyOnly([{ action: "subagent", resource: "reviewer", effect: "deny" }]),
        })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      expect(
        yield* Permission.evaluateEffective({
          sessionID,
          agent: Agent.ID.make("test"),
          action: "subagent",
          resource: "reviewer",
        }),
      ).toBe("deny")
    }),
  )

  it.effect("allows managed output reads without granting external directory access", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
      ])
      const service = yield* Permission.Service

      expect(yield* service.ask(assertion({ resources: ["tool_123"] }))).toMatchObject({ effect: "allow" })
      expect(
        yield* service.ask(assertion({ action: "external_directory", resources: ["/tmp/tool-output/*"] })),
      ).toMatchObject({ effect: "deny" })
    }),
  )

  it.effect("uses default primary agent permissions when the Session agent is omitted", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, Session.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* Agent.Service
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("test"), (agent) => {
          agent.permissions = [{ action: "custom", resource: "*", effect: "allow" }]
        }),
      )

      const service = yield* Permission.Service
      expect(yield* service.ask(assertion({ action: "custom", resources: ["*"] }))).toEqual({
        id: Permission.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("denies omitted-agent permissions when no primary default agent exists", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, Session.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* Agent.Service
      yield* agents.transform((editor) => {
        editor.remove(Agent.ID.make("test"))
        editor.remove(Agent.ID.make("build"))
      })

      const service = yield* Permission.Service
      expect(yield* service.ask(assertion())).toEqual({ id: Permission.ID.create("per_test"), effect: "deny" })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("evaluates bash with the normal configured-rule semantics", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const service = yield* Permission.Service
      const bash = assertion({ action: "bash", resources: ["pwd"] })
      expect(yield* service.ask(bash)).toEqual({ id: Permission.ID.create("per_test"), effect: "allow" })

      yield* setRules([])
      expect(yield* service.ask(bash)).toEqual({ id: Permission.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(Permission.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("uses saved bash approvals while preserving configured deny precedence", () =>
    Effect.gen(function* () {
      yield* setup()
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ projectID: Project.ID.global, action: "bash", resources: ["pwd"] })

      const service = yield* Permission.Service
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        id: Permission.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])

      yield* setRules([{ action: "bash", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        id: Permission.ID.create("per_test"),
        effect: "deny",
      })
    }),
  )

  it.effect("resolves an asked permission once", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      expect(yield* service.list()).toEqual([request])
      expect(yield* service.forSession(request.sessionID)).toEqual([request])
      expect(yield* service.forSession(Session.ID.make("ses_other"))).toEqual([])
      expect(yield* service.get(request.id)).toEqual(request)
      yield* service.reply({ requestID: request.id, reply: "once" })
      yield* Fiber.join(fiber)
      expect(yield* service.list()).toEqual([])
      expect(yield* service.get(request.id)).toBeUndefined()
    }),
  )

  it.effect("defects when an asked permission is declined", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      yield* service.reply({ requestID: request.id, reply: "reject" })
      const exit = yield* Fiber.await(fiber)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure")
        expect(
          exit.cause.reasons.some(
            (reason) => Cause.isDieReason(reason) && reason.defect instanceof Permission.DeclinedError,
          ),
        ).toBe(true)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("rejects only the selected concurrent request when request scope is explicit", () =>
    Effect.gen(function* () {
      yield* setup()
      const first = yield* waitForRequest()
      const second = yield* waitForRequest({ id: Permission.ID.create("per_second") })
      const events = yield* EventRuntime.Service
      const replied: Permission.ID[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === Permission.Event.Replied.type)
            replied.push(Schema.decodeUnknownSync(Schema.Struct({ requestID: Permission.ID }))(event.data).requestID)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      yield* first.service.reply({ requestID: first.request.id, reply: "reject", rejectScope: "request" })

      const exit = yield* Fiber.await(first.fiber)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure")
        expect(
          exit.cause.reasons.some(
            (reason) => Cause.isDieReason(reason) && reason.defect instanceof Permission.DeclinedError,
          ),
        ).toBe(true)
      expect(yield* first.service.list()).toEqual([second.request])
      expect(replied).toEqual([first.request.id])
      yield* second.service.reply({ requestID: second.request.id, reply: "once" })
      yield* Fiber.join(second.fiber)
      expect(yield* first.service.list()).toEqual([])
    }),
  )

  for (const rejectScope of [undefined, "session"] as const) {
    it.effect(`rejects every same-Session request with ${rejectScope ?? "default"} scope`, () =>
      Effect.gen(function* () {
        yield* setup()
        const database = yield* Database.Service
        yield* database.db
          .insert(SessionTable)
          .values({
            id: Session.ID.make("ses_other"),
            project_id: Project.ID.global,
            directory: "/project",
            title: "other",
            agent: "test",
          })
          .run()
          .pipe(Effect.orDie)
        const first = yield* waitForRequest()
        const second = yield* waitForRequest({ id: Permission.ID.create("per_second") })
        const other = yield* waitForRequest({
          id: Permission.ID.create("per_other"),
          sessionID: Session.ID.make("ses_other"),
        })

        yield* first.service.reply({ requestID: first.request.id, reply: "reject", rejectScope })

        expect((yield* Fiber.await(first.fiber))._tag).toBe("Failure")
        expect((yield* Fiber.await(second.fiber))._tag).toBe("Failure")
        expect(yield* first.service.list()).toEqual([other.request])
        yield* other.service.reply({ requestID: other.request.id, reply: "once" })
        yield* Fiber.join(other.fiber)
      }),
    )
  }

  it.effect("clears a pending permission when the Session switches agents", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest({ agent: Agent.ID.make("test") })
      const events = yield* EventRuntime.Service
      const replied = yield* Deferred.make<Permission.ReplyInput>()
      const unsubscribe = yield* events.listen((event) =>
        event.type === Permission.Event.Replied.type
          ? Deferred.succeed(replied, event.data as Permission.ReplyInput).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      yield* events.publish(SessionEvent.AgentSelected, {
        sessionID: Session.ID.make("ses_test"),
        agent: Agent.ID.make("build"),
      })
      yield* Effect.yieldNow

      expect(yield* service.list()).toEqual([])
      expect(yield* service.get(request.id)).toBeUndefined()
      expect(yield* Deferred.await(replied)).toMatchObject({ requestID: request.id, reply: "reject" })
      const exit = yield* Fiber.await(fiber)
      expect(exit._tag).toBe("Failure")
    }),
  )

  it.effect("stores and removes saved resources for a project", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* Permission.Service
      const asked = yield* Deferred.make<Permission.Request>()
      const events = yield* EventRuntime.Service
      const unsubscribe = yield* events.listen((event) =>
        event.type === Permission.Event.Asked.type
          ? Deferred.succeed(asked, event.data as Permission.Request).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const fiber = yield* service.assert(assertion({ save: ["src/*"] })).pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)
      yield* service.reply({ requestID: request.id, reply: "always" })
      yield* Fiber.join(fiber)

      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(PermissionTable).where(eq(PermissionTable.project_id, Project.ID.global)).all(),
      ).toMatchObject([{ action: "read", resource: "src/*" }])
      const saved = yield* PermissionSaved.Service
      const id = (yield* saved.list())[0]!.id
      expect(yield* saved.list()).toEqual([{ id, projectID: Project.ID.global, action: "read", resource: "src/*" }])
      yield* service.assert(assertion({ id: Permission.ID.create("per_next"), resources: ["src/next.ts"] }))
      yield* saved.remove(id)
      expect(yield* saved.list()).toEqual([])
    }),
  )
})
