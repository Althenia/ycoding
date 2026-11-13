import { afterAll, describe, expect, test } from "bun:test"
import { $ } from "bun"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer, Schema } from "effect"
import { eq } from "drizzle-orm"
import { Model } from "@ycoding-ai/schema/model"
import { Provider } from "@ycoding-ai/schema/provider"
import { Agent } from "../src/agent"
import { AgentPlugin } from "../src/plugin/agent"
import { Config } from "../src/config"
import { ConfigCapabilities } from "../src/config/capabilities"
import { CoordinationTool } from "../src/tool/coordination"
import { CoordinationAccess } from "../src/session/coordination-access"
import { CoordinationRuntime } from "../src/session/coordination-runtime"
import { CoordinationService } from "../src/coordination/index"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { makeGlobalNode, makeLocationNode } from "../src/effect/app-node"
import { LayerNode } from "../src/effect/layer-node"
import { LayerNodePlatform } from "../src/effect/app-node-platform"
import { Database } from "../src/database/database"
import { EventRuntime } from "../src/event"
import { FSUtil } from "../src/fs-util"
import { Git } from "../src/git"
import { Global } from "../src/global"
import { Image } from "../src/image"
import { Location } from "../src/location"
import { Permission } from "../src/permission"
import { Project } from "../src/project"
import { ProjectCopy } from "../src/project/copy"
import { ProjectDirectories } from "../src/project/directories"
import { ProjectDirectoryTable, ProjectTable } from "../src/project/sql"
import { AbsolutePath } from "../src/schema"
import { Session } from "../src/session"
import { SessionEvent } from "../src/session/event"
import { SessionExecution } from "../src/session/execution"
import { SessionGuardrail } from "../src/session/guardrail"
import { SessionOrchestration } from "../src/session/orchestration"
import { SessionProjector } from "../src/session/projector"
import { SessionSchema } from "../src/session/schema"
import { SessionTable } from "../src/session/sql"
import { ToolOutputStore } from "../src/tool-output-store"
import { ToolRegistry } from "../src/tool/registry"
import { WorktreeTool } from "../src/tool/worktree"
import { Hash } from "../src/util/hash"
import { testEffect } from "./lib/effect"
import { imagePassthrough } from "./lib/image"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { agentHost, host } from "./plugin/host"

const decode = Schema.decodeUnknownSync(CoordinationTool.Input, { onExcessProperty: "error" })

const valid = {
  list: { action: "list" },
  inspect: { action: "inspect", sessionID: "ses_member", requestID: "per_one" },
  send: { action: "send", sessionID: "ses_member", text: "Inspect" },
  answer: { action: "answer", sessionID: "ses_member", requestID: "per_one", kind: "permission", fingerprint: "fp", rationale: "In scope" },
  escalate: { action: "escalate", sessionID: "ses_member", requestID: "per_one", kind: "permission", fingerprint: "fp", reason: "Needs the human" },
  interrupt: { action: "interrupt", sessionID: "ses_member" },
  assign: { action: "assign", sessionID: "ses_member", ownerSessionID: "ses_owner" },
  release: { action: "release", sessionID: "ses_member", reason: "completed" },
  create: { action: "create", name: "lane-one" },
} as const

test("project exposes only list, inspect, send, answer, escalate, interrupt, assign, release and create without caller or group overrides", () => {
  expect(CoordinationTool.name).toBe("project")
  for (const payload of Object.values(valid)) expect(decode(payload)).toEqual(payload as never)
  expect(Object.keys(valid)).toEqual(["list", "inspect", "send", "answer", "escalate", "interrupt", "assign", "release", "create"])
  const complete = { sessionID: "ses_member", requestID: "per_one", ownerSessionID: "ses_owner", reason: "completed", text: "Inspect", kind: "permission", fingerprint: "fp", rationale: "In scope" }
  for (const action of ["update", "delete", "get", "arm", "stop", "complete", "claim", "dispatch", "receipts", "wait", "cancelWait", "capacity", "decide", "transfer", "unassign"])
    expect(() => decode({ action, ...complete })).toThrow()
  for (const payload of Object.values(valid))
    for (const extra of [{ groupID: "cgrp_other" }, { caller: "ses_other" }, { actor: { kind: "human" } }, { coordinatorSessionID: "ses_other" }, { metadata: {} }])
      expect(() => decode({ ...payload, ...extra })).toThrow()
})

test("inspect reads one pending request by native identity and nothing else", () => {
  expect(decode({ ...valid.inspect, requestID: "x".repeat(256) })).toMatchObject({ action: "inspect" })
  for (const invalid of [{ requestID: "" }, { requestID: "x".repeat(257) }, { sessionID: "msg_member" }, { kind: "permission" }, { fingerprint: "fp" }, { decision: "decline" }])
    expect(() => decode({ ...valid.inspect, ...invalid })).toThrow()
  expect(() => decode({ action: "inspect", sessionID: "ses_member" })).toThrow()
  expect(() => decode({ action: "inspect", requestID: "per_one" })).toThrow()
})

test("assign names one owner Session and release one of the closed reasons", () => {
  for (const reason of ["completed", "released"]) expect(decode({ ...valid.release, reason })).toEqual({ ...valid.release, reason } as never)
  for (const invalid of [{ ownerSessionID: "" }, { ownerSessionID: "msg_owner" }, { ownerSessionID: ["ses_a", "ses_b"] }, { reason: "completed" }, { sessionID: "msg_member" }])
    expect(() => decode({ ...valid.assign, ...invalid })).toThrow()
  for (const invalid of [{ reason: "" }, { reason: "done" }, { reason: "Released" }, { ownerSessionID: "ses_owner" }, { sessionID: "msg_member" }])
    expect(() => decode({ ...valid.release, ...invalid })).toThrow()
  expect(() => decode({ action: "assign", sessionID: "ses_member" })).toThrow()
  expect(() => decode({ action: "assign", ownerSessionID: "ses_owner" })).toThrow()
  expect(() => decode({ action: "release", sessionID: "ses_member" })).toThrow()
})

test("create names a managed worktree and optionally an owner, title, first prompt and model", () => {
  const input = { action: "create", name: "lane-1", ownerSessionID: "ses_owner", title: "Lane one", prompt: "Implement", model: { providerID: "fixture", id: "model", variant: "high" } }
  expect(decode(input)).toEqual(input as never)
  expect(decode({ ...input, name: "a".repeat(63), prompt: "x".repeat(32000) })).toMatchObject({ action: "create" })
  for (const invalid of [{ name: "" }, { name: "Lane" }, { name: "-lane" }, { name: "lane_one" }, { name: "a".repeat(64) }, { ownerSessionID: "msg_owner" },
    { title: "" }, { title: " " }, { prompt: "" }, { prompt: "x".repeat(32001) }, { model: "fixture/model" }, { sessionID: "ses_member" }, { branch: "lane-1" }, { directory: "/tmp/lane" }])
    expect(() => decode({ ...input, ...invalid })).toThrow()
  expect(() => decode({ action: "create" })).toThrow()
  expect(decode({ ...input, repository: "/work/other-repository" })).toMatchObject({ repository: "/work/other-repository" })
  for (const repository of ["", "x".repeat(4097)]) expect(() => decode({ ...input, repository })).toThrow()
})

test("send accepts delivery, retry identity and optional model, but no selection or lease", () => {
  const input = { action: "send", sessionID: "ses_member", text: "Inspect", delivery: "queue", messageID: "msg_once", model: { providerID: "fixture", id: "model", profile: "work", variant: "high" } }
  expect(decode(input)).toEqual(input as never)
  for (const extra of [{ selection: {} }, { generation: 1 }, { leaseMs: 1000 }, { delivery: "later" }, { text: "" }])
    expect(() => decode({ ...input, ...extra })).toThrow()
})

test("answer requires native identity, fingerprint and rationale", () => {
  const input = { action: "answer", sessionID: "ses_member", kind: "question", requestID: "frm_one", fingerprint: "fp", rationale: "The scope specifies Markdown", confidence: 0.95, answer: { format: "markdown" } }
  expect(decode(input)).toEqual(input as never)
  for (const extra of [{ rationale: " " }, { fingerprint: "" }, { confidence: 1.1 }, { kind: "human" }, { coordinatorSessionID: "ses_other" }])
    expect(() => decode({ ...input, ...extra })).toThrow()
})

test("answer accepts an explicit approve or decline decision", () => {
  const input = { action: "answer", sessionID: "ses_member", kind: "permission", requestID: "per_one", fingerprint: "fp", rationale: "Outside the assigned files" }
  expect(decode({ ...input, decision: "decline" })).toEqual({ ...input, decision: "decline" } as never)
  expect(decode({ ...input, decision: "approve" })).toMatchObject({ decision: "approve" })
  for (const decision of ["reject", "deny", "always", ""]) expect(() => decode({ ...input, decision })).toThrow()
})

test("escalate requires native identity, fingerprint and a bounded reason", () => {
  const input = { action: "escalate", sessionID: "ses_member", kind: "review", requestID: "grq_one", fingerprint: "fp", reason: "Touches deployment config" }
  expect(decode(input)).toEqual(input as never)
  for (const extra of [{ reason: " " }, { reason: "x".repeat(501) }, { fingerprint: "" }, { kind: "human" }, { to: "human" }, { decision: "approve" }])
    expect(() => decode({ ...input, ...extra })).toThrow()
  expect(() => decode({ action: "escalate", sessionID: "ses_member", kind: "review", requestID: "grq_one", fingerprint: "fp" })).toThrow()
})

test("the tool description names the supervision chain", () => {
  expect(CoordinationTool.description).toContain("escalate")
  expect(CoordinationTool.description).toContain("decline")
  for (const text of [
    "Executor children inherit no controller authority.",
    "A member with a pending question, permission or review cannot receive input until the request settles, so the send is refused naming each pending request; settle it with answer, escalate it, or interrupt the member to withdraw it.",
    "The request stays open as the member's prompt: the user answers it in that member Session, and messages or answers relayed through the Master cannot settle it.",
    "its delegation class as risk information for your decision: routine, decline-only or explicit-decision:<reason>. The class never limits answer.",
    "delegates implementation to executors",
    "inspect:",
    "answer: settle any pending member question, form, permission or review yourself, in every autonomy mode, Manual included: routine, decline-only and every explicit-decision class, hard and custom-rule guardrail reviews, and outside-repository reviews.",
    "approve (the default decision) allows once, decline rejects with your rationale as the member's feedback, and an answer settles a question or form.",
    "A deny rule or the permission ceiling that covers the request still denies it, even when you approve.",
    "A guardrail review raised by an invalid guardrail configuration cannot be approved because its deny rules are unreadable: answer returns escalated with reason configuration-invalid, and a decline settles it.",
    "When answer refuses, errors or is uncertain it returns escalated with a reason; escalate that request.",
    "escalate: pass a pending request up the chain with a reason when it needs the user's decision, or when answer returned escalated, errored or was uncertain.",
    "assign: Master only.",
    "create: Master only.",
    "An optional repository (absolute directory path inside a Git repository) creates the worktree for that repository instead of the current Location's, so a Master outside any repository can create members; the managed parent, permission, guardrail, existing-name and branch rules are the worktree tool's, and a path outside any Git repository fails naming the path.",
    "release: Master only. The Master",
    "go only to the member's live recorded owner as Project notifications. Unowned routine events remain held for the next owner; material requests and failures reach the Master as Project escalations, never as member notifications.",
    "A member's completed notification is sent only when its turn settled with no background work left and the member has no pending input of any kind (steer, queue or compaction barrier).",
    "under your session's permission ceiling plus your agent's effective deny rules (agent denies not covered by a later non-deny agent rule with the same action or \"*\" and the same resource or \"*\") with title",
    "The notification does not read the member's goal state, open reviews, an active revert or pending rows of descendant Sessions; its behavior with an active goal has not been verified.",
    "A supervising or completed owner resumes only when the notification wakes its receiver (urgent, or the Project is active), no review is open on that owner and the owner Session has no active revert.",
    "Waiting and starting owners keep notifications pending until they run.",
    "Cancelling, cancelled, failed and lost owners never receive member notifications.",
    "A pending request raised by a member's subagent or any deeper descendant Session is listed under that member with requestSessionID naming the requesting Session; inspect, answer and escalate it with the member's sessionID. It neither makes the member waiting nor blocks send.",
    "A request from a member's descendant stays open in its requesting Session, returned as requestSessionID, and the reasons attach to that Session's prompt.",
    "Questions, forms, permission asks and guardrail reviews raised by a member's descendant Sessions are member events whose notifications carry requestSessionID.",
  ]) expect(CoordinationTool.description).toContain(text)
  for (const text of ["only the user decides it", "answer may only decline", "every guardrail review, and uncertain cases are refused", "Escalate whatever answer refuses"])
    expect([text, CoordinationTool.description.includes(text)]).toEqual([text, false])
})

test("effectiveDenies keeps repeated identical denies and keeps only the last of a deny, an allow and a deny", () => {
  const first = { action: "shell", resource: "a*", effect: "deny" as const }
  const second = { action: "shell", resource: "a*", effect: "deny" as const }
  const repeated = Permission.effectiveDenies([first, second])
  expect(repeated).toEqual([first, second])
  expect(repeated[0]).toBe(first)
  expect(repeated[1]).toBe(second)
  const allowed = { action: "shell", resource: "a*", effect: "allow" as const }
  const sandwiched = Permission.effectiveDenies([first, allowed, second])
  expect(sandwiched).toHaveLength(1)
  expect(sandwiched[0]).toBe(second)
  expect(Permission.effectiveDenies([])).toEqual([])
})

test("scope gating denies the project tool outside controller roles and file edits and mutating shell commands to the Master's family", () => {
  const project = { action: "project", resource: "*", effect: "deny" } as const
  const edit = { action: "edit", resource: "*", effect: "deny" } as const
  expect(CoordinationAccess.visibility(undefined, false)).toEqual([project])
  expect(CoordinationAccess.visibility("executor", false)).toEqual([project])
  expect(CoordinationAccess.visibility("executor", true)).toEqual([project, edit])
  expect(CoordinationAccess.visibility("master", true)).toEqual([edit])
  expect(CoordinationAccess.visibility("supervisor", true)).toEqual([edit])
  expect(CoordinationAccess.execution(false, { action: "shell", resources: ["git commit -m x"] })).toEqual([])
  expect(CoordinationAccess.execution(true, { action: "edit", resources: ["src/a.ts"] })).toEqual([edit])
  expect(CoordinationAccess.execution(true, { action: "shell", resources: ["git status", "git commit -m x", "sed -i s/a/b/ f", "bun run build"] })).toEqual([
    edit,
    ...["git commit -m x", "sed -i s/a/b/ f", "bun run build"].map((resource) => ({ action: "shell", resource, effect: "deny" }) as const),
  ])
})

const repository = await tmpdir()
await $`git init`.cwd(repository.path).quiet()
await $`git config user.email test@ycoding.test`.cwd(repository.path).quiet()
await $`git config user.name Test`.cwd(repository.path).quiet()
await $`git commit --allow-empty -m root`.cwd(repository.path).quiet()
const source = AbsolutePath.make(await fs.realpath(repository.path))
const data = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "project-tool-data-"))
const audit = { permissions: [] as string[], guardrails: [] as string[] }
const permission = Layer.mock(Permission.Service, {
  evaluateEffective: () => Effect.succeed("ask"),
  assert: (input) => Effect.sync(() => { audit.permissions.push(`${input.action} ${input.resources.join(" ")}`) }),
  ask: () => Effect.die("unused"),
})
const guardrail = Layer.mock(SessionGuardrail.Service, {
  reviewPolicy: { enabled: true, decideReviews: false, decideHardReviews: true },
  assert: (input) =>
    Effect.sync(() => {
      const operation = input.metadata?.operation
      audit.guardrails.push(`${input.action} ${typeof operation === "string" ? operation : ""} ${input.resources.join(" ")}`)
      return { release: Effect.void }
    }),
})
const masterAgent = { permissions: [] as Permission.Ruleset, resolved: [] as Array<string | undefined> }
const agents = Layer.mock(Agent.Service, {
  resolve: (id) =>
    Effect.sync(() => {
      masterAgent.resolved.push(id)
      return Agent.Info.make({ ...Agent.Info.empty(Agent.ID.make(id ?? "build")), permissions: masterAgent.permissions })
    }),
})
const configured: { capabilities?: ConfigCapabilities.Info } = {}
const config = Layer.mock(Config.Service, {
  entries: () => Effect.sync(() => [new Config.Document({ type: "document", info: new Config.Info(configured.capabilities === undefined ? {} : { capabilities: configured.capabilities }) })]),
})
const runtimeNode = makeGlobalNode({
  service: CoordinationRuntime.Service,
  layer: Layer.effect(CoordinationRuntime.Service, Effect.gen(function* () {
    const database = yield* Database.Service
    return CoordinationRuntime.Service.of(CoordinationRuntime.make({
      db: database.db,
      events: yield* EventRuntime.Service,
      coordination: yield* CoordinationService.Service,
      sessions: yield* Session.Service,
      orchestration: yield* SessionOrchestration.Service,
      execution: yield* SessionExecution.Service,
      decisions: {
        pending: () => Effect.succeed([]),
        evaluate: () => Effect.die("unused"),
        escalate: (input) => Effect.succeed({
          outcome: "escalated" as const, kind: input.kind, requestID: input.requestID, fingerprint: input.fingerprint, actor: "coordinator" as const, settled: false as const,
          to: "client" as const, coordinationEscalation: { reasons: [{ sessionID: input.coordinatorSessionID, reason: input.reason }] },
        }),
      },
      validateModel: () => Effect.void,
      jobs: { list: () => Effect.succeed([]), outstandingSessions: () => Effect.succeed(new Set<SessionSchema.ID>()) },
    }))
  })),
  deps: [Database.node, EventRuntime.node, CoordinationService.node, Session.node, SessionOrchestration.node, SessionExecution.node],
})
const plugins = makeLocationNode({
  name: "test/project-tool-plugins",
  layer: Layer.effectDiscard(Effect.gen(function* () {
    yield* registerToolPlugin(WorktreeTool.Plugin)
    yield* registerToolPlugin(CoordinationTool.Plugin)
  })),
  deps: [ToolRegistry.toolsNode, Location.node, Git.node, Global.node, Project.node, ProjectCopy.node, Permission.node, SessionGuardrail.node, FSUtil.node, Agent.node, Config.node, CoordinationRuntime.node],
})
const project = { id: Project.ID.make("project-tool-test"), directory: source }
const model = Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("model") })
const integrationAt = (active: Location.Interface) => testEffect(AppNodeBuilder.build(
  LayerNode.group([
    ToolRegistry.node, ToolRegistry.toolsNode, plugins, ProjectCopy.node, Database.node, EventRuntime.node, ProjectDirectories.node, Git.node, FSUtil.node,
    LayerNodePlatform.filesystem, LayerNodePlatform.path, SessionProjector.node, Session.node, SessionExecution.node, SessionOrchestration.node,
    CoordinationService.node, CoordinationRuntime.node, Project.node,
  ]),
  [
    [Location.node, Layer.succeed(Location.Service, Location.Service.of(active))],
    [Global.node, Global.layerWith({ data })],
    [Permission.node, permission],
    [SessionGuardrail.node, guardrail],
    [Agent.node, agents],
    [Config.node, config],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    [Image.node, imagePassthrough],
    [SessionExecution.node, SessionExecution.noopLayer],
    [CoordinationRuntime.node, runtimeNode],
  ],
))
const integration = integrationAt({ directory: source, project })
const detached = integrationAt({ directory: AbsolutePath.make(data), project: { id: Project.ID.make("project-tool-detached"), directory: AbsolutePath.make(data) } })

const godAgents = AppNodeBuilder.build(LayerNode.group([Agent.node, EventRuntime.node, Location.node]), [
  [Location.node, Layer.succeed(Location.Service, Location.Service.of(location({ directory: source })))],
])
const godPermissions = Effect.gen(function* () {
  const agents = yield* Agent.Service
  yield* AgentPlugin.Plugin.effect(host({ agent: agentHost(agents) })).pipe(
    Effect.provideService(Location.Service, Location.Service.of(location({ directory: source }))),
  )
  const god = yield* agents.resolve(Agent.defaultID)
  return god?.permissions ?? []
}).pipe(Effect.provide(godAgents), Effect.scoped)

const Created = Schema.Struct({ sessionID: SessionSchema.ID, directory: Schema.String, branch: Schema.String, owner: Schema.optional(Schema.Unknown) })

const projectSetup = Effect.gen(function* () {
  audit.permissions.length = 0
  audit.guardrails.length = 0
  masterAgent.permissions = []
  masterAgent.resolved.length = 0
  delete configured.capabilities
  const registry = yield* ToolRegistry.Service
  const sessions = yield* Session.Service
  const events = yield* EventRuntime.Service
  const coordination = yield* CoordinationService.Service
  const git = yield* Git.Service
  const database = yield* Database.Service
  yield* database.db.insert(ProjectTable).values({ id: project.id, worktree: source, sandboxes: [], time_created: 1, time_updated: 1 })
    .onConflictDoNothing().run().pipe(Effect.orDie)
  yield* database.db.insert(ProjectDirectoryTable).values({ project_id: project.id, directory: source }).onConflictDoNothing().run().pipe(Effect.orDie)
  const master = yield* sessions.create({ location: { directory: AbsolutePath.make(data) }, title: "master", model })
  const group = yield* coordination.create({ name: "Lanes", masterSessionID: master.id, memberSessionIDs: [] })
  const call = (id: string, name: string, input: unknown, sessionID = master.id) =>
    executeTool(registry, { sessionID, agent: toolIdentity.agent, messageID: toolIdentity.messageID, call: { type: "tool-call", id, name, input } })
  const parsed = (result: { readonly type: string; readonly value: unknown }) => {
    expect(result).toMatchObject({ type: "text" })
    expect(typeof result.value).toBe("string")
    if (typeof result.value !== "string") throw new Error("Expected serialized project creation result")
    return Schema.decodeUnknownSync(Schema.fromJsonString(Created))(result.value)
  }
  const common = yield* Effect.promise(() => fs.realpath(path.join(source, ".git")))
  const managed = path.join(data, "worktrees", `repo_${Hash.sha256(common)}`)
  const count = () => database.db.select({ id: SessionTable.id }).from(SessionTable).all().pipe(Effect.orDie, Effect.map((rows) => rows.length))
  const exists = (name: string) => Effect.promise(() => fs.stat(path.join(managed, name)).then(() => true, () => false))
  return { sessions, events, coordination, git, database, master, group, call, parsed, managed, count, exists }
})

describe("project tool through the tool registry", () => {
  afterAll(async () => {
    await repository[Symbol.asyncDispose]()
    await fs.rm(data, { recursive: true, force: true })
  })

  integration.live("a Master escalation to the user names the member Session where the user answers and states that messages cannot settle it", () =>
    Effect.gen(function* () {
      const fixture = yield* projectSetup
      const member = yield* fixture.sessions.create({ location: { directory: AbsolutePath.make(data) }, title: "Docs lane" })
      yield* fixture.coordination.addMember(fixture.group.id, { sessionID: member.id })
      const result = yield* fixture.call("escalate-client", "project", { action: "escalate", sessionID: member.id, requestID: "frm_wait", kind: "question", fingerprint: "fp_wait", reason: "Needs the user" })
      expect(result.type).toBe("text")
      const text = String(result.value)
      expect(text).toContain("stays open as the member's prompt")
      expect(text).toContain(`answers it in member Session ${member.id} (Docs lane)`)
      expect(text).toContain("messages or answers relayed through the Master cannot settle it")
    }), 60_000)

  integration.live("creates members through the worktree tool's path and refuses an existing name with the worktree tool's message", () =>
    Effect.gen(function* () {
      const fixture = yield* projectSetup
      const owner = yield* fixture.sessions.create({ parentID: fixture.master.id, title: "owner" })
      yield* fixture.events.publish(SessionEvent.Task.Updated, Schema.decodeUnknownSync(SessionEvent.Task.Updated.data)({ sessionID: owner.id, change: {
        type: "launched", parentID: fixture.master.id, parentAssistantMessageID: "msg_project_tool_parent", toolCallID: "call_project_tool",
        inputID: "msg_project_tool_child", description: "owner", agent: "build", model,
        promptDigest: "digest", background: true, delivery: "steer",
      } }))
      yield* fixture.events.publish(SessionEvent.Task.Updated, { sessionID: owner.id, change: { type: "started" } })

      const first = fixture.parsed(yield* fixture.call("create-one", "project", { action: "create", name: "lane-one", model }))
      const second = fixture.parsed(yield* fixture.call("create-two", "project", { action: "create", name: "lane-two", ownerSessionID: owner.id, model }))
      expect(first).toMatchObject({ directory: path.join(fixture.managed, "lane-one"), branch: "lane-one" })
      expect(second).toMatchObject({ directory: path.join(fixture.managed, "lane-two"), branch: "lane-two", owner: { sessionID: owner.id, title: "owner" } })
      expect(first.owner).toBeUndefined()
      for (const created of [first, second]) {
        const found = yield* fixture.git.repo.discover(AbsolutePath.make(created.directory))
        expect(found).toBeDefined()
        if (found) expect(yield* fixture.git.history.branch(found)).toBe(created.branch)
        const member = yield* fixture.sessions.get(created.sessionID)
        expect(member.parentID).toBeUndefined()
        expect(member.location.directory).toBe(AbsolutePath.make(created.directory))
      }
      expect((yield* fixture.coordination.get(fixture.group.id)).memberSessionIDs.slice().sort()).toEqual([first.sessionID, second.sessionID].sort())
      expect(audit.permissions).toEqual([`worktree ${path.join(fixture.managed, "lane-one")}`, `worktree ${path.join(fixture.managed, "lane-two")}`])
      expect(audit.guardrails).toEqual([`file_mutation create_git_worktree ${path.join(fixture.managed, "lane-one")}`, `file_mutation create_git_worktree ${path.join(fixture.managed, "lane-two")}`])

      const before = yield* fixture.count()
      const duplicate = yield* fixture.call("create-duplicate", "project", { action: "create", name: "lane-one", model })
      const direct = yield* fixture.call("worktree-duplicate", "worktree", { action: "create", name: "lane-one" })
      expect(duplicate).toEqual({ type: "error", value: "A worktree named lane-one already exists" })
      expect(direct).toEqual(duplicate)
      expect(yield* fixture.count()).toBe(before)
      expect((yield* fixture.call("create-by-owner", "project", { action: "create", name: "lane-three", model }, owner.id)).type).toBe("error")
      expect(yield* fixture.count()).toBe(before)
      expect(yield* fixture.exists("lane-three")).toBe(false)
      expect(yield* fixture.database.db.select().from(SessionTable).where(eq(SessionTable.directory, path.join(fixture.managed, "lane-three"))).all().pipe(Effect.orDie)).toEqual([])
    }), 60_000)

  integration.live("a created member's ceiling carries the Master's ceiling and the deny rules of the Master's resolved calling agent", () =>
    Effect.gen(function* () {
      const fixture = yield* projectSetup
      yield* fixture.database.db.update(SessionTable).set({ permission: [{ action: "bash", resource: "*", effect: "deny" }] })
        .where(eq(SessionTable.id, fixture.master.id)).run().pipe(Effect.orDie)
      masterAgent.permissions = [{ action: "webfetch", resource: "*", effect: "deny" }, { action: "read", resource: "*", effect: "allow" }]
      const created = fixture.parsed(yield* fixture.call("create-ceiling", "project", { action: "create", name: "lane-ceiling", model }))
      expect(masterAgent.resolved).toEqual([toolIdentity.agent])
      expect((yield* fixture.sessions.get(created.sessionID)).permissionCeiling).toEqual([
        { action: "bash", resource: "*", effect: "deny" },
        { action: "webfetch", resource: "*", effect: "deny" },
      ])
    }), 60_000)

  const deny = (action: string, resource = "*") => ({ action, resource, effect: "deny" as const })
  const allow = (action: string, resource = "*") => ({ action, resource, effect: "allow" as const })
  const ask = (action: string, resource = "*") => ({ action, resource, effect: "ask" as const })
  for (const scenario of [
    { lane: "lane-override-allow", name: "a deny that a later allow overrides is left out of the ceiling", rules: [deny("question"), allow("question")], ceiling: [] },
    { lane: "lane-override-ask", name: "a deny that a later ask overrides is left out of the ceiling", rules: [deny("question"), ask("question")], ceiling: [] },
    { lane: "lane-deny-last", name: "a deny placed after the allow stays in the ceiling", rules: [allow("question"), deny("question")], ceiling: [deny("question")] },
    { lane: "lane-plain-deny", name: "a deny with no override stays in the ceiling", rules: [deny("plan_exit"), allow("read")], ceiling: [deny("plan_exit")] },
    { lane: "lane-webfetch-deny", name: "an agent-specific webfetch deny stays in the ceiling", rules: [allow("*"), deny("webfetch"), allow("read")], ceiling: [deny("webfetch")] },
    { lane: "lane-wildcard-pattern", name: "a deny whose wildcard pattern a later allow of a different pattern may not cover", rules: [deny("shell", "a*"), allow("shell", "a?")], ceiling: [deny("shell", "a*")] },
    { lane: "lane-shadow-star", name: "a deny shadowed by a later allow of the same action and any resource is left out", rules: [deny("shell", "a*"), allow("shell", "*")], ceiling: [] },
    { lane: "lane-shadow-any-action", name: "a deny shadowed by a later allow of any action and any resource is left out", rules: [deny("shell", "a*"), allow("*", "*")], ceiling: [] },
    { lane: "lane-shadow-same", name: "a deny shadowed by a later allow of the same text is left out", rules: [deny("shell", "a*"), allow("shell", "a*")], ceiling: [] },
    { lane: "lane-partial", name: "a deny that a later allow only partly overlaps stays", rules: [deny("shell", "git push"), allow("shell", "git *")], ceiling: [deny("shell", "git push")] },
    { lane: "lane-allow-first", name: "an allow that precedes the deny stays out of the way", rules: [allow("shell", "*"), deny("shell", "a*")], ceiling: [deny("shell", "a*")] },
    { lane: "lane-any-any", name: "a deny of any action and resource that a later allow of one action does not cover stays", rules: [deny("*", "*"), allow("shell", "*")], ceiling: [deny("*", "*")] },
    { lane: "lane-narrow-resource", name: "a deny of any resource that a later allow of a narrower resource does not cover stays", rules: [deny("shell", "*"), allow("shell", "a*")], ceiling: [deny("shell", "*")] },
    { lane: "lane-narrow-any-action", name: "a deny of any resource that a later allow of any action and a narrower resource does not cover stays", rules: [deny("shell", "*"), allow("*", "a*")], ceiling: [deny("shell", "*")] },
    { lane: "lane-repeated", name: "repeated identical denies collapse to one ceiling rule", rules: [deny("shell", "a*"), deny("shell", "a*")], ceiling: [deny("shell", "a*")] },
    { lane: "lane-deny-allow-deny", name: "a deny, an allow and a deny leave one ceiling rule", rules: [deny("question"), allow("question"), deny("question")], ceiling: [deny("question")] },
    { lane: "lane-mixed", name: "only the denies that stay effective reach the ceiling", rules: [deny("question"), deny("plan_exit"), deny("webfetch"), allow("question")], ceiling: [deny("plan_exit"), deny("webfetch")] },
  ])
    integration.live(`a created member's ceiling carries only the effective agent denies: ${scenario.name}`, () =>
      Effect.gen(function* () {
        const fixture = yield* projectSetup
        masterAgent.permissions = scenario.rules
        const created = fixture.parsed(yield* fixture.call("create-effective", "project", { action: "create", name: scenario.lane, model }))
        expect((yield* fixture.sessions.get(created.sessionID)).permissionCeiling ?? []).toEqual(scenario.ceiling)
      }), 60_000)

  integration.live("an empty agent rule list leaves a member ceiling equal to the Master session ceiling copied in full", () =>
    Effect.gen(function* () {
      const fixture = yield* projectSetup
      const sessionCeiling = [deny("bash"), deny("edit", "/etc/*"), deny("webfetch", "*.internal")]
      yield* fixture.database.db.update(SessionTable).set({ permission: sessionCeiling }).where(eq(SessionTable.id, fixture.master.id)).run().pipe(Effect.orDie)
      masterAgent.permissions = []
      const created = fixture.parsed(yield* fixture.call("create-empty-agent", "project", { action: "create", name: "lane-empty-agent", model }))
      expect((yield* fixture.sessions.get(created.sessionID)).permissionCeiling).toEqual(sessionCeiling)
    }), 60_000)

  integration.live("a later allow in the member's agent rules does not override a deny in the member's ceiling", () =>
    Effect.gen(function* () {
      const fixture = yield* projectSetup
      masterAgent.permissions = [deny("shell", "a*")]
      const created = fixture.parsed(yield* fixture.call("create-member-allow", "project", { action: "create", name: "lane-member-allow", model }))
      const ceiling = (yield* fixture.sessions.get(created.sessionID)).permissionCeiling ?? []
      expect(ceiling).toEqual([deny("shell", "a*")])
      const memberAgent = [allow("*", "*"), allow("shell", "*"), allow("shell", "a*")]
      expect(Permission.evaluate("shell", "abc", memberAgent).effect).toBe("allow")
      expect(Permission.evaluate("shell", "abc", [...memberAgent, ...ceiling]).effect).toBe("deny")
      expect(Permission.evaluate("shell", "xyz", [...memberAgent, ...ceiling]).effect).toBe("allow")
    }), 60_000)

  integration.live("a member created by the default god agent keeps its effective plan_exit deny and is offered question and plan_enter", () =>
    Effect.gen(function* () {
      const fixture = yield* projectSetup
      masterAgent.permissions = yield* godPermissions
      expect(masterAgent.permissions.filter((rule) => rule.effect === "deny").map((rule) => rule.action)).toEqual(["question", "plan_enter", "plan_exit"])
      const created = fixture.parsed(yield* fixture.call("create-god", "project", { action: "create", name: "lane-god", model }))
      expect((yield* fixture.sessions.get(created.sessionID)).permissionCeiling).toEqual([deny("plan_exit")])
    }), 60_000)

  integration.live("project create is refused before any side effect when configuration capabilities exclude the worktree tool", () =>
    Effect.gen(function* () {
      const fixture = yield* projectSetup
      configured.capabilities = new ConfigCapabilities.Info({ tools: { deny: ["worktree"] } })
      const before = yield* fixture.count()
      const result = yield* fixture.call("create-gated", "project", { action: "create", name: "lane-gated", model })
      expect(result).toEqual({ type: "error", value: "Project member creation requires the worktree tool capability" })
      expect(yield* fixture.exists("lane-gated")).toBe(false)
      expect(yield* fixture.count()).toBe(before)
      expect(audit).toEqual({ permissions: [], guardrails: [] })
      expect(masterAgent.resolved).toEqual([])
      expect((yield* fixture.coordination.get(fixture.group.id)).memberSessionIDs).toEqual([])
      delete configured.capabilities
      expect(fixture.parsed(yield* fixture.call("create-ungated", "project", { action: "create", name: "lane-ungated", model }))).toMatchObject({ branch: "lane-ungated" })
    }), 60_000)
  detached.live("creates a member in a requested repository from a Master whose Location is not a Git repository", () =>
    Effect.gen(function* () {
      const fixture = yield* projectSetup
      const omitted = yield* fixture.call("create-omitted", "project", { action: "create", name: "lane-omitted", model })
      expect(omitted).toEqual({ type: "error", value: "The current Location is not inside a Git repository" })

      const created = fixture.parsed(yield* fixture.call("create-requested", "project", { action: "create", name: "lane-requested", repository: source, model }))
      expect(created).toMatchObject({ directory: path.join(fixture.managed, "lane-requested"), branch: "lane-requested" })
      const found = yield* fixture.git.repo.discover(AbsolutePath.make(created.directory))
      expect(found).toBeDefined()
      if (found) expect(yield* fixture.git.history.branch(found)).toBe("lane-requested")
      const member = yield* fixture.sessions.get(created.sessionID)
      expect(member.location.directory).toBe(AbsolutePath.make(created.directory))
      expect((yield* fixture.coordination.get(fixture.group.id)).memberSessionIDs).toEqual([created.sessionID])
      expect(audit.permissions).toEqual([`worktree ${path.join(fixture.managed, "lane-requested")}`])
      expect(audit.guardrails).toEqual([`file_mutation create_git_worktree ${path.join(fixture.managed, "lane-requested")}`])
      const resolved = yield* (yield* Project.Service).resolve(source)
      expect((yield* (yield* ProjectDirectories.Service).list(resolved.id)).map((item) => item.directory)).toContain(AbsolutePath.make(created.directory))

      const before = yield* fixture.count()
      const duplicate = yield* fixture.call("create-requested-duplicate", "project", { action: "create", name: "lane-requested", repository: source, model })
      expect(duplicate).toEqual({ type: "error", value: "A worktree named lane-requested already exists" })
      expect(yield* fixture.count()).toBe(before)
    }), 60_000)

  detached.live("a requested repository that is not a Git repository or not absolute fails naming the path before any side effect", () =>
    Effect.gen(function* () {
      const fixture = yield* projectSetup
      const before = yield* fixture.count()
      const missing = yield* fixture.call("create-not-repository", "project", { action: "create", name: "lane-nowhere", repository: data, model })
      expect(missing).toEqual({ type: "error", value: `${data} is not inside a Git repository` })
      const relative = yield* fixture.call("create-relative", "project", { action: "create", name: "lane-relative", repository: "relative/repository", model })
      expect(relative).toEqual({ type: "error", value: "The repository must be an absolute directory path" })
      expect(yield* fixture.exists("lane-nowhere")).toBe(false)
      expect(yield* fixture.exists("lane-relative")).toBe(false)
      expect(yield* fixture.count()).toBe(before)
      expect(audit).toEqual({ permissions: [], guardrails: [] })
      expect((yield* fixture.coordination.get(fixture.group.id)).memberSessionIDs).toEqual([])
    }), 60_000)
})
