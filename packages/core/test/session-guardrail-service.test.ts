import path from "path"
import { describe, expect } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { Agent } from "@ycoding-ai/core/agent"
import { Config } from "@ycoding-ai/core/config"
import { ConfigGuardrail } from "@ycoding-ai/core/config/guardrail"
import { Decision } from "@ycoding-ai/core/decision"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { FSUtil } from "@ycoding-ai/core/fs-util"
import { Global } from "@ycoding-ai/core/global"
import { Location } from "@ycoding-ai/core/location"
import { LocationMutation } from "@ycoding-ai/core/location-mutation"
import { Permission } from "@ycoding-ai/core/permission"
import { PermissionSaved } from "@ycoding-ai/core/permission/saved"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import type { Category, DecisionMode } from "@ycoding-ai/schema/session-autonomy"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { SessionReviewFold } from "@ycoding-ai/core/session/review-fold"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { ConfigAgentPlugin } from "@ycoding-ai/core/config/plugin/agent"
import { asc, sql } from "drizzle-orm"
import { ModelIncidentTable } from "@ycoding-ai/core/model-incident/sql"
import { EventSequenceTable, EventTable } from "@ycoding-ai/core/event/sql"
import { Deferred, Duration, Effect, Exit, Fiber, Layer, Schema, Scope } from "effect"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { TestClock } from "effect/testing"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { agentHost, host } from "./plugin/host"
import { it, testEffect } from "./lib/effect"

const home = path.resolve("/home/user").replaceAll("\\", "/")
const configDir = "/global"
const dataDir = "/ycoding/data"
const cacheDir = "/ycoding/cache"
const stateDir = "/ycoding/state"
const buildAgent = Agent.ID.make("build")

const parentID = Session.ID.descending("ses_guardrail_service_parent")
const childID = Session.ID.descending("ses_guardrail_service_child")

function session(id: Session.ID, parentID?: Session.ID, agent?: Agent.ID) {
  return { id, ...(parentID ? { parentID } : {}), ...(agent ? { agent } : {}) } as Session.Info
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
  readonly defaults?: boolean
  readonly entries?: ReadonlyArray<Config.Entry>
  readonly documents?: ReadonlyMap<string, string>
  readonly guardrails?: DecisionMode
  readonly onGuardrailsMode?: (mode: DecisionMode) => void
  readonly realAutonomy?: boolean
  readonly deferred?: boolean
  readonly deferStates?: Array<boolean>
  readonly failReply?: boolean
  readonly decision?: (input: Decision.Input) => Effect.Effect<Decision.Output, Decision.Error>
  readonly verify?: (input: Decision.Input) => Effect.Effect<Decision.Output, Decision.Error>
  readonly repositoryWorktrees?: ReadonlyArray<string>
  readonly rules?: Permission.Ruleset
  readonly saved?: ReadonlyArray<PermissionSaved.Info>
  readonly replyGate?: {
    readonly entered: PromiseWithResolvers<void>
    readonly release: PromiseWithResolvers<void>
  }
}) {
  const documents = new Map(Array.from(input?.documents ?? [], ([file, content]) => [path.normalize(file), content]))
  const scans: Array<{ readonly pattern: string; readonly cwd: string | undefined }> = []
  const choices: Decision.Input[] = []
  const verifications: Decision.Input[] = []
  const dismissals: unknown[] = []
  const replies: unknown[] = []
  const decisions: unknown[] = []
  const ruleDecisions: unknown[] = []
  const escalations: unknown[] = []
  const asked: Guardrail.Request[] = []
  let replyGated = false
  const agent = input?.rules === undefined ? undefined : buildAgent
  const permissionRules = input?.rules
  const filesystem = Layer.effect(
    FSUtil.Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      return FSUtil.Service.of({
        ...fs,
        scan: (pattern, options) =>
          Effect.sync(() => {
            scans.push({ pattern, cwd: options?.cwd })
            return Array.from(documents.keys()).filter((file) =>
              options?.cwd !== undefined && path.dirname(file) === path.normalize(options.cwd))
          }),
        readFileStringSafe: (file) => Effect.succeed(documents.get(path.normalize(file))),
      })
    }),
  ).pipe(Layer.provide(FSUtil.layer), Layer.provide(NodeFileSystem.layer))
  const storage = Layer.provideMerge(EventRuntime.layer, Database.layer({ path: ":memory:" }))
  const events = Layer.effect(
    EventRuntime.Service,
    Effect.gen(function* () {
      const runtime = yield* EventRuntime.Service
      return EventRuntime.Service.of({
        ...runtime,
        publish: (definition, data, options) => {
          if (definition.type === Guardrail.Event.Replied.type && input?.failReply) return Effect.die("Reply publication failed")
          if (definition.type === Guardrail.Event.Replied.type) replies.push(data)
          if (definition.type === "session.guardrail.decided") decisions.push(data)
          if (definition.type === Guardrail.Event.Decided.type) ruleDecisions.push(data)
          if (definition.type === "session.guardrail.dismissed") dismissals.push(data)
          if (definition.type === "session.guardrail.escalated") escalations.push(data)
          if (definition.type === "guardrail.asked") asked.push(Schema.decodeUnknownSync(Guardrail.Request)(data))
          const gated = definition.type === Guardrail.Event.Replied.type && input?.replyGate && !replyGated
          if (gated) replyGated = true
          return (
            gated
              ? Effect.promise(async () => {
                  input.replyGate!.entered.resolve()
                  await input.replyGate!.release.promise
                })
              : Effect.void
          ).pipe(Effect.andThen(runtime.publish(definition, data, options)))
        },
      })
    }),
  ).pipe(Layer.provide(storage))
  const sessions = Layer.mock(SessionStore.Service, {
    get: (sessionID) =>
      Effect.succeed(
        new Map<Session.ID, Session.Info>([
          [parentID, session(parentID, undefined, agent)],
          [childID, session(childID, parentID, agent)],
        ]).get(sessionID),
      ),
  })
  const autonomy = input?.realAutonomy ? SessionAutonomy.layer.pipe(Layer.provide(storage)) : Layer.mock(SessionAutonomy.Service, {
    decisionMode: (_sessionID: Session.ID, category: Category) =>
      Effect.sync(() => {
        const mode = category === "guardrails" ? (input?.guardrails ?? "manual") : "manual"
        if (category === "guardrails") input?.onGuardrailsMode?.(mode)
        return mode
      }),
    snapshot: () => Effect.succeed({ state: SessionAutonomy.defaultState, sequence: 0, digest: "mock" }),
    isDeferred: () => Effect.sync(() => input?.deferStates?.shift() ?? input?.deferred ?? false),
  } as unknown as SessionAutonomy.Interface)
  const locationLayer = Layer.succeed(
    Location.Service,
    Location.Service.of(
      location(
        { directory: AbsolutePath.make("/workspace/project") },
        { projectDirectory: AbsolutePath.make("/workspace/project") },
      ),
    ),
  )
  const global = Global.layerWith({ home, data: dataDir, config: configDir, cache: cacheDir, state: stateDir })
  const permission = AppNodeBuilder.build(LayerNode.group([Agent.node, Permission.node]), [
    [EventRuntime.node, events],
    [Location.node, locationLayer],
    [SessionStore.node, sessions],
    [SessionAutonomy.node, autonomy],
    [Decision.node, Layer.mock(Decision.Service, { evaluate: () => Effect.fail(new Decision.Error({ reason: "unavailable" })) })],
    [PermissionSaved.node, Layer.mock(PermissionSaved.Service, { list: () => Effect.succeed(input?.saved ?? []) })],
  ])
  const seed = permissionRules === undefined ? Layer.empty : Layer.effectDiscard(Effect.gen(function* () {
    const configured = yield* Agent.Service
    yield* configured.transform((draft) => {
      draft.update(buildAgent, (item) => {
        item.permissions = []
      })
    })
    yield* ConfigAgentPlugin.Plugin.effect(host({ agent: agentHost(configured) }))
  }))
  const dependencies = Layer.mergeAll(
    Layer.mock(Decision.Service, {
      evaluate: (request) => {
        if (request.request.questions[0]?.name === "guardrail_match") {
          verifications.push(request)
          return input?.verify?.(request) ?? Effect.succeed(verificationOutput(true, 1))
        }
        choices.push(request)
        if (input?.decision) return input.decision(request).pipe(Effect.map((output) => ({ ...output, response: { ...output.response,
          answers: output.response.answers.map((answer) => ({ ...answer,
            ...(answer.grades === undefined ? {} : { grades: answer.grades.filter((grade) => request.request.questions.some((question) =>
              question.type === "choice" && question.choices.some((choice) => choice.value === grade.choice))) }),
          })),
        } })))
        return Effect.succeed(decisionOutput("escalate", 1))
      },
    }),
    Layer.mock(Config.Service, {
      entries: () => Effect.succeed([
        ...(input?.defaults ? [] : [new Config.Document({ type: "document", info: Schema.decodeUnknownSync(Config.Info)({ guardrails: { decide_reviews: true } }) })]),
        ...(input?.entries ?? []).map((entry) => input?.defaults || entry.type !== "document" || entry.info.guardrails === undefined ? entry : new Config.Document({
          ...entry,
          info: Schema.decodeUnknownSync(Config.Info)({ ...entry.info, guardrails: { decide_reviews: true, ...entry.info.guardrails } }),
        })),
        ...(permissionRules === undefined ? [] : [new Config.Document({
          type: "document",
          info: Schema.decodeUnknownSync(Config.Info)({ permissions: permissionRules }),
        })]),
      ]),
    }),
    Layer.mock(LocationMutation.Service, {
      repositoryWorktree: (target) =>
        Effect.succeed((input?.repositoryWorktrees ?? []).some((root) => FSUtil.contains(path.resolve(root), target))),
    }),
    filesystem,
    global,
    locationLayer,
    storage,
    events,
    sessions,
    autonomy,
    permission,
  )
  return {
    documents,
    scans,
    choices,
    verifications,
    dismissals,
    replies,
    decisions,
    ruleDecisions,
    escalations,
    asked,
    it: testEffect(Layer.mergeAll(SessionGuardrail.layer, seed).pipe(Layer.provideMerge(dependencies))),
    seed: Effect.gen(function* () {
      const database = yield* Database.Service
      yield* database.db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/workspace/project"), sandboxes: [] }).onConflictDoNothing().run().pipe(Effect.orDie)
      yield* database.db.insert(SessionTable).values({ id: parentID, project_id: Project.ID.global, directory: "/workspace/project", title: "Graded reviews" }).onConflictDoNothing().run().pipe(Effect.orDie)
      const service = yield* SessionAutonomy.Service
      yield* service.set({ sessionID: parentID, guardrails: input?.guardrails ?? "manual", defer: input?.deferred ?? false })
    }),
  }
}

const exact = harness()

for (const mode of ["manual", "auto"] as const) for (const hardReview of [false, true]) {
  const classified = Promise.withResolvers<void>()
  const authority = { guardrails: "yolo" as DecisionMode, onGuardrailsMode: () => classified.resolve() }
  const revoked = harness(authority)
  revoked.it.effect(`revoked YOLO before root-lock admission restores ${mode} ${hardReview ? "hard review" : "deny"}`, () => Effect.gen(function* () {
    const service = yield* SessionGuardrail.Service
    const events = yield* EventRuntime.Service
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const asked = yield* Deferred.make<void>()
    const unlisten = yield* events.listen((event) => event.type === Guardrail.Event.Asked.type
      ? Deferred.succeed(asked, undefined).pipe(Effect.asVoid) : Effect.void)
    yield* Effect.addFinalizer(() => unlisten)
    const holder = yield* service.withSnapshot(parentID, () => Deferred.succeed(entered, undefined)
      .pipe(Effect.andThen(Deferred.await(release)))).pipe(Effect.forkScoped)
    yield* Deferred.await(entered)
    const waiting = yield* service.assert({ sessionID: childID, action: "shell", resources: [hardReview ? "rm -rf ." : "rm -rf /"] })
      .pipe(Effect.exit, Effect.forkScoped)
    yield* Effect.promise(() => classified.promise)
    expect(waiting.pollUnsafe()).toBeUndefined()
    authority.guardrails = mode
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(holder)
    if (hardReview) {
      yield* Effect.race(Fiber.join(waiting), Deferred.await(asked))
      const pending = yield* service.forSession(childID)
      if (pending.length === 0) {
        const result = yield* Fiber.join(waiting)
        if (Exit.isSuccess(result)) yield* result.value.release
      }
      expect(pending).toHaveLength(1)
      expect(pending[0]).toMatchObject({ hardReview: true, ruleIDs: ["standard.review.project-deletion"] })
      yield* service.reply({ sessionID: childID, requestID: pending[0]!.id, reply: "reject" })
    }
    const result = yield* Fiber.join(waiting)
    if (Exit.isSuccess(result)) yield* result.value.release
    expect(Exit.isFailure(result)).toBe(true)
    expect(yield* service.list()).toEqual([])
    const status = yield* service.status(parentID)
    expect(status.blocked).toBe(hardReview ? 0 : 1)
    expect(status.counters.every((counter) => counter.current === 0)).toBe(true)
    expect(revoked.choices).toEqual([])
    expect(revoked.verifications).toEqual([])
  }))
}

for (const [name, resources, documents, enabled] of [
  ["catastrophic standard deny", ["rm -rf /"], [], true],
  ["standard hard review", ["rm -rf ."], [], true],
  ["destructive git", ["git reset --hard HEAD~1"], [], true],
  ["custom deny", ["custom denied"], [["/global/guardrails/deny.md", markdown({ id: "deny", decision: "deny", resource: "*" })]], true],
  ["custom hard review", ["custom hard"], [["/global/guardrails/hard.md", markdown({ id: "hard", decision: "hard_review", resource: "*" })]], true],
  ["custom review", ["custom reviewed"], [["/global/guardrails/review.md", markdown({ id: "review", decision: "ask", resource: "*" })]], true],
  ["invalid configuration", ["task-runner build"], [["/global/guardrails/invalid.md", "---\ndecision: invalid\n---\n"]], true],
  ["disabled hard fallback", ["rm -rf /"], [], false],
] as const) {
  const yolo = harness({ guardrails: "yolo", documents: new Map(documents),
    entries: [new Config.Document({ type: "document", info: Schema.decodeUnknownSync(Config.Info)({ guardrails: { enabled, decide_reviews: false, decide_hard_reviews: false } }) })],
    decision: () => Effect.die("YOLO must not evaluate"), verify: () => Effect.die("YOLO must not verify"),
  })
  yolo.it.effect(`True YOLO admits ${name} before classification`, () => Effect.gen(function* () {
    const service = yield* SessionGuardrail.Service
    const input = { sessionID: childID, action: "shell", resources, defer: true as const }
    expect(yield* service.evaluate(input)).toMatchObject({ decision: "allow", ruleIDs: [], hardReview: false })
    const reservation = yield* service.assert(input)
    expect(yield* service.list()).toEqual([])
    expect(yolo.choices).toEqual([])
    expect(yolo.verifications).toEqual([])
    expect(yolo.scans).toEqual([])
    expect((yield* service.status(parentID)).counters.find((counter) => counter.id === "shells")?.current).toBe(1)
    yield* reservation.release
  }))
}

const reconcileYolo = harness({ guardrails: "manual", realAutonomy: true })
reconcileYolo.it.effect("True YOLO reconciles hard pending reviews once and withdraws deferred items without replay", () => Effect.gen(function* () {
  yield* reconcileYolo.seed
  const service = yield* SessionGuardrail.Service
  const autonomy = yield* SessionAutonomy.Service
  const { db } = yield* Database.Service
  const input = { sessionID: parentID, action: "shell", resources: ["rm -rf ."] }
  expect(Exit.isFailure(yield* service.assert({ ...input, defer: true }).pipe(Effect.exit))).toBe(true)
  const waiting = yield* waitForRequest(service, input)
  yield* autonomy.set({ sessionID: parentID, guardrails: "yolo" })
  yield* service.reconcileAutonomy(parentID)
  yield* service.reconcileAutonomy(parentID)
  yield* (yield* Fiber.join(waiting.fiber)).release
  expect(yield* service.list()).toEqual([])
  expect((yield* SessionReviewFold.fold(db, [parentID]))[0]).toMatchObject({ withdrawn: "autonomy", consumed: false })
  expect(reconcileYolo.replies).toEqual([expect.objectContaining({ requestID: waiting.request.id, reply: "once" })])
  expect((yield* service.status(parentID)).counters.every((counter) => counter.current === 0)).toBe(true)
}))

exact.it.effect("outside mutations, shell paths and cd require ordinary review without a classifier", () => Effect.gen(function* () {
  const service = yield* SessionGuardrail.Service
  for (const input of [
    { action: "file_mutation", resources: ["/outside/file"], metadata: { operation: "write" } },
    { action: "file_mutation", resources: ["/outside/file"], metadata: { operation: "patch" } },
    { action: "shell", resources: ["cd /outside && task-runner execute"] },
    { action: "shell", resources: ["touch /outside/file"] },
  ]) expect(yield* service.evaluate({ sessionID: parentID, ...input })).toMatchObject({
    decision: "ask", hardReview: false, ruleIDs: ["standard.review.outside-repo"],
  })
  expect(exact.choices).toHaveLength(0)
}))

const managed = harness({ repositoryWorktrees: ["/data/worktrees/repo_abc/feature", "/workspace/main", "/workspace/sibling"] })

managed.it.effect("treats this repository's main checkout and worktrees as inside and other directories as outside", () => Effect.gen(function* () {
  const service = yield* SessionGuardrail.Service
  for (const input of [
    { action: "file_mutation", resources: ["/data/worktrees/repo_abc/feature/src/a.ts"] },
    { action: "shell", resources: ["touch /data/worktrees/repo_abc/feature/src/a.ts"] },
    { action: "shell", resources: ["task-runner execute"], metadata: { workdir: "/data/worktrees/repo_abc/feature" } },
    { action: "file_mutation", resources: ["/workspace/main/src/a.ts"] },
    { action: "shell", resources: ["cp src/a.ts /workspace/sibling/src/a.ts"] },
    { action: "shell", resources: ["task-runner execute"], metadata: { workdir: "/workspace/main" } },
  ]) expect(yield* service.evaluate({ sessionID: parentID, ...input })).toMatchObject({ decision: "allow", hardReview: false })
  for (const resources of [["/data/worktrees/repo_abc/other/a.ts"], ["/workspace/other-repo/a.ts"], ["/workspace/main-other/a.ts"]])
    expect(yield* service.evaluate({ sessionID: parentID, action: "file_mutation", resources }))
      .toMatchObject({ decision: "ask", hardReview: false, ruleIDs: ["standard.review.outside-repo"] })
  expect(yield* service.evaluate({ sessionID: parentID, action: "shell", resources: ["cp /workspace/main/a /workspace/other-repo/a"] }))
    .toMatchObject({ decision: "ask", hardReview: false, ruleIDs: ["standard.review.outside-repo"] })
  expect(managed.choices).toHaveLength(0)
}))

const savedDirectory = harness({
  rules: [],
  saved: [{ id: PermissionSaved.ID.make("per_saved"), projectID: Project.ID.make("prj_saved"), action: "external_directory", resource: path.join(path.resolve("/outside/repo"), "*") }],
})

savedDirectory.it.effect("exempts outside paths covered by a saved external_directory Always reply", () => Effect.gen(function* () {
  const service = yield* SessionGuardrail.Service
  for (const input of [
    { action: "file_mutation", resources: ["/outside/repo/src/a.ts"] },
    { action: "shell", resources: ["touch /outside/repo/src/a.ts"] },
  ]) expect(yield* service.evaluate({ sessionID: parentID, ...input })).toMatchObject({ decision: "allow", ruleIDs: [] })
  expect(yield* service.evaluate({ sessionID: parentID, action: "file_mutation", resources: ["/outside/elsewhere/a.ts"] }))
    .toMatchObject({ decision: "ask", hardReview: false, ruleIDs: ["standard.review.outside-repo"] })
}))

exact.it.effect("allows file mutations inside the global config directory", () => Effect.gen(function* () {
  const service = yield* SessionGuardrail.Service
  for (const resources of [[configDir], [`${configDir}/settings.json`], [`${configDir}/nested/settings.json`]])
    expect(yield* service.evaluate({ sessionID: parentID, action: "file_mutation", resources })).toMatchObject({
      decision: "allow", hardReview: false, ruleIDs: [],
    })
}))

exact.it.effect("allows file mutations inside the global data, cache, and state directories", () => Effect.gen(function* () {
  const service = yield* SessionGuardrail.Service
  for (const resources of [
    [`${dataDir}/db`],
    [`${dataDir}/repos/example`],
    [`${cacheDir}/bin/tool`],
    [`${stateDir}/session`],
  ]) expect(yield* service.evaluate({ sessionID: parentID, action: "file_mutation", resources })).toMatchObject({
    decision: "allow", hardReview: false, ruleIDs: [],
  })
}))

exact.it.effect("admits YCoding-managed tool operations without a review request", () => Effect.gen(function* () {
  const service = yield* SessionGuardrail.Service
  const inputs: ReadonlyArray<Omit<SessionGuardrail.EvaluateInput, "sessionID">> = [
    { action: "file_mutation", resources: [`${dataDir}/worktrees/repo_abc/feature`], metadata: { operation: "create_git_worktree" } },
    { action: "file_mutation", resources: [`${dataDir}/memory/repo_abc`], metadata: { operation: "write", memoryAction: "write" } },
    { action: "file_mutation", resources: [`${dataDir}/memory/knowledge`], metadata: { operation: "remove", memoryAction: "delete" } },
    { action: "project_artifact_mutation", resources: ["skill/example"], metadata: { operation: "automatic_write" } },
    { action: "subagent", resources: ["build"], metadata: { description: "task" } },
    { action: "mcp_execute", resources: ["server/tool"], metadata: { arguments: [] } },
    { action: "shell", resources: [`git worktree add -b feature ${dataDir}/worktrees/repo_abc/feature`] },
    { action: "shell", resources: [`mkdir -p ${dataDir}/worktrees/repo_abc && git worktree add -b feature ${dataDir}/worktrees/repo_abc/feature`] },
    { action: "file_mutation", resources: [`${dataDir}/worktrees/repo_other/feature/src/a.ts`] },
    { action: "shell", resources: [`git -C ${dataDir}/worktrees/repo_abc/feature add -A`] },
  ]
  for (const input of inputs) {
    expect(yield* service.evaluate({ sessionID: parentID, ...input })).toMatchObject({ decision: "allow", ruleIDs: [] })
    yield* (yield* service.assert({ sessionID: parentID, ...input })).release
  }
  expect(yield* service.forSession(parentID)).toEqual([])
}))

const oneShell = harness({
  entries: [new Config.Document({
    type: "document",
    info: new Config.Info({ guardrails: new ConfigGuardrail.Info({ max_concurrent_shells: 1, shell_wait_seconds: 5 }) }),
  })],
})
const shellInput = (holder: string) => ({ sessionID: parentID, action: "shell", resources: ["task-runner build"], holder })
const shellsRunning = (service: SessionGuardrail.Interface) =>
  service.status(parentID).pipe(Effect.map((status) => status.counters.find((counter) => counter.id === "shells")?.current))
const adjustUntilDone = <A, E>(fiber: Fiber.Fiber<A, E>, step: Duration.Input, limit: number): Effect.Effect<A, E> =>
  fiber.pollUnsafe() === undefined && limit > 0
    ? TestClock.adjust(step).pipe(Effect.andThen(Effect.suspend(() => adjustUntilDone(fiber, step, limit - 1))))
    : Fiber.join(fiber)

describe("SessionGuardrail shell capacity", () => {
  oneShell.it.effect("a shell over the family limit waits for a running shell to finish, then runs", () => Effect.gen(function* () {
    const service = yield* SessionGuardrail.Service
    const running = yield* service.assert(shellInput("call-running"))
    const waiting = yield* service.assert(shellInput("call-waiting")).pipe(Effect.forkChild({ startImmediately: true }))
    for (const _ of [1, 2, 3]) yield* TestClock.adjust("1 second")
    expect(waiting.pollUnsafe()).toBeUndefined()
    expect(yield* shellsRunning(service)).toBe(1)
    yield* running.release
    const granted = yield* Fiber.join(waiting)
    expect(yield* shellsRunning(service)).toBe(1)
    yield* granted.release
    expect(yield* shellsRunning(service)).toBe(0)
    expect(yield* service.forSession(parentID)).toEqual([])
  }))

  oneShell.it.effect("fails after the configured wait with the limit, running holders, and setting", () => Effect.gen(function* () {
    const service = yield* SessionGuardrail.Service
    const running = yield* service.assert(shellInput("call-running"))
    const waiting = yield* service.assert(shellInput("call-waiting")).pipe(Effect.flip, Effect.forkChild({ startImmediately: true }))
    const error = yield* adjustUntilDone(waiting, "1 second", 20)
    expect(error).toMatchObject({ _tag: "Guardrail.CapExceededError", counter: "shells", current: 1, limit: 1, waitedMs: 5_000 })
    expect(error.message).toBe(
      "Shell limit reached: 1/1 shells running in this session family (call-running); waited 5s. Wait for or stop a running shell, or raise guardrails.max_concurrent_shells.",
    )
    expect(yield* shellsRunning(service)).toBe(1)
    yield* running.release
    expect(yield* shellsRunning(service)).toBe(0)
  }))

  oneShell.it.effect("interrupting a waiting shell leaves the running count unchanged and the slot reusable", () => Effect.gen(function* () {
    const service = yield* SessionGuardrail.Service
    const running = yield* service.assert(shellInput("call-running"))
    const waiting = yield* service.assert(shellInput("call-waiting")).pipe(Effect.forkChild({ startImmediately: true }))
    for (const _ of [1, 2]) yield* TestClock.adjust("1 second")
    yield* Fiber.interrupt(waiting)
    expect(yield* shellsRunning(service)).toBe(1)
    yield* running.release
    expect(yield* shellsRunning(service)).toBe(0)
    yield* (yield* service.assert(shellInput("call-next"))).release
    expect(yield* shellsRunning(service)).toBe(0)
  }))
})

const allowedDirectory = harness({
  rules: [{ action: "external_directory", resource: "~/Downloads/**", effect: "allow" }],
})

allowedDirectory.it.effect("allows outside paths covered by an external_directory allow rule", () => Effect.gen(function* () {
  const service = yield* SessionGuardrail.Service
  for (const input of [
    { action: "file_mutation", resources: [`${home}/Downloads/a/b.txt`] },
    { action: "shell", resources: ["cd ~/Downloads && echo ok"] },
    { action: "shell", resources: ["touch ~/Downloads/a/b.txt"] },
  ]) expect(yield* service.evaluate({ sessionID: parentID, ...input })).toMatchObject({
    decision: "allow", hardReview: false, ruleIDs: [],
  })
}))

const askedDirectory = harness({
  rules: [{ action: "external_directory", resource: "~/Downloads/**", effect: "ask" }],
})
const unruledDirectory = harness({ rules: [] })

askedDirectory.it.effect("still reviews outside paths when external_directory asks or has no rule", () => Effect.gen(function* () {
  const asked = yield* SessionGuardrail.Service
  expect(yield* asked.evaluate({
    sessionID: parentID, action: "file_mutation", resources: [`${home}/Downloads/a/b.txt`],
  })).toMatchObject({ decision: "ask", hardReview: false, ruleIDs: ["standard.review.outside-repo"] })
}))

unruledDirectory.it.effect("still reviews outside paths when external_directory has no matching rule", () => Effect.gen(function* () {
  const service = yield* SessionGuardrail.Service
  expect(yield* service.evaluate({
    sessionID: parentID, action: "file_mutation", resources: [`${home}/Downloads/a/b.txt`],
  })).toMatchObject({ decision: "ask", hardReview: false, ruleIDs: ["standard.review.outside-repo"] })
}))

const deniedDirectory = harness({
  rules: [{ action: "external_directory", resource: "~/Downloads/**", effect: "deny" }],
})

deniedDirectory.it.effect("still reviews outside paths denied by external_directory", () => Effect.gen(function* () {
  const service = yield* SessionGuardrail.Service
  expect(yield* service.evaluate({
    sessionID: parentID, action: "file_mutation", resources: [`${home}/Downloads/a/b.txt`],
  })).toMatchObject({ decision: "ask", hardReview: false, ruleIDs: ["standard.review.outside-repo"] })
}))

allowedDirectory.it.effect("keeps hard review for recursive deletion of an allowed home child", () => Effect.gen(function* () {
  const service = yield* SessionGuardrail.Service
  expect(yield* service.evaluate({
    sessionID: parentID, action: "shell", resources: ["rm -rf ~/Downloads"],
  })).toMatchObject({ decision: "ask", hardReview: true, ruleIDs: ["standard.review.home-child"] })
}))

allowedDirectory.it.effect("still reviews a shell command that mixes exempt and non-exempt outside paths", () => Effect.gen(function* () {
  const service = yield* SessionGuardrail.Service
  expect(yield* service.evaluate({
    sessionID: parentID, action: "shell", resources: ["touch ~/Downloads/a/b.txt /outside/file"],
  })).toMatchObject({ decision: "ask", hardReview: false, ruleIDs: ["standard.review.outside-repo"] })
  expect(yield* service.evaluate({
    sessionID: parentID, action: "shell", resources: [`touch ${configDir}/settings.json /outside/file`],
  })).toMatchObject({ decision: "ask", hardReview: false, ruleIDs: ["standard.review.outside-repo"] })
}))

exact.it.effect("destructive rules stay human-only and never consult classification", () => Effect.gen(function* () {
  const service = yield* SessionGuardrail.Service
  for (const command of ["git reset --hard HEAD", "git branch -D feature", "git push origin main --force", "DROP TABLE users", "rm -rf ~/Documents"])
    expect(yield* service.evaluate({ sessionID: parentID, action: "shell", resources: [command] })).toMatchObject({ decision: "ask", hardReview: true })
  expect(exact.choices).toHaveLength(0)
}))

const semanticInput = {
  sessionID: parentID,
  action: "shell",
  resources: ["task-runner /outside/file"],
  metadata: { workdir: "/workspace/project" },
} satisfies SessionGuardrail.EvaluateInput

describe("SessionGuardrail ordinary review", () => {
  const readOnly = harness()
  readOnly.it.effect("read-only inspection never asks a refusing classifier", () => Effect.gen(function* () {
    const service = yield* SessionGuardrail.Service
    const command = 'sed -n 59,75p packages/core/src/memory.ts; grep -nE "^  (const|return \\{)|^    (status|list|search|read|write|graph|delete|trash|restore|purge|vacuum)[,:]" packages/core/src/memory.ts | head -30'
    expect(yield* service.evaluate({ ...semanticInput, resources: [command] })).toMatchObject({ decision: "allow" })
    expect(readOnly.choices).toHaveLength(0)
    for (const input of [
      { ...semanticInput, resources: ["task-runner execute"] },
      { ...semanticInput, action: "file_mutation", resources: ["/workspace/project/new.txt"] },
      { ...semanticInput, resources: ["ls docs/design docs/design/proposals docs/design/proposals/* 2>/dev/null | head -50; git check-ignore -v docs/design/proposals/2026-redesign 2>&1; cat .git/info/exclude"] },
      { ...semanticInput, resources: ["cat /outside/file; git -C /outside status"] },
      { ...semanticInput, action: "read", resources: ["/outside/file"] },
      { ...semanticInput, action: "mcp_execute", resources: ["server/tool"] },
    ]) expect(yield* service.evaluate(input)).toMatchObject({ decision: "allow", ruleIDs: [] })
    expect(readOnly.choices).toHaveLength(0)
    expect(yield* service.evaluate(semanticInput)).toMatchObject({ decision: "ask", ruleIDs: ["standard.review.outside-repo"] })
    expect(readOnly.choices).toHaveLength(0)
  }))

  const deniedRead = harness({
    documents: new Map([["/global/guardrails/deny.md", markdown({ id: "deny-read", decision: "deny", resource: "*" })]]),
  })
  deniedRead.it.effect("custom shell deny still precedes read-only classification bypass", () => Effect.gen(function* () {
    const service = yield* SessionGuardrail.Service
    expect(yield* service.evaluate({ ...semanticInput, resources: ["cat file"] })).toMatchObject({ decision: "deny" })
    expect(deniedRead.choices).toHaveLength(0)
  }))
  const temp = harness()
  temp.it.effect("keeps outside resources reviewed and temporary work inside without helper judgment", () => Effect.gen(function* () {
    const service = yield* SessionGuardrail.Service
    expect(yield* service.evaluate({ ...semanticInput, action: "file_mutation", resources: ["/tmp/a", "/private/tmp/b", "/var/tmp/c",
      "/private/var/tmp/d", "/var/folders/user/cache", "/workspace/project/file", "/outside/file"] })).toMatchObject({ decision: "ask" })
    expect(yield* service.evaluate({ ...semanticInput, resources: ["rm -rf /tmp/a /private/tmp/y /outside/build"] })).toMatchObject({ decision: "ask" })
    expect(yield* service.evaluate({ ...semanticInput, resources: ["rm -rf /tmp/a /private/tmp/y build"] })).toMatchObject({ decision: "allow" })
    expect(yield* service.evaluate({ ...semanticInput, resources: ["rm -rf /tmp/a /var/tmp/y"] })).toMatchObject({ decision: "allow" })
    expect(temp.choices).toHaveLength(0)
  }))

  const agentSafe = harness()
  agentSafe.it.effect("outside work always requires ordinary review without consulting a decision helper", () =>
    Effect.gen(function* () {
      const service = yield* SessionGuardrail.Service
      expect(yield* service.evaluate(semanticInput)).toMatchObject({ decision: "ask", ruleIDs: ["standard.review.outside-repo"] })
      expect(agentSafe.choices).toHaveLength(0)
    }),
  )

  const bypass = harness({
    documents: new Map([
      ["/global/guardrails/deny.md", markdown({ id: "custom-deny", decision: "deny", resource: "custom denied" })],
      ["/global/guardrails/ask.md", markdown({ id: "custom-ask", decision: "ask", resource: "custom reviewed" })],
      ["/global/guardrails/hard.md", markdown({ id: "custom-hard", decision: "hard_review", resource: "custom hard" })],
    ]),
  })
  bypass.it.effect("never infers for deterministic deny, ordinary review, hard review, or skipped review", () =>
    Effect.gen(function* () {
      const service = yield* SessionGuardrail.Service
      for (const input of [
        { ...semanticInput, resources: ["rm -rf /"] },
        { ...semanticInput, resources: ["git reset --hard HEAD~1"] },
        { ...semanticInput, resources: ["rm -rf ."] },
        { ...semanticInput, resources: ["custom denied"] },
        { ...semanticInput, resources: ["custom reviewed"] },
        { ...semanticInput, resources: ["custom hard"] },
        { ...semanticInput, skipReview: true },
        { ...semanticInput, action: "browser", skipReview: true },
        { ...semanticInput, action: "computer", skipReview: true },
      ])
        yield* service.evaluate(input)
      expect(bypass.choices).toEqual([])
    }),
  )

  for (const [name, disabledSettings] of [
    ["omitted policy", undefined],
    ["disabled guardrails", new ConfigGuardrail.Info({ enabled: false })],
  ] as const) {
    const inactive = harness(
      disabledSettings
        ? {
            entries: [
              new Config.Document({ type: "document", info: new Config.Info({ guardrails: disabledSettings }) }),
            ],
          }
        : {},
    )
    inactive.it.effect(`does not infer with ${name}`, () =>
      Effect.gen(function* () {
        const service = yield* SessionGuardrail.Service
        expect(yield* service.evaluate(semanticInput)).toMatchObject({ decision: name === "omitted policy" ? "ask" : "allow" })
        expect(inactive.choices).toEqual([])
      }),
    )
  }

  const human = harness()
  human.it.effect("requires human authorization for outside review and reuses Always for the reviewed directory", () =>
    Effect.gen(function* () {
      const service = yield* SessionGuardrail.Service
      const pending = yield* waitForRequest(service, semanticInput)
      expect(pending.request).toMatchObject({ ruleIDs: ["standard.review.outside-repo"] })
      expect(pending.request.risk).toBeUndefined()
      expect(pending.request.hardReview).toBeUndefined()
      expect(pending.fiber.pollUnsafe()).toBeUndefined()
      yield* service.reply({ sessionID: parentID, requestID: pending.request.id, reply: "always" })
      yield* (yield* Fiber.join(pending.fiber)).release
      yield* (yield* service.assert({ ...semanticInput, sessionID: childID })).release
      yield* (yield* service.assert({ ...semanticInput, resources: ["task-runner /outside/nested/other"] })).release
      expect(yield* service.forSession(parentID)).toEqual([])
      yield* reject(service, { ...semanticInput, metadata: { workdir: "/other" } })
      yield* reject(service, { ...semanticInput, resources: ["task-runner /elsewhere/file"] })
    }),
  )

  const yolo3 = harness({ guardrails: "auto" })
  yolo3.it.effect("guardrails Auto admits an ordinary review without changing hard review or consulting a model", () =>
    Effect.gen(function* () {
      const service = yield* SessionGuardrail.Service
      yield* (yield* service.assert(semanticInput)).release
      expect(yield* service.forSession(parentID)).toEqual([])
      const pending = yield* waitForRequest(service, { ...semanticInput, resources: ["rm -rf ."] })
      expect(pending.request.hardReview).toBe(true)
      yield* service.reply({ sessionID: parentID, requestID: pending.request.id, reply: "reject" })
      expect(Exit.isFailure(yield* Fiber.await(pending.fiber))).toBe(true)
      expect(yolo3.choices).toHaveLength(0)
      expect(yolo3.verifications).toHaveLength(0)
    }),
  )
})

describe("SessionGuardrail coordinator approval", () => {
  const coordinatorSource = { coordinatorSessionID: Session.ID.make("ses_guardrail_coordinator"), groupID: "cgrp_one", rationale: "Owner-approved within the assignment." }
  const decide = (service: SessionGuardrail.Interface, request: Guardrail.Request, decision: "approve" | "decline" = "approve") =>
    Effect.gen(function* () {
      const snapshot = yield* service.requestSnapshot(parentID, request.id)
      return yield* service.reconsider({
        sessionID: parentID, requestID: request.id, fingerprint: snapshot!.fingerprint, actor: "coordinator",
        source: coordinatorSource, decision, validate: () => Effect.succeed(true),
      })
    })

  const owned = harness({
    guardrails: "manual",
    documents: new Map([
      ["/global/guardrails/ask.md", markdown({ id: "custom-ask", decision: "ask", resource: "custom reviewed" })],
      ["/global/guardrails/hard.md", markdown({ id: "custom-hard", decision: "hard_review", resource: "custom hard" })],
    ]),
  })
  owned.it.effect("an owner approval under Manual guardrails allows a standard review once and leaves custom-rule and hard reviews pending until declined", () =>
    Effect.gen(function* () {
      const service = yield* SessionGuardrail.Service
      const standard = yield* waitForRequest(service, { ...semanticInput, resources: ["task-runner /outside/file"] })
      expect(standard.request).toMatchObject({ ruleIDs: ["standard.review.outside-repo"], standard: true })
      expect(yield* decide(service, standard.request)).toMatchObject({ outcome: "allowed", settled: true, via: "coordination" })
      yield* (yield* Fiber.join(standard.fiber)).release
      expect(yield* service.forSession(parentID)).toEqual([])
      expect(owned.replies).toEqual([expect.objectContaining({ requestID: standard.request.id, reply: "once" })])
      const cases = [
        ["custom reviewed", { ruleIDs: ["custom-ask"], standard: false }, "explicit-decision:custom-review"],
        ["custom hard", { ruleIDs: ["custom-hard"], hardReview: true }, "explicit-decision:hard-review"],
        ["rm -rf .", { hardReview: true, standard: true }, "explicit-decision:hard-review"],
      ] as const
      for (const [resource, expected, reason] of cases) {
        const pending = yield* waitForRequest(service, { ...semanticInput, resources: [resource] })
        expect(pending.request, resource).toMatchObject(expected)
        expect(yield* decide(service, pending.request), resource).toMatchObject({ outcome: "escalated", settled: false, reason })
        expect(yield* service.forSession(parentID), resource).toHaveLength(1)
        expect(yield* decide(service, pending.request, "decline"), resource).toMatchObject({ outcome: "denied", settled: true, via: "coordination" })
        expect(Exit.isFailure(yield* Fiber.await(pending.fiber)), resource).toBe(true)
        expect(yield* service.forSession(parentID), resource).toEqual([])
      }
      expect(owned.choices).toHaveLength(0)
      const attribution = { actor: "coordinator", coordinatorSessionID: coordinatorSource.coordinatorSessionID, rationale: coordinatorSource.rationale }
      expect(owned.decisions).toEqual([
        expect.objectContaining({ reply: "once", ...attribution }),
        ...cases.map(() => expect.objectContaining({ reply: "reject", ...attribution })),
      ])
    }),
  )

  const denied = harness({
    guardrails: "manual",
    documents: new Map([["/global/guardrails/ask.md", markdown({ id: "custom-ask", decision: "ask", resource: "custom reviewed" })]]),
  })
  denied.it.effect("an owner approval never allows a review a deny rule covers at settlement", () =>
    Effect.gen(function* () {
      const service = yield* SessionGuardrail.Service
      const pending = yield* waitForRequest(service, { ...semanticInput, resources: ["custom reviewed"] })
      denied.documents.set(path.normalize("/global/guardrails/ask.md"), markdown({ id: "custom-ask", decision: "deny", resource: "custom reviewed" }))
      expect(yield* decide(service, pending.request)).toMatchObject({ outcome: "denied", settled: true, via: "guardrail-rules" })
      expect(Exit.isFailure(yield* Fiber.await(pending.fiber))).toBe(true)
      expect(yield* service.forSession(parentID)).toEqual([])
      expect(denied.replies).toEqual([expect.objectContaining({ requestID: pending.request.id, reply: "reject" })])
    }),
  )

  const invalid = harness({
    guardrails: "manual",
    documents: new Map([["/global/guardrails/broken.md", "---\nid: broken\ndecision: nonsense\n---\n"]]),
  })
  invalid.it.effect("an owner approval leaves a review raised by invalid guardrail configuration pending, and a decline settles it", () =>
    Effect.gen(function* () {
      const service = yield* SessionGuardrail.Service
      const pending = yield* waitForRequest(service, { ...semanticInput, resources: ["task-runner build"] })
      expect(pending.request.ruleIDs).toEqual(["configuration.invalid"])
      expect(yield* decide(service, pending.request)).toMatchObject({ outcome: "escalated", settled: false, reason: "configuration-invalid" })
      expect(yield* service.forSession(parentID)).toHaveLength(1)
      expect(yield* decide(service, pending.request, "decline")).toMatchObject({ outcome: "denied", settled: true, via: "coordination" })
      expect(Exit.isFailure(yield* Fiber.await(pending.fiber))).toBe(true)
    }),
  )
})

const destructive = {
  sessionID: parentID,
  action: "shell",
  resources: ["touch /outside/file", "ordered context"],
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

const autonomousSessionID = Session.ID.make("ses_guardrail_service_autonomous")
const autonomousLocation = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const unavailableDecision = Layer.mock(Decision.Service, {
  evaluate: () => Effect.fail(new Decision.Error({ reason: "unavailable" })),
})

const autonomousRuntime = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventRuntime.node,
      SessionStore.node,
      SessionAutonomy.node,
      PermissionSaved.node,
      Agent.node,
      Permission.node,
      SessionGuardrail.node,
    ]),
    [
      [Location.node, autonomousLocation],
      [Decision.node, unavailableDecision],
      [LocationMutation.node, Layer.mock(LocationMutation.Service, { repositoryWorktree: () => Effect.succeed(false) })],
    ],
  ),
)

exact.it.effect("snapshots the root-family state across pending-review ABA transitions", () =>
  Effect.gen(function* () {
    const service = yield* SessionGuardrail.Service
    const initial = yield* service.snapshot(parentID)
    expect(yield* service.snapshot(parentID)).toEqual(initial)

    const pending = yield* waitForRequest(service, { ...destructive, sessionID: childID })
    const added = yield* service.snapshot(parentID)
    expect(added.sequence).toBeGreaterThan(initial.sequence)
    expect(added.digest).not.toBe(initial.digest)
    expect(yield* service.snapshot(childID)).toEqual(added)

    yield* service.reply({ sessionID: childID, requestID: pending.request.id, reply: "reject" })
    const exit = yield* Fiber.await(pending.fiber)
    expect(Exit.isFailure(exit)).toBe(true)
    const removed = yield* service.snapshot(parentID)
    expect(removed.sequence).toBeGreaterThan(added.sequence)
    expect(removed.sequence).toBeGreaterThan(initial.sequence)
    expect(removed.digest).toBe(initial.digest)
  }),
)

exact.it.effect("serializes root-family mutations without holding the fence across human review", () =>
  Effect.gen(function* () {
    const service = yield* SessionGuardrail.Service
    const scope = yield* Scope.Scope
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const fenced = yield* service
      .withSnapshot(parentID, () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))))
      .pipe(Effect.forkScoped)
    yield* Deferred.await(entered).pipe(Effect.timeout("500 millis"))
    const denied = yield* service
      .assert({ ...destructive, sessionID: childID, resources: ["rm -rf /"] })
      .pipe(Effect.forkIn(scope, { startImmediately: true }))
    yield* Effect.yieldNow
    expect(denied.pollUnsafe()).toBeUndefined()

    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(fenced).pipe(Effect.timeout("500 millis"))
    expect(Exit.isFailure(yield* Fiber.await(denied).pipe(Effect.timeout("500 millis")))).toBe(true)

    const pending = yield* waitForRequest(service, { ...destructive, sessionID: childID })
    yield* service.withSnapshot(parentID, () => Effect.void).pipe(Effect.timeout("100 millis"))
    yield* service.reply({ sessionID: childID, requestID: pending.request.id, reply: "reject" })
    expect(Exit.isFailure(yield* Fiber.await(pending.fiber).pipe(Effect.timeout("500 millis")))).toBe(true)
  }),
)

autonomousRuntime.effect(
  "Auto and YOLO approve ordinary reviews while a goal preserves Manual review",
  () =>
    Effect.gen(function* () {
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
          id: autonomousSessionID,
          project_id: Project.ID.global,
          directory: "/project",
          title: "Guardrail autonomy invariant",
          agent: "guardrail-autonomy-test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const agents = yield* Agent.Service
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("guardrail-autonomy-test"), (agent) => {
          agent.permissions = []
        }),
      )
      const autonomy = yield* SessionAutonomy.Service
      const events = yield* EventRuntime.Service
      const permission = yield* Permission.Service
      const guardrail = yield* SessionGuardrail.Service

      yield* autonomy.set({ sessionID: autonomousSessionID, permissions: "auto", guardrails: "auto" })
      expect(
        yield* permission.ask({
          sessionID: autonomousSessionID,
          action: "read",
          resources: ["src/index.ts"],
        }),
      ).toMatchObject({ effect: "allow" })
      expect(yield* permission.forSession(autonomousSessionID)).toEqual([])
      const autoReservation = yield* guardrail.assert({ ...destructive, sessionID: autonomousSessionID })
      yield* autoReservation.release
      expect(yield* guardrail.forSession(autonomousSessionID)).toEqual([])

      const expectHumanReview = Effect.gen(function* () {
        const asked = yield* Deferred.make<void>()
        const unsubscribe = yield* events.listen((event) =>
          event.type === Guardrail.Event.Asked.type
            ? Deferred.succeed(asked, undefined).pipe(Effect.asVoid)
            : Effect.void,
        )
        const fiber = yield* guardrail
          .assert({ ...destructive, sessionID: autonomousSessionID })
          .pipe(Effect.forkScoped)
        yield* Deferred.await(asked).pipe(Effect.timeout("1 second"), Effect.ensuring(unsubscribe))
        const request = (yield* guardrail.forSession(autonomousSessionID))[0]
        if (!request) yield* Effect.die("guardrail request was not retained")
        expect(yield* guardrail.forSession(autonomousSessionID)).toContainEqual(request)
        yield* guardrail.reply({ sessionID: autonomousSessionID, requestID: request.id, reply: "once" })
        yield* (yield* Fiber.join(fiber)).release
      })

      yield* autonomy.set({ sessionID: autonomousSessionID, guardrails: "yolo" })
      expect(
        yield* permission.ask({
          sessionID: autonomousSessionID,
          action: "read",
          resources: ["src/index.ts"],
        }),
      ).toMatchObject({ effect: "allow" })
      yield* (yield* guardrail.assert({ ...destructive, sessionID: autonomousSessionID })).release

      yield* autonomy.set({ sessionID: autonomousSessionID, permissions: "manual", guardrails: "manual" })
      yield* autonomy.setGoal({ sessionID: autonomousSessionID, text: "Finish safely" })
      const goalPermission = yield* permission.ask({ sessionID: autonomousSessionID, action: "read", resources: ["src/index.ts"] })
      expect(goalPermission).toMatchObject({ effect: "ask" })
      yield* permission.reply({ requestID: goalPermission.id, reply: "once" })
      yield* expectHumanReview
    }),
)

autonomousRuntime.effect("retains broad-deletion review in Manual and Auto while YOLO admits it", () =>
  Effect.gen(function* () {
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
        id: autonomousSessionID,
        project_id: Project.ID.global,
        directory: "/project",
        title: "Hard-review autonomy invariant",
        agent: "guardrail-autonomy-test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const autonomy = yield* SessionAutonomy.Service
    const events = yield* EventRuntime.Service
    const guardrail = yield* SessionGuardrail.Service
    const review = Effect.fn("SessionGuardrailTest.reviewHardDeletion")(function* () {
      const asked = yield* Deferred.make<void>()
      const unsubscribe = yield* events.listen((event) =>
        event.type === Guardrail.Event.Asked.type
          ? Deferred.succeed(asked, undefined).pipe(Effect.asVoid)
          : Effect.void,
      )
      const fiber = yield* guardrail
        .assert({
          sessionID: autonomousSessionID,
          action: "shell",
          resources: ["rm -rf ."],
          metadata: { workdir: "/project" },
        })
        .pipe(Effect.forkScoped)
      yield* Deferred.await(asked).pipe(Effect.timeout("1 second"), Effect.ensuring(unsubscribe))
      const request = (yield* guardrail.forSession(autonomousSessionID))[0]
      if (!request) return yield* Effect.die("hard-review request was not retained")
      expect(request.hardReview).toBe(true)
      yield* guardrail.reply({ sessionID: autonomousSessionID, requestID: request.id, reply: "once" })
      const reservation = yield* Fiber.join(fiber)
      yield* reservation.release
    })

    for (const modes of [
      { permissions: "manual", guardrails: "manual", answers: "manual" },
      { permissions: "yolo", guardrails: "yolo", answers: "yolo" },
      { permissions: "auto", guardrails: "auto", answers: "auto" },
      { permissions: "auto", guardrails: "yolo", answers: "manual" },
    ] as const) {
      yield* autonomy.set({ sessionID: autonomousSessionID, ...modes })
      expect(
        yield* guardrail.evaluate({
          sessionID: autonomousSessionID,
          action: "shell",
          resources: ["rm -rf ."],
          metadata: { workdir: "/project" },
        }),
      ).toMatchObject(modes.guardrails === "yolo" ? { decision: "allow", hardReview: false } : { decision: "ask", hardReview: true })
      if (modes.guardrails === "yolo") yield* (yield* guardrail.assert({ sessionID: autonomousSessionID, action: "shell", resources: ["rm -rf ."], metadata: { workdir: "/project" } })).release
      else yield* review()
    }
    yield* autonomy.set({ sessionID: autonomousSessionID, permissions: "manual", guardrails: "auto", answers: "manual" })
    yield* autonomy.setGoal({ sessionID: autonomousSessionID, text: "Delete safely" })
    yield* review()

    yield* autonomy.clearGoal(autonomousSessionID)
    const ordinary = yield* guardrail.assert({
      ...destructive,
      sessionID: autonomousSessionID,
      metadata: { workdir: "/project" },
    })
    yield* ordinary.release
    expect(yield* guardrail.forSession(autonomousSessionID)).toEqual([])
  }),
)

const approvalRootID = Session.ID.make("ses_guardrail_approval_root")
const approvalChildID = Session.ID.make("ses_guardrail_approval_child")

function approvalRuntime(database: string) {
  return AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventRuntime.node,
      SessionStore.node,
      SessionAutonomy.node,
      PermissionSaved.node,
      Agent.node,
      Permission.node,
      SessionGuardrail.node,
    ]),
    [
      [Database.node, Database.layerFromPath(database)],
      [Global.node, Global.layerWith({ home, data: dataDir, config: configDir, cache: cacheDir, state: stateDir })],
      [Location.node, autonomousLocation],
      [Decision.node, unavailableDecision],
      [LocationMutation.node, Layer.mock(LocationMutation.Service, { repositoryWorktree: () => Effect.succeed(false) })],
    ],
  )
}

const seedApprovalFamily = Effect.gen(function* () {
  const database = yield* Database.Service
  yield* database.db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  for (const row of [
    { id: approvalRootID, title: "Guardrail approval root" },
    { id: approvalChildID, parent_id: approvalRootID, title: "Guardrail approval child" },
  ])
    yield* database.db
      .insert(SessionTable)
      .values({ ...row, project_id: Project.ID.global, directory: "/project", agent: "guardrail-approval-test" })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  const agents = yield* Agent.Service
  yield* agents.transform((editor) =>
    editor.update(Agent.ID.make("guardrail-approval-test"), (agent) => {
      agent.permissions = []
    }),
  )
})

it.live("persists directory-scoped Always on the root Session family across a service restart", () =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
  ).pipe(
    Effect.flatMap((directory) => {
      const database = path.join(directory.path, "guardrail.db")
      const outside = (sessionID: Session.ID, file: string) =>
        ({ sessionID, action: "file_mutation", resources: [`${home}/${file}`] }) satisfies SessionGuardrail.EvaluateInput
      return Effect.gen(function* () {
        yield* Effect.provide(
          Effect.gen(function* () {
            yield* seedApprovalFamily
            const guardrail = yield* SessionGuardrail.Service
            const events = yield* EventRuntime.Service
            const waitForAsked = Effect.fn("SessionGuardrailTest.waitForAsked")(function* (
              service: SessionGuardrail.Interface,
              input: SessionGuardrail.EvaluateInput,
            ) {
              const asked = yield* Deferred.make<void>()
              const unsubscribe = yield* events.listen((event) =>
                event.type === Guardrail.Event.Asked.type ? Deferred.succeed(asked, undefined).pipe(Effect.asVoid) : Effect.void,
              )
              const fiber = yield* service.assert(input).pipe(Effect.forkScoped)
              yield* Deferred.await(asked).pipe(Effect.timeout("1 second"), Effect.ensuring(unsubscribe))
              const request = (yield* service.forSession(input.sessionID))[0]
              if (!request) return yield* Effect.die("guardrail request was not retained")
              return { fiber, request }
            })
            const pending = yield* waitForAsked(guardrail, outside(approvalRootID, "x/a.txt"))
            expect(pending.request.ruleIDs).toEqual(["standard.review.outside-repo"])
            expect(pending.request.hardReview).toBeUndefined()
            yield* guardrail.reply({ sessionID: approvalRootID, requestID: pending.request.id, reply: "always" })
            yield* (yield* Fiber.join(pending.fiber)).release

            for (const input of [
              outside(approvalRootID, "x/b.txt"),
              outside(approvalChildID, "x/nested/c.txt"),
              { sessionID: approvalChildID, action: "shell", resources: ["touch ~/x/d.txt"], metadata: { workdir: "/project" } },
            ]) {
              expect(yield* guardrail.evaluate(input)).toMatchObject({ decision: "allow", ruleIDs: [] })
              yield* (yield* guardrail.assert(input)).release
            }
            expect(yield* guardrail.forSession(approvalRootID)).toEqual([])
            for (const input of [outside(approvalRootID, "y/a.txt"), outside(approvalChildID, "xy/a.txt")])
              expect(yield* guardrail.evaluate(input)).toMatchObject({
                decision: "ask", hardReview: false, ruleIDs: ["standard.review.outside-repo"],
              })

            const hard = yield* waitForAsked(guardrail, {
              sessionID: approvalChildID, action: "shell", resources: ["rm -rf ~/x"], metadata: { workdir: "/project" },
            })
            expect(hard.request.hardReview).toBe(true)
            yield* guardrail.reply({ sessionID: approvalChildID, requestID: hard.request.id, reply: "always" })
            expect(Exit.isFailure(yield* Fiber.await(hard.fiber))).toBe(true)
          }).pipe(Effect.scoped),
          approvalRuntime(database),
        )
        yield* Effect.provide(
          Effect.gen(function* () {
            const guardrail = yield* SessionGuardrail.Service
            expect(yield* guardrail.evaluate(outside(approvalChildID, "x/e.txt"))).toMatchObject({ decision: "allow" })
            expect(yield* guardrail.evaluate(outside(approvalRootID, "y/a.txt"))).toMatchObject({
              decision: "ask", ruleIDs: ["standard.review.outside-repo"],
            })
            expect(yield* guardrail.evaluate({
              sessionID: approvalChildID, action: "shell", resources: ["rm -rf ~/x"], metadata: { workdir: "/project" },
            })).toMatchObject({ decision: "ask", hardReview: true })
          }),
          approvalRuntime(database),
        )
      })
    }),
  ),
)

it.live("delegated guardrail settlement writes no human rejection hold or incident", () =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
  ).pipe(
    Effect.flatMap((directory) => Effect.gen(function* () {
      yield* Effect.provide(Effect.gen(function* () {
        yield* seedApprovalFamily
        const guardrail = yield* SessionGuardrail.Service
        const database = yield* Database.Service
        const source = { kind: "dots-delegation", anchorSessionID: Session.ID.make("ses_anchor"), delegationID: "proposal_1", revision: 1, exchangeID: "exchange_1" } as const
        const fiber = yield* guardrail.assert({ sessionID: approvalRootID, action: "file_mutation", resources: [`${home}/delegated/a.txt`] }).pipe(Effect.forkScoped)
        let snapshot = (yield* guardrail.requestSnapshots(approvalRootID))[0]
        for (let attempt = 0; snapshot === undefined && attempt < 200; attempt++) {
          yield* Effect.sleep("10 millis")
          snapshot = (yield* guardrail.requestSnapshots(approvalRootID))[0]
        }
        if (!snapshot) return yield* Effect.die("guardrail request was not retained")
        expect(snapshot.request.hardReview).not.toBe(true)
        expect((yield* guardrail.replyDelegated({ sessionID: approvalRootID, requestID: snapshot.request.id, reply: "reject", fingerprint: "0".repeat(64), source, validate: () => Effect.succeed(true) }).pipe(Effect.exit))._tag).toBe("Failure")
        expect(yield* guardrail.requestSnapshots(approvalRootID)).toHaveLength(1)
        yield* guardrail.replyDelegated({ sessionID: approvalRootID, requestID: snapshot.request.id, reply: "reject", fingerprint: snapshot.fingerprint, source, validate: () => Effect.succeed(true) })
        expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
        expect(yield* database.db.select().from(ModelIncidentTable).all().pipe(Effect.orDie)).toEqual([])
        const again = yield* guardrail.assert({ sessionID: approvalRootID, action: "file_mutation", resources: [`${home}/delegated/a.txt`] }).pipe(Effect.forkScoped)
        let second = (yield* guardrail.requestSnapshots(approvalRootID))[0]
        for (let attempt = 0; second === undefined && attempt < 200; attempt++) {
          yield* Effect.sleep("10 millis")
          second = (yield* guardrail.requestSnapshots(approvalRootID))[0]
        }
        if (!second) return yield* Effect.die("second guardrail request was not retained")
        yield* guardrail.reply({ sessionID: approvalRootID, requestID: second.request.id, reply: "reject" })
        expect(Exit.isFailure(yield* Fiber.await(again))).toBe(true)
        const heldFiber = yield* guardrail.assert({ sessionID: approvalRootID, action: "file_mutation", resources: [`${home}/delegated/a.txt`] }).pipe(Effect.forkScoped)
        let held = (yield* guardrail.requestSnapshots(approvalRootID))[0]
        for (let attempt = 0; held === undefined && attempt < 200; attempt++) {
          yield* Effect.sleep("10 millis")
          held = (yield* guardrail.requestSnapshots(approvalRootID))[0]
        }
        if (!held) return yield* Effect.die("held guardrail request was not retained")
        expect(yield* guardrail.delegatedEligible({ sessionID: approvalRootID, requestID: held.request.id, fingerprint: held.fingerprint, reply: "once" })).toBe(false)
        expect((yield* guardrail.replyDelegated({ sessionID: approvalRootID, requestID: held.request.id, reply: "once", fingerprint: held.fingerprint, source, validate: () => Effect.succeed(true) }).pipe(Effect.exit))._tag).toBe("Failure")
        expect(yield* guardrail.requestSnapshots(approvalRootID)).toHaveLength(1)
        yield* guardrail.reply({ sessionID: approvalRootID, requestID: held.request.id, reply: "reject" })
        expect(Exit.isFailure(yield* Fiber.await(heldFiber))).toBe(true)
      }).pipe(Effect.scoped), approvalRuntime(path.join(directory.path, "guardrail-delegated.db")))
    })),
  )
)

describe("SessionGuardrail reusable approvals", () => {
  exact.it.effect("reuses Always for every outside directory of the reviewed request across the root family", () =>
    Effect.gen(function* () {
      const service = yield* SessionGuardrail.Service
      const pending = yield* waitForRequest(service, destructive)
      yield* service.reply({ sessionID: parentID, requestID: pending.request.id, reply: "always" })
      const first = yield* Fiber.join(pending.fiber)
      yield* first.release

      for (const input of [
        { ...destructive, sessionID: childID },
        { ...destructive, resources: destructive.resources.toReversed() },
        { sessionID: parentID, action: "file_mutation", resources: ["/outside/new/file"] },
        { ...destructive, resources: ["cp /repo/a /outside/b"] },
      ]) {
        const reused = yield* service.assert(input)
        yield* reused.release
      }
      expect(yield* service.forSession(parentID)).toEqual([])

      yield* reject(service, { ...destructive, resources: ["git reset --hard HEAD~2", "ordered context"] })
      yield* reject(service, { ...destructive, metadata: { workdir: "/other" } })
      yield* reject(service, { ...destructive, resources: ["touch /outside/file /elsewhere/file"] })
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

  exact.it.effect("approves the directories of the request that was reviewed, not later input mutation", () =>
    Effect.gen(function* () {
      const service = yield* SessionGuardrail.Service
      const metadata = { workdir: "/repo" }
      const input = { ...destructive, metadata }
      const pending = yield* waitForRequest(service, input)
      metadata.workdir = "/other"
      yield* service.reply({ sessionID: parentID, requestID: pending.request.id, reply: "always" })
      const reservation = yield* Fiber.join(pending.fiber)
      yield* reservation.release

      const reused = yield* service.assert({ ...destructive, metadata: { workdir: "/repo" } })
      yield* reused.release
      expect(yield* service.forSession(parentID)).toEqual([])
      yield* reject(service, { ...destructive, metadata: { workdir: "/other" } })
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
    ["/global/guardrails/review.md", markdown({ id: "first-rule", decision: "ask", resource: "deploy exact" })],
  ]),
})

const hardenedRule = harness({
  entries: [new Config.Directory({ type: "directory", path: AbsolutePath.make("/global") })],
  documents: new Map([
    ["/global/guardrails/review.md", markdown({ id: "stable-rule", decision: "ask", resource: "deploy exact" })],
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

const hardReviewInput = {
  sessionID: parentID,
  action: "shell",
  resources: ["rm -rf ."],
  metadata: { workdir: "/workspace/project" },
} satisfies SessionGuardrail.EvaluateInput

const autoHardReview = harness({ guardrails: "auto" })

autoHardReview.it.effect("does not let guardrails Auto approve a hard review", () =>
  Effect.gen(function* () {
    const service = yield* SessionGuardrail.Service
    const pending = yield* waitForRequest(service, { ...hardReviewInput, sessionID: childID })
    expect(pending.request).toMatchObject({ rootSessionID: parentID, sessionID: childID, hardReview: true })
    yield* service.reply({ sessionID: parentID, requestID: pending.request.id, reply: "once" })
    const reservation = yield* Fiber.join(pending.fiber)
    yield* reservation.release
  }),
)

exact.it.effect("admits hard and ordinary reviews without a request when review is skipped", () =>
  Effect.gen(function* () {
    const service = yield* SessionGuardrail.Service
    const hard = yield* service.assert({ ...hardReviewInput, sessionID: childID, skipReview: true })
    yield* hard.release
    const ordinary = yield* service.assert({ ...destructive, skipReview: true })
    yield* ordinary.release
    expect(yield* service.forSession(parentID)).toEqual([])
  }),
)

exact.it.effect("keeps deny rules blocking when review is skipped", () =>
  Effect.gen(function* () {
    const service = yield* SessionGuardrail.Service
    const error = yield* Effect.flip(service.assert({ ...destructive, resources: ["rm -rf /"], skipReview: true }))
    expect(error._tag).toBe("Guardrail.BlockedError")
  }),
)

exact.it.effect("rejects reusable Always for hard reviews and requires a fresh human decision", () =>
  Effect.gen(function* () {
    const service = yield* SessionGuardrail.Service
    const pending = yield* waitForRequest(service, { ...hardReviewInput, sessionID: childID })
    yield* service.reply({ sessionID: parentID, requestID: pending.request.id, reply: "always" })
    expect(Exit.isFailure(yield* Fiber.await(pending.fiber))).toBe(true)

    const repeated = yield* waitForRequest(service, { ...hardReviewInput, sessionID: childID })
    yield* service.reply({ sessionID: childID, requestID: repeated.request.id, reply: "reject" })
    expect(Exit.isFailure(yield* Fiber.await(repeated.fiber))).toBe(true)
  }),
)

disabled.it.effect("keeps catastrophic standard denies active when configurable guardrails are disabled", () =>
  Effect.gen(function* () {
    const service = yield* SessionGuardrail.Service
    const error = yield* Effect.flip(service.assert({ ...destructive, resources: ["rm -rf /"] }))
    expect(error._tag).toBe("Guardrail.BlockedError")
  }),
)

disabled.it.effect("keeps standard hard reviews active when configurable guardrails are disabled", () =>
  Effect.gen(function* () {
    const service = yield* SessionGuardrail.Service
    const pending = yield* waitForRequest(service, hardReviewInput)
    expect(pending.request.hardReview).toBe(true)
    yield* service.reply({ sessionID: parentID, requestID: pending.request.id, reply: "reject" })
    expect(Exit.isFailure(yield* Fiber.await(pending.fiber))).toBe(true)
  }),
)

const disabledCustomHardReview = harness({
  entries: [
    new Config.Document({
      type: "document",
      info: new Config.Info({ guardrails: new ConfigGuardrail.Info({ enabled: false }) }),
    }),
  ],
  documents: new Map([
    [
      "/global/guardrails/aws.md",
      markdown({ id: "human-review-aws-close", decision: "hard_review", resource: "aws account close-account*" }),
    ],
  ]),
})

disabledCustomHardReview.it.effect("does not disable a configured hard review with guardrails.enabled false", () =>
  Effect.gen(function* () {
    const service = yield* SessionGuardrail.Service
    const pending = yield* waitForRequest(service, {
      sessionID: parentID,
      action: "shell",
      resources: ["aws account close-account --account-id 111122223333"],
    })
    expect(pending.request).toMatchObject({ hardReview: true, ruleIDs: ["human-review-aws-close"] })
    yield* service.reply({ sessionID: parentID, requestID: pending.request.id, reply: "reject" })
    expect(Exit.isFailure(yield* Fiber.await(pending.fiber))).toBe(true)
  }),
)

hardenedRule.it.effect("does not reuse a prior Always after the same rule becomes a hard review", () =>
  Effect.gen(function* () {
    const service = yield* SessionGuardrail.Service
    const input = { sessionID: parentID, action: "shell", resources: ["deploy exact"] } as const
    const ordinary = yield* waitForRequest(service, input)
    yield* service.reply({ sessionID: parentID, requestID: ordinary.request.id, reply: "always" })
    const reservation = yield* Fiber.join(ordinary.fiber)
    yield* reservation.release

    hardenedRule.documents.set(
      path.normalize("/global/guardrails/review.md"),
      markdown({ id: "stable-rule", decision: "hard_review", resource: "deploy exact" }),
    )
    const hard = yield* waitForRequest(service, input)
    expect(hard.request).toMatchObject({ hardReview: true, ruleIDs: ["stable-rule"] })
    yield* service.reply({ sessionID: parentID, requestID: hard.request.id, reply: "once" })
    const approved = yield* Fiber.join(hard.fiber)
    yield* approved.release
  }),
)

changingRule.it.effect("approves only the reviewed request when Always answers a review without outside directories", () =>
  Effect.gen(function* () {
    const service = yield* SessionGuardrail.Service
    const input = { sessionID: parentID, action: "shell", resources: ["deploy exact"] } as const
    const pending = yield* waitForRequest(service, input)
    expect(pending.request.ruleIDs).toEqual(["first-rule"])
    yield* service.reply({ sessionID: parentID, requestID: pending.request.id, reply: "always" })
    const reservation = yield* Fiber.join(pending.fiber)
    yield* reservation.release

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
    expect(yield* service.evaluate({ sessionID: parentID, action: "shell", resources: ["echo exact"] })).toMatchObject({
      decision: "deny",
      ruleIDs: ["uppercase-deny"],
    })
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
      { pattern: "*.md", cwd: path.normalize("/repo/work/.ycoding/guardrails") },
      { pattern: "*.md", cwd: path.normalize("/repo/.ycoding/guardrails") },
      { pattern: "*.md", cwd: path.normalize("/global/guardrails") },
    ])

    expect(
      yield* service.evaluate({ sessionID: parentID, action: "shell", resources: ["git reset --hard global"] }),
    ).toMatchObject({ decision: "ask", hardReview: true, ruleIDs: ["standard.review.git-destructive"] })
    expect(
      yield* service.evaluate({ sessionID: parentID, action: "shell", resources: ["git reset --hard nested"] }),
    ).toMatchObject({ decision: "ask", ruleIDs: ["standard.review.git-destructive"] })
  }),
)

const baselineChoice = (choice: Guardrail.DecisionChoice) =>
  choice === "approve" || choice === "approve_all" ? "allow" : choice === "reject" ? "deny" : choice

const decisionOutput = (choice: Guardrail.DecisionChoice | "refusal", confidence: number) =>
  Schema.decodeUnknownSync(Decision.Output)({
    provider: "agent",
    response: {
      model: { providerID: "test", id: "decision-model" },
      semantics: "model-estimate",
      version: 1,
      answers: [
        {
          name: "guardrail",
          type: choice === "refusal" ? "refusal" : "choice",
          answer: null,
          choice: null,
          score: null,
          confidence: 0,
          ...(choice === "refusal" ? {} : { grades: (["allow", "deny", "escalate"] as const).map((value) => ({
            choice: value, confidence: value === baselineChoice(choice) ? confidence : 0, evidence: "Bounded review evidence",
          })) }),
        },
      ],
    },
  })

const ordinaryReview = { sessionID: parentID, action: "shell", resources: ["touch /outside/file"] }
const verificationOutput = (answer: boolean | "refusal", confidence: number) => Schema.decodeUnknownSync(Decision.Output)({
  provider: "agent", response: {
    model: { providerID: "test", id: "decision-model" }, semantics: "model-estimate", version: 1,
    answers: [{ name: "guardrail_match", type: answer === "refusal" ? "refusal" : "choice", answer: null, choice: answer === "refusal" ? null : answer ? "deny" : "allow", score: null, confidence }],
  },
})
const hardReview = {
  sessionID: parentID,
  action: "shell",
  resources: ["rm -rf ."],
  metadata: { workdir: "/workspace/project" },
}

const decideReviewsConfig = (configured: boolean | undefined) =>
  configured === undefined ? [] : [new Config.Document({ type: "document", info: Schema.decodeUnknownSync(Config.Info)({ guardrails: { decide_reviews: configured } }) })]


for (const deferred of [false, true]) {
  const flagOnly = harness({
    defaults: true,
    realAutonomy: true,
    guardrails: "auto",
    deferred,
    verify: () => Effect.die("Auto guardrails must not reach match verification"),
    decision: () => Effect.die("Auto guardrails must not reach grading"),
  })
  flagOnly.it.effect(`guardrails Auto approves ordinary standard reviews only awake with no model fallback (${deferred ? "deferred" : "awake"})`, () => Effect.gen(function* () {
    yield* flagOnly.seed
    const service = yield* SessionGuardrail.Service
    const ordinary = yield* service.assert(ordinaryReview).pipe(Effect.forkScoped)
    yield* TestClock.adjust(0)
    if (deferred) expect(Exit.isFailure(yield* Fiber.await(ordinary))).toBe(true)
    else yield* (yield* Fiber.join(ordinary)).release
    const hard = yield* service.assert(hardReview).pipe(Effect.forkScoped)
    yield* TestClock.adjust(0)
    if (!deferred) {
      const requests = yield* service.forSession(parentID)
      expect(requests).toHaveLength(1)
      expect(requests[0]).not.toHaveProperty("escalation")
      yield* service.reply({ sessionID: parentID, requestID: requests[0]!.id, reply: "reject" })
    }
    expect(Exit.isFailure(yield* Fiber.await(hard))).toBe(true)
    expect(flagOnly.verifications).toEqual([])
    expect(flagOnly.choices).toEqual([])
    expect(flagOnly.escalations).toEqual([])
    expect(flagOnly.decisions).toEqual([])
    const items = yield* SessionReviewFold.fold((yield* Database.Service).db, [parentID])
    expect(items.map((item) => item.reason)).toEqual(deferred ? ["disabled", "disabled"] : [])
  }))
}

const deferStates = [true, false]
const wakeBeforeHandoff = harness({
  defaults: true,
  guardrails: "manual",
  deferStates,
  entries: decideReviewsConfig(false),
  verify: () => Effect.die("Disabled verification must not reach the helper"),
  decision: () => Effect.die("Disabled grading must not reach the helper"),
})

wakeBeforeHandoff.it.effect("a family that wakes between disabled-assessment admission and handoff gets one plain human review", () => Effect.gen(function* () {
  const service = yield* SessionGuardrail.Service
  const fiber = yield* service.assert(ordinaryReview).pipe(Effect.forkScoped)
  yield* TestClock.adjust(0)
  expect(deferStates).toEqual([])
  const requests = yield* service.forSession(parentID)
  expect(requests).toHaveLength(1)
  expect(requests[0]).not.toHaveProperty("escalation")
  expect(wakeBeforeHandoff.asked.map((request) => request.id)).toEqual([requests[0]!.id])
  yield* service.reply({ sessionID: parentID, requestID: requests[0]!.id, reply: "once" })
  yield* (yield* Fiber.join(fiber)).release
  expect(wakeBeforeHandoff.replies).toHaveLength(1)
  expect(wakeBeforeHandoff.verifications).toEqual([])
  expect(wakeBeforeHandoff.choices).toEqual([])
  expect(wakeBeforeHandoff.escalations).toEqual([])
  expect(wakeBeforeHandoff.decisions).toEqual([])
  const db = (yield* Database.Service).db
  expect(yield* db.select().from(ModelIncidentTable).all().pipe(Effect.orDie)).toEqual([])
  expect(yield* SessionReviewFold.fold(db, [parentID])).toEqual([])
}))


const unknownImport = harness({ guardrails: "manual" })
unknownImport.it.effect("unknown SQLite import target retains ordinary service review", () => Effect.gen(function* () {
  const service = yield* SessionGuardrail.Service
  const pending = yield* waitForRequest(service, { ...ordinaryReview, resources: [
    `sqlite3 db.sqlite ".import --unknown value /outside/input.csv items"`,
  ] })
  expect(pending.request.ruleIDs).toEqual(["standard.review.outside-repo"])
  expect(pending.request.reason).toBe("SQLite import file target is unproven")
  expect(pending.request.hardReview).not.toBe(true)
  yield* service.reply({ sessionID: parentID, requestID: pending.request.id, reply: "reject" })
  expect(Exit.isFailure(yield* Fiber.await(pending.fiber))).toBe(true)
}))

for (const resources of [
  [`sqlite3 db.sqlite ".import --unknown value file items"; touch /outside/real`],
  [`sqlite3 db.sqlite ".import --unknown value file items"`, `touch /outside/real`],
]) {
  const mixedImport = harness({ verify: () => Effect.succeed(verificationOutput(false, 1)) })
  mixedImport.it.effect(`unknown SQLite import preserves independent file review across resources: ${resources.length}`, () => Effect.gen(function* () {
    const service = yield* SessionGuardrail.Service
    const pending = yield* waitForRequest(service, { ...ordinaryReview, resources })
    expect(pending.request.ruleIDs).toEqual(["standard.review.outside-repo"])
    expect(pending.request.reason).toBe("SQLite import file target is unproven")
    expect(mixedImport.verifications).toEqual([])
    expect(mixedImport.dismissals).toEqual([])
    yield* service.reply({ sessionID: parentID, requestID: pending.request.id, reply: "reject" })
    expect(Exit.isFailure(yield* Fiber.await(pending.fiber))).toBe(true)
  }))
}

for (const review of [ordinaryReview, hardReview]) for (const reply of ["once", "always", "reject"] as const) {
  const human = harness({ guardrails: "manual" })
  human.it.effect(`a Manual ${review === hardReview ? "hard" : "ordinary"} review accepts human ${reply}`, () => Effect.gen(function* () {
    const service = yield* SessionGuardrail.Service
    const waiting = yield* waitForRequest(service, review)
    expect(waiting.request.escalation).toBeUndefined()
    yield* service.reply({ sessionID: parentID, requestID: waiting.request.id, reply })
    const result = yield* Fiber.await(waiting.fiber)
    expect(Exit.isSuccess(result)).toBe(reply !== "reject" && !(review === hardReview && reply === "always"))
    if (Exit.isSuccess(result)) yield* result.value.release
    expect(human.decisions).toEqual([])
    expect(human.escalations).toEqual([])
  }))
}


const dotsCustomDecision = harness({
  guardrails: "manual",
  documents: new Map([["/global/guardrails/hard.md", markdown({ id: "custom-hard", decision: "hard_review", resource: "deploy exact" })]]),
})
dotsCustomDecision.it.effect("Dots client settles custom hard reviews without widening native delegation", () => Effect.gen(function* () {
  const service = yield* SessionGuardrail.Service
  const waiting = yield* waitForRequest(service, { sessionID: childID, action: "shell", resources: ["deploy exact"] })
  const snapshot = yield* service.requestSnapshot(childID, waiting.request.id)
  expect(snapshot!.request.hardReview).toBe(true)
  expect(snapshot!.request.standard).toBe(false)
  const source = { kind: "dots-client", anchorSessionID: parentID, bindingID: "binding", delegationID: "grant", revision: 1, exchangeID: "custom-review",
    principal: { ownerID: "owner", deviceID: "device", clientID: "client", grantID: "oauth-grant", epoch: "epoch" } } as const
  const input = { sessionID: childID, requestID: waiting.request.id, fingerprint: snapshot!.fingerprint, reply: "once" as const, source, validate: () => Effect.succeed(true) }
  expect((yield* service.replyDelegated(input).pipe(Effect.exit))._tag).toBe("Failure")
  expect((yield* service.replyDelegated({ ...input, source: { kind: "dots-delegation", anchorSessionID: parentID, delegationID: "grant", revision: 1, exchangeID: "native-review" } }).pipe(Effect.exit))._tag).toBe("Failure")
  yield* service.replyDelegated({ ...input, explicitDecision: true })
  yield* (yield* Fiber.join(waiting.fiber)).release
  expect(dotsCustomDecision.choices).toEqual([])
}))

const fullReview = harness({ deferred: true, entries: [new Config.Document({ type: "document", info: Schema.decodeUnknownSync(Config.Info)({ guardrails: { max_pending_reviews: 1 } }) })], decision: () => Effect.succeed(decisionOutput("escalate", 0.9)) })
fullReview.it.effect("a full family review box declines new guardrail deferrals without losing the existing item", () => Effect.gen(function* () {
  const service = yield* SessionGuardrail.Service
  expect(yield* service.assert(hardReview).pipe(Effect.flip)).toBeInstanceOf(SessionGuardrail.DeferredError)
  const second = yield* service.assert(hardReview).pipe(Effect.flip)
  expect(second).toBeInstanceOf(SessionGuardrail.DeclinedError)
  expect(second.message).toContain("review box is full")
  expect(yield* service.forSession(parentID)).toEqual([])
  expect((yield* SessionReviewFold.fold((yield* Database.Service).db, [parentID])).filter(SessionReviewFold.isOpen)).toHaveLength(1)
  expect((yield* service.status(parentID)).counters.find((item) => item.id === "reviews")?.current).toBe(0)
}))


const incidentSource = SessionMessage.ID.make("msg_incident_source")
const sourced = (review: SessionGuardrail.EvaluateInput, callID = "call_incident"): SessionGuardrail.EvaluateInput => ({
  ...review,
  source: { messageID: incidentSource, callID },
})
const incidentHarness = () => harness({ realAutonomy: true, guardrails: "manual" })
const seedIncidentSource = (target: ReturnType<typeof harness>) =>
  Effect.gen(function* () {
    yield* target.seed
    const { db } = yield* Database.Service
    yield* db
      .run(sql`
        INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
        VALUES (${incidentSource}, ${parentID}, 'assistant', 1, 0, 0,
          ${JSON.stringify({ agent: "build", model: { providerID: "incident-provider", id: "incident-model", variant: "high" }, content: [], time: { created: 0 } })})
      `)
      .pipe(Effect.orDie)
  })
const incidentRows = Effect.gen(function* () {
  const { db } = yield* Database.Service
  return yield* db
    .select()
    .from(ModelIncidentTable)
    .orderBy(asc(ModelIncidentTable.time_created), asc(ModelIncidentTable.id))
    .all()
    .pipe(Effect.orDie)
})
const incidentSummary = (rows: ReadonlyArray<typeof ModelIncidentTable.$inferSelect>) =>
  rows.map((row) => [row.kind, row.decided_by, row.category, row.provider_id, row.model_id, row.variant, row.agent, row.session_id])



const historical = harness()
historical.it.effect("historical model decisions and dismissals retain reviewed Session identity and timestamps", () => Effect.gen(function* () {
  const events = yield* EventRuntime.Service
  const requestID = Guardrail.RequestID.create()
  yield* events.publish(SessionEvent.GuardrailDecided, { sessionID: parentID, reviewSessionID: childID,
    requestID, reply: "reject", authority: "yolo", choice: "deny", confidence: 0.9, ruleIDs: ["standard.review.project-deletion"] })
  yield* events.publish(SessionEvent.GuardrailDismissed, { sessionID: parentID, reviewSessionID: childID,
    ruleID: "standard.review.git-destructive", confidence: 0.95 })
  const status = yield* (yield* SessionGuardrail.Service).status(parentID)
  expect(status.decisions).toEqual([expect.objectContaining({ sessionID: childID, requestID, created: expect.any(Number), reply: "reject", authority: "yolo" })])
  expect(status.dismissals).toEqual([expect.objectContaining({ sessionID: childID, created: expect.any(Number), ruleID: "standard.review.git-destructive" })])
}))

const priorYolo = harness({ realAutonomy: true })
priorYolo.it.effect("True YOLO ignores prior guardrail rejection and does not grant a later Manual request", () => Effect.gen(function* () {
  yield* priorYolo.seed
  const service = yield* SessionGuardrail.Service
  const autonomy = yield* SessionAutonomy.Service
  const waiting = yield* waitForRequest(service, hardReview)
  yield* service.reply({ sessionID: parentID, requestID: waiting.request.id, reply: "reject" })
  yield* Fiber.await(waiting.fiber)
  yield* autonomy.set({ sessionID: parentID, guardrails: "yolo", defer: true })
  yield* (yield* service.assert(hardReview)).release
  expect(yield* service.list()).toEqual([])
  yield* autonomy.set({ sessionID: parentID, guardrails: "manual", defer: false })
  yield* reject(service, hardReview)
  expect(priorYolo.choices).toEqual([])
  expect(priorYolo.verifications).toEqual([])
}))

const subagentYolo = harness({ realAutonomy: true, documents: new Map([["/global/guardrails/subagent.md",
  markdown({ id: "subagent-review", decision: "hard_review", resource: "*" }).replace("actions: [shell]", "actions: [subagent]")]]),
  entries: [new Config.Document({ type: "document", info: Schema.decodeUnknownSync(Config.Info)({ guardrails: { max_concurrent_subagents: 1 } }) })],
})
subagentYolo.it.effect("True YOLO reconciles a pending subagent with one action reservation and preserves capacity", () => Effect.gen(function* () {
  yield* subagentYolo.seed
  const service = yield* SessionGuardrail.Service
  const autonomy = yield* SessionAutonomy.Service
  const input = { sessionID: parentID, action: "subagent", resources: ["worker"] }
  const waiting = yield* waitForRequest(service, input)
  yield* service.reconcileAutonomy(parentID)
  expect((yield* service.list()).map((request) => request.id)).toEqual([waiting.request.id])
  yield* autonomy.set({ sessionID: parentID, guardrails: "yolo" })
  yield* service.reconcileAutonomy(parentID)
  const reservation = yield* Fiber.join(waiting.fiber)
  yield* service.reconcileAutonomy(parentID)
  expect((yield* service.status(parentID)).counters.find((counter) => counter.id === "subagents")?.current).toBe(1)
  expect((yield* service.assert(input).pipe(Effect.exit))._tag).toBe("Failure")
  yield* reservation.release
  yield* reservation.release
  expect((yield* service.status(parentID)).counters.every((counter) => counter.current === 0)).toBe(true)
}))

for (const reply of ["once", "always", "reject"] as const) {
  const native = incidentHarness()
  native.it.effect("native " + reply + " preserves incident attribution without model assessment", () => Effect.gen(function* () {
    yield* seedIncidentSource(native)
    const service = yield* SessionGuardrail.Service
    const waiting = yield* waitForRequest(service, sourced(ordinaryReview))
    yield* service.reply({ sessionID: parentID, requestID: waiting.request.id, reply })
    const outcome = yield* Fiber.await(waiting.fiber)
    if (Exit.isSuccess(outcome)) yield* outcome.value.release
    expect(Exit.isFailure(outcome)).toBe(reply === "reject")
    expect(incidentSummary(yield* incidentRows).map((row) => row.slice(0, 3))).toEqual(reply === "reject" ? [["guardrail-rejected", "client", "ordinary"]] : [])
    expect(native.choices).toEqual([])
  }))
}

describe("SessionGuardrail stuck review recovery", () => {
  const failureText = (exit: Exit.Exit<unknown, unknown>) => Exit.isFailure(exit) ? exit.cause.toString() : ""
  const incidents = Effect.gen(function* () {
    const database = yield* Database.Service
    return yield* database.db.select().from(ModelIncidentTable).all().pipe(Effect.orDie)
  })

  const stuck = harness({ guardrails: "auto" })
  stuck.it.effect("a hard review under Auto stays pending without a reply and records its first-ask time", () =>
    Effect.gen(function* () {
      const service = yield* SessionGuardrail.Service
      yield* TestClock.adjust("5 seconds")
      const pending = yield* waitForRequest(service, hardReviewInput)
      expect(pending.request).toMatchObject({ hardReview: true, created: 5_000 })
      yield* TestClock.adjust("1 hour")
      expect(pending.fiber.pollUnsafe()).toBeUndefined()
      expect(yield* service.forSession(parentID)).toEqual([pending.request])
      expect(yield* service.list()).toEqual([pending.request])
      yield* service.cancel({ sessionID: parentID, requestID: pending.request.id })
      expect(Exit.isFailure(yield* Fiber.await(pending.fiber))).toBe(true)
    }),
  )

  const cancelled = harness({ guardrails: "manual", realAutonomy: true })
  cancelled.it.effect("cancel fails the waiting action closed, records a durable cancelled decision, and adds no rejection", () =>
    Effect.gen(function* () {
      yield* cancelled.seed
      const service = yield* SessionGuardrail.Service
      const pending = yield* waitForRequest(service, { ...hardReviewInput, sessionID: childID })
      yield* service.cancel({ sessionID: childID, requestID: pending.request.id })
      const exit = yield* Fiber.await(pending.fiber)
      expect(failureText(exit)).toContain("Guardrail review was cancelled. This action did not run.")
      expect(yield* service.forSession(parentID)).toEqual([])
      expect(cancelled.replies).toEqual([])
      expect(cancelled.decisions).toEqual([{
        sessionID: parentID, reviewSessionID: childID, requestID: pending.request.id, reply: "reject", reason: "cancelled",
        ruleIDs: ["standard.review.project-deletion"],
      }])
      expect((yield* service.status(parentID)).decisions).toEqual([expect.objectContaining({ requestID: pending.request.id, reply: "reject", reason: "cancelled" })])
      expect(yield* incidents).toEqual([])
      expect((yield* service.cancel({ sessionID: childID, requestID: pending.request.id }).pipe(Effect.flip))._tag).toBe("Guardrail.RequestNotFoundError")

      const again = yield* waitForRequest(service, { ...hardReviewInput, sessionID: childID })
      expect(again.request.id).not.toBe(pending.request.id)
      expect(again.fiber.pollUnsafe()).toBeUndefined()
      yield* service.reply({ sessionID: childID, requestID: again.request.id, reply: "once" })
      yield* (yield* Fiber.join(again.fiber)).release

      const ordinary = yield* waitForRequest(service, ordinaryReview)
      yield* service.cancel({ sessionID: parentID, requestID: ordinary.request.id })
      expect(Exit.isFailure(yield* Fiber.await(ordinary.fiber))).toBe(true)
      const repeated = yield* waitForRequest(service, ordinaryReview)
      const snapshot = (yield* service.requestSnapshot(parentID, repeated.request.id))!
      expect(yield* service.delegatedEligible({ sessionID: parentID, requestID: repeated.request.id, fingerprint: snapshot.fingerprint, reply: "once" })).toBe(true)
      yield* service.cancel({ sessionID: parentID, requestID: repeated.request.id })
      expect(Exit.isFailure(yield* Fiber.await(repeated.fiber))).toBe(true)
      expect(yield* incidents).toEqual([])
    }),
  )

  const unknown = harness({ guardrails: "manual" })
  unknown.it.effect("cancel and retry refuse a request that is not pending", () =>
    Effect.gen(function* () {
      const service = yield* SessionGuardrail.Service
      const requestID = Guardrail.RequestID.create("grq_guardrail_unknown")
      expect((yield* service.cancel({ sessionID: parentID, requestID }).pipe(Effect.flip))._tag).toBe("Guardrail.RequestNotFoundError")
      expect((yield* service.retry({ sessionID: parentID, requestID }).pipe(Effect.flip))._tag).toBe("Guardrail.RequestNotFoundError")
    }),
  )

  const expiring = harness({
    realAutonomy: true,
    guardrails: "manual",
    entries: [new Config.Document({ type: "document", info: Schema.decodeUnknownSync(Config.Info)({ guardrails: { hard_review_expiry_minutes: 2 } }) })],
  })
  expiring.it.effect("an unanswered hard review expires after the configured age and fails closed", () =>
    Effect.gen(function* () {
      yield* expiring.seed
      const service = yield* SessionGuardrail.Service
      const ordinary = yield* waitForRequest(service, ordinaryReview)
      const hardFiber = yield* service.assert({ ...hardReviewInput, sessionID: childID }).pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      const pending = { fiber: hardFiber, request: (yield* service.forSession(parentID)).find((request) => request.hardReview)! }
      expect(pending.request).toBeDefined()
      yield* TestClock.adjust("119 seconds")
      expect(pending.fiber.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust("1 second")
      const exit = yield* Fiber.await(pending.fiber)
      expect(failureText(exit)).toContain("Guardrail review expired after 2 minutes without a decision. This action did not run.")
      expect(expiring.decisions).toEqual([expect.objectContaining({ requestID: pending.request.id, reply: "reject", reason: "expired" })])
      expect(yield* incidents).toEqual([])
      expect((yield* service.forSession(parentID)).map((request) => request.id)).toEqual([ordinary.request.id])
      yield* TestClock.adjust("1 hour")
      expect(ordinary.fiber.pollUnsafe()).toBeUndefined()
      yield* service.reply({ sessionID: parentID, requestID: ordinary.request.id, reply: "reject" })
      expect(Exit.isFailure(yield* Fiber.await(ordinary.fiber))).toBe(true)
    }),
  )

  const defaultExpiry = harness({ guardrails: "manual" })
  defaultExpiry.it.effect("hard reviews expire after 1440 minutes by default", () =>
    Effect.gen(function* () {
      const service = yield* SessionGuardrail.Service
      const pending = yield* waitForRequest(service, hardReviewInput)
      yield* TestClock.adjust("1439 minutes")
      expect(pending.fiber.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust("1 minute")
      expect(failureText(yield* Fiber.await(pending.fiber))).toContain("expired after 1440 minutes")
    }),
  )

  const retried = harness({ guardrails: "manual", realAutonomy: true })
  retried.it.effect("retry re-presents the same pending review without settling it, and a later once reply settles it exactly once", () =>
    Effect.gen(function* () {
      yield* retried.seed
      const service = yield* SessionGuardrail.Service
      yield* TestClock.adjust("3 seconds")
      const pending = yield* waitForRequest(service, hardReviewInput)
      expect(pending.request.created).toBe(3_000)
      const before = yield* service.status(parentID)
      const ruleDecisionsBefore = retried.ruleDecisions.length
      yield* TestClock.adjust("20 minutes")
      for (const _ of [1, 2]) expect(yield* service.retry({ sessionID: parentID, requestID: pending.request.id })).toEqual(pending.request)
      expect(retried.asked).toEqual([pending.request, pending.request, pending.request])
      expect(retried.asked.map((request) => [request.id, request.created])).toEqual(Array(3).fill([pending.request.id, 3_000]))
      expect(pending.fiber.pollUnsafe()).toBeUndefined()
      expect(yield* service.forSession(parentID)).toEqual([pending.request])
      expect(retried.replies).toEqual([])
      expect(retried.ruleDecisions).toHaveLength(ruleDecisionsBefore)
      expect(retried.decisions).toEqual([])
      const after = yield* service.status(parentID)
      expect(after.decisions).toBeUndefined()
      expect({ approvals: after.approvals, blocked: after.blocked, counters: after.counters })
        .toEqual({ approvals: before.approvals, blocked: before.blocked, counters: before.counters })
      expect(yield* incidents).toEqual([])
      yield* service.reply({ sessionID: parentID, requestID: pending.request.id, reply: "once" })
      yield* (yield* Fiber.join(pending.fiber)).release
      expect(retried.replies).toEqual([expect.objectContaining({ requestID: pending.request.id, reply: "once" })])
      expect((yield* service.status(parentID)).approvals).toBe(before.approvals + 1)
      expect((yield* service.reply({ sessionID: parentID, requestID: pending.request.id, reply: "once" }).pipe(Effect.flip))._tag).toBe("Guardrail.RequestNotFoundError")
      expect((yield* service.retry({ sessionID: parentID, requestID: pending.request.id }).pipe(Effect.flip))._tag).toBe("Guardrail.RequestNotFoundError")
      expect(retried.replies).toHaveLength(1)
    }),
  )

  const legacy = harness({ guardrails: "manual", realAutonomy: true })
  legacy.it.effect("v0.12.2 decided and review-item rows without created or reason replay through status and the review fold", () =>
    Effect.gen(function* () {
      yield* legacy.seed
      const database = yield* Database.Service
      const service = yield* SessionGuardrail.Service
      const decided = {
        sessionID: parentID, reviewSessionID: childID, requestID: "grq_legacy_decided", reply: "reject",
        ruleIDs: ["standard.review.git-destructive"], source: { messageID: "msg_legacy", callID: "call_legacy" },
      }
      const deferred = {
        sessionID: childID, itemID: "rvw_legacy", kind: "guardrail", reason: "defer_entry", origin: { requestID: "grq_legacy_review" },
        payload: {
          type: "guardrail", action: "shell", resources: ["git reset --hard"], ruleIDs: ["standard.review.git-destructive"],
          reason: "Destructive Git", hardReview: true, directories: [], fingerprint: "a".repeat(64), requestID: "grq_legacy_review",
        },
      }
      yield* database.db.insert(EventSequenceTable).values([{ aggregate_id: parentID, seq: 10_000 }, { aggregate_id: childID, seq: 10_000 }])
        .onConflictDoNothing().run().pipe(Effect.orDie)
      yield* database.db.insert(EventTable).values([
        { id: "evt_legacy_decided" as EventRuntime.ID, aggregate_id: parentID, seq: 10_000, created: 5_000, type: EventRuntime.versionedType(SessionEvent.GuardrailDecided.type, 1), data: decided },
        { id: "evt_legacy_review" as EventRuntime.ID, aggregate_id: childID, seq: 10_000, created: 6_000, type: EventRuntime.versionedType(SessionEvent.Review.Deferred.type, 1), data: deferred },
      ]).run().pipe(Effect.orDie)
      const status = yield* service.status(parentID)
      expect(status.decisions).toHaveLength(1)
      expect<unknown>(Object.fromEntries(Object.entries(status.decisions![0]!).filter(([, value]) => value !== undefined))).toEqual({
        sessionID: childID, created: 5_000, requestID: "grq_legacy_decided", reply: "reject",
        ruleIDs: ["standard.review.git-destructive"], source: { messageID: "msg_legacy", callID: "call_legacy" },
      })
      expect<unknown>(Schema.encodeSync(Guardrail.Status)(status).decisions).toEqual([{
        sessionID: childID, created: 5_000, requestID: "grq_legacy_decided", reply: "reject",
        ruleIDs: ["standard.review.git-destructive"], source: { messageID: "msg_legacy", callID: "call_legacy" },
      }])
      const items = yield* SessionReviewFold.fold(database.db, [childID])
      expect<unknown>(items).toEqual([{
        itemID: "rvw_legacy", sessionID: childID, kind: "guardrail", reason: "defer_entry", origin: { requestID: "grq_legacy_review" },
        payload: deferred.payload, created: 6_000, consumed: false, revision: 10_000,
      }])
    }),
  )
})
