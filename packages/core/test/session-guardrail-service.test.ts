import path from "path"
import { describe, expect } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { Session } from "@ycoding-ai/schema/session"
import { Config } from "@ycoding-ai/core/config"
import { ConfigGuardrail } from "@ycoding-ai/core/config/guardrail"
import { EventV2 } from "@ycoding-ai/core/event"
import { FSUtil } from "@ycoding-ai/core/fs-util"
import { Global } from "@ycoding-ai/core/global"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { Effect, Exit, Fiber, Layer } from "effect"
import { testEffect } from "./lib/effect"

const parentID = Session.ID.descending("ses_guardrail_service_parent")
const childID = Session.ID.descending("ses_guardrail_service_child")

function session(id: Session.ID, parentID?: Session.ID) {
  return { id, ...(parentID ? { parentID } : {}) } as Session.Info
}

function markdown(input: {
  readonly id: string
  readonly decision: Guardrail.RuleDecision
  readonly resource: string
  readonly priority?: number
}) {
  return `---
id: ${input.id}
decision: ${input.decision}
actions: [shell]
resources: ["${input.resource}"]
reason: ${input.id}
priority: ${input.priority ?? 0}
---
`
}

function harness(input?: {
  readonly entries?: ReadonlyArray<Config.Entry>
  readonly documents?: ReadonlyMap<string, string>
  readonly replyGate?: {
    readonly entered: PromiseWithResolvers<void>
    readonly release: PromiseWithResolvers<void>
  }
}) {
  const documents = new Map(input?.documents)
  const scans: Array<{ readonly pattern: string; readonly cwd: string | undefined }> = []
  let replyGated = false
  const filesystem = Layer.effect(
    FSUtil.Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      return FSUtil.Service.of({
        ...fs,
        scan: (pattern, options) =>
          Effect.sync(() => {
            scans.push({ pattern, cwd: options?.cwd })
            return Array.from(documents.keys()).filter((file) => path.dirname(file) === options?.cwd)
          }),
        readFileStringSafe: (file) => Effect.succeed(documents.get(file)),
      })
    }),
  ).pipe(Layer.provide(FSUtil.layer), Layer.provide(NodeFileSystem.layer))
  const dependencies = Layer.mergeAll(
    Layer.mock(Config.Service, { entries: () => Effect.succeed([...(input?.entries ?? [])]) }),
    filesystem,
    Global.layerWith({ config: "/global" }),
    Layer.mock(EventV2.Service, {
      publish: (definition, data) => {
        const gated = definition.type === Guardrail.Event.Replied.type && input?.replyGate && !replyGated
        if (gated) replyGated = true
        return (gated
          ? Effect.promise(async () => {
              input.replyGate!.entered.resolve()
              await input.replyGate!.release.promise
            })
          : Effect.void
        ).pipe(
          Effect.as({
            id: EventV2.ID.create(),
            type: definition.type,
            data,
          } as EventV2.Payload<typeof definition>),
        )
      },
    }),
    Layer.mock(SessionStore.Service, {
      get: (sessionID) =>
        Effect.succeed(
          new Map<Session.ID, Session.Info>([
            [parentID, session(parentID)],
            [childID, session(childID, parentID)],
          ]).get(sessionID),
        ),
    }),
  )
  return {
    documents,
    scans,
    it: testEffect(SessionGuardrail.layer.pipe(Layer.provide(dependencies))),
  }
}

const exact = harness()

const destructive = {
  sessionID: parentID,
  action: "shell",
  resources: ["git reset --hard HEAD~1", "ordered context"],
  metadata: { workdir: "/repo" },
} satisfies SessionGuardrail.EvaluateInput

const waitForRequest = Effect.fn("SessionGuardrailTest.waitForRequest")(function* (
  service: SessionGuardrail.Interface,
  input: SessionGuardrail.EvaluateInput,
) {
  const fiber = yield* service.assert(input).pipe(Effect.forkScoped)
  yield* Effect.yieldNow
  const request = (yield* service.forSession(input.sessionID))[0]
  if (!request) return yield* Effect.die("guardrail request was not created")
  return { fiber, request }
})

function reject(service: SessionGuardrail.Interface, input: SessionGuardrail.EvaluateInput) {
  return Effect.gen(function* () {
    const pending = yield* waitForRequest(service, input)
    yield* service.reply({ sessionID: input.sessionID, requestID: pending.request.id, reply: "reject" })
    const exit = yield* Fiber.await(pending.fiber)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain("Guardrail.DeclinedError")
  })
}

describe("SessionGuardrail reusable approvals", () => {
  exact.it.effect("reuses always only for the exact action, ordered rules, resources, and metadata in one family", () =>
    Effect.gen(function* () {
      const service = yield* SessionGuardrail.Service
      const pending = yield* waitForRequest(service, destructive)
      yield* service.reply({ sessionID: parentID, requestID: pending.request.id, reply: "always" })
      const first = yield* Fiber.join(pending.fiber)
      yield* first.release

      const child = yield* service.assert({ ...destructive, sessionID: childID })
      yield* child.release
      expect(yield* service.forSession(childID)).toEqual([])

      yield* reject(service, { ...destructive, resources: ["git reset --hard HEAD~2", "ordered context"] })
      yield* reject(service, { ...destructive, resources: destructive.resources.toReversed() })
      yield* reject(service, { ...destructive, action: "mcp_execute" })
      yield* reject(service, { ...destructive, metadata: { workdir: "/other" } })
    }),
  )

  exact.it.effect("does not reuse once and reject declines the waiting assertion", () =>
    Effect.gen(function* () {
      const service = yield* SessionGuardrail.Service
      const pending = yield* waitForRequest(service, destructive)
      yield* service.reply({ sessionID: parentID, requestID: pending.request.id, reply: "once" })
      const reservation = yield* Fiber.join(pending.fiber)
      yield* reservation.release

      yield* reject(service, destructive)
    }),
  )

  exact.it.effect("keys Always to the metadata snapshot that was reviewed", () =>
    Effect.gen(function* () {
      const service = yield* SessionGuardrail.Service
      const metadata = { identity: { workdir: "/repo" } }
      const input = { ...destructive, metadata }
      const pending = yield* waitForRequest(service, input)
      metadata.identity.workdir = "/other"
      yield* service.reply({ sessionID: parentID, requestID: pending.request.id, reply: "always" })
      const reservation = yield* Fiber.join(pending.fiber)
      yield* reservation.release

      const reused = yield* service.assert({ ...destructive, metadata: { identity: { workdir: "/repo" } } })
      yield* reused.release
      expect(yield* service.forSession(parentID)).toEqual([])
    }),
  )
})

const replyGate = {
  entered: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
}
const competingReplies = harness({ replyGate })

competingReplies.it.effect("accepts only the first concurrent reply and does not retain a losing Always", () =>
  Effect.gen(function* () {
    const service = yield* SessionGuardrail.Service
    const pending = yield* waitForRequest(service, destructive)
    const first = yield* service
      .reply({ sessionID: parentID, requestID: pending.request.id, reply: "reject" })
      .pipe(Effect.forkScoped)
    yield* Effect.promise(() => replyGate.entered.promise)
    const duplicate = yield* service
      .reply({ sessionID: parentID, requestID: pending.request.id, reply: "always" })
      .pipe(
        Effect.as("accepted" as const),
        Effect.catch((error) => Effect.succeed(error)),
      )
    replyGate.release.resolve()
    yield* Fiber.join(first)
    const operation = yield* Fiber.await(pending.fiber)
    if (Exit.isSuccess(operation)) yield* operation.value.release

    expect(duplicate).toMatchObject({ _tag: "Guardrail.RequestNotFoundError" })
    yield* reject(service, destructive)
  }),
)

const interruptionGate = {
  entered: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
}
const interruptedReply = harness({ replyGate: interruptionGate })

interruptedReply.it.effect("settles the guarded operation when the winning reply is interrupted", () =>
  Effect.gen(function* () {
    const service = yield* SessionGuardrail.Service
    const pending = yield* waitForRequest(service, destructive)
    const reply = yield* service
      .reply({ sessionID: parentID, requestID: pending.request.id, reply: "reject" })
      .pipe(Effect.forkScoped)
    yield* Effect.promise(() => interruptionGate.entered.promise)
    const interruption = yield* Fiber.interrupt(reply).pipe(Effect.forkScoped)
    yield* Effect.yieldNow
    interruptionGate.release.resolve()
    yield* Fiber.join(interruption)

    const operation = yield* Fiber.await(pending.fiber).pipe(Effect.timeout("100 millis"))
    expect(Exit.isFailure(operation)).toBe(true)
    expect(yield* service.forSession(parentID)).toEqual([])
  }),
)

const changingRule = harness({
  entries: [new Config.Directory({ type: "directory", path: AbsolutePath.make("/global") })],
  documents: new Map([
    [
      "/global/guardrails/review.md",
      markdown({ id: "first-rule", decision: "ask", resource: "deploy exact" }),
    ],
  ]),
})

const disabled = harness({
  entries: [
    new Config.Document({
      type: "document",
      info: new Config.Info({ guardrails: new ConfigGuardrail.Info({ enabled: false }) }),
    }),
  ],
})

disabled.it.effect("keeps catastrophic standard denies active when configurable guardrails are disabled", () =>
  Effect.gen(function* () {
    const service = yield* SessionGuardrail.Service
    const error = yield* Effect.flip(service.assert({ ...destructive, resources: ["rm -rf /"] }))
    expect(error._tag).toBe("Guardrail.BlockedError")
  }),
)

changingRule.it.effect("re-evaluates policy and does not reuse always after matched rule IDs change", () =>
  Effect.gen(function* () {
    const service = yield* SessionGuardrail.Service
    const input = { sessionID: parentID, action: "shell", resources: ["deploy exact"] } as const
    changingRule.documents.set(
      "/global/guardrails/review.md",
      markdown({ id: "first-rule", decision: "ask", resource: "deploy exact" }),
    )
    const pending = yield* waitForRequest(service, input)
    yield* service.reply({ sessionID: parentID, requestID: pending.request.id, reply: "always" })
    const reservation = yield* Fiber.join(pending.fiber)
    yield* reservation.release

    changingRule.documents.set(
      "/global/guardrails/review.md",
      markdown({ id: "second-rule", decision: "ask", resource: "deploy exact" }),
    )
    yield* reject(service, input)
  }),
)

const discovery = harness({
  entries: [
    new Config.Directory({ type: "directory", path: AbsolutePath.make("/global") }),
    new Config.Directory({ type: "directory", path: AbsolutePath.make("/repo/.ycoding") }),
    new Config.Directory({ type: "directory", path: AbsolutePath.make("/repo/work/.ycoding") }),
  ],
  documents: new Map([
    [
      "/global/guardrails/allow-reset.md",
      markdown({ id: "user-allow-reset", decision: "allow", resource: "git reset --hard global" }),
    ],
    [
      "/global/guardrails/deny-publish.md",
      markdown({ id: "user-deny-publish", decision: "deny", resource: "npm publish exact" }),
    ],
    [
      "/repo/.ycoding/guardrails/deny-publish.md",
      markdown({ id: "broader-deny-publish", decision: "deny", resource: "npm publish exact" }),
    ],
    [
      "/repo/work/.ycoding/guardrails/allow-publish.md",
      markdown({ id: "nearest-allow-publish", decision: "allow", resource: "npm publish exact" }),
    ],
    [
      "/repo/work/.ycoding/guardrails/nested/ignored.md",
      markdown({ id: "nested-deny", decision: "deny", resource: "git reset --hard nested" }),
    ],
  ]),
})

const lexical = harness({
  documents: new Map([
    ["/global/guardrails/a.md", markdown({ id: "lowercase-allow", decision: "allow", resource: "echo exact" })],
    ["/global/guardrails/Z.md", markdown({ id: "uppercase-deny", decision: "deny", resource: "echo exact" })],
  ]),
})

lexical.it.effect("uses locale-independent lexical file order for equal-priority rules", () =>
  Effect.gen(function* () {
    const service = yield* SessionGuardrail.Service
    expect(
      yield* service.evaluate({ sessionID: parentID, action: "shell", resources: ["echo exact"] }),
    ).toMatchObject({ decision: "deny", ruleIDs: ["uppercase-deny"] })
  }),
)

discovery.it.effect("discovers nearest repository layers before broader and global top-level rules", () =>
  Effect.gen(function* () {
    const service = yield* SessionGuardrail.Service
    discovery.scans.length = 0
    expect(
      yield* service.evaluate({ sessionID: parentID, action: "shell", resources: ["npm publish exact"] }),
    ).toMatchObject({ decision: "allow", ruleIDs: ["nearest-allow-publish"] })
    expect(discovery.scans.slice(0, 3)).toEqual([
      { pattern: "*.md", cwd: "/repo/work/.ycoding/guardrails" },
      { pattern: "*.md", cwd: "/repo/.ycoding/guardrails" },
      { pattern: "*.md", cwd: "/global/guardrails" },
    ])

    expect(
      yield* service.evaluate({ sessionID: parentID, action: "shell", resources: ["git reset --hard global"] }),
    ).toMatchObject({ decision: "allow", ruleIDs: ["user-allow-reset"] })
    expect(
      yield* service.evaluate({ sessionID: parentID, action: "shell", resources: ["git reset --hard nested"] }),
    ).toMatchObject({ decision: "ask", ruleIDs: ["standard.review.git-destructive"] })
  }),
)
