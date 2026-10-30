import { existsSync, statSync } from "node:fs"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, Layer, Stream } from "effect"
import { NativeDots } from "../../src/dots/native"
import { NativeDecisions } from "../../src/dots/native-decisions"
import { DotsAccess } from "../../src/dots/access"
import { Config } from "../../src/config"
import { Credential } from "../../src/credential"
import { Integration } from "../../src/integration"
import { Session } from "../../src/session"
import { SessionStore } from "../../src/session/store"
import { SessionExecution } from "../../src/session/execution"
import { SessionOrchestration } from "../../src/session/orchestration"
import { SessionReview } from "../../src/session/review"
import { SessionGuardrail } from "../../src/session/guardrail"
import { Permission } from "../../src/permission"
import { Form } from "../../src/form"
import { Question } from "../../src/question"
import { PluginSupervisor } from "../../src/plugin/supervisor"
import { LocationServiceMap } from "../../src/location-service-map"
import { Database } from "../../src/database/database"
import { KV } from "../../src/kv"
import { EventRuntime } from "../../src/event"
import { FSUtil } from "../../src/fs-util"
import { Project } from "../../src/project"
import { AbsolutePath } from "../../src/schema"
import { createCcaExecutor, type CcaExecutorOptions } from "../../src/cca/executor"
import { CcaPolicy } from "../../src/cca/policy"

export const temporaryDirectory = (prefix = "dots-executor-") => Effect.acquireRelease(
  Effect.promise(async () => realpath(await mkdtemp(path.join(os.tmpdir(), prefix)))),
  (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
)

export interface CatalogProject {
  readonly id: string
  readonly worktree: string
  readonly name?: string
  readonly updated: number
}

export const dotsExecutorHostWith = (input: { readonly realAuthorization?: boolean; readonly library?: NativeDots.Options["library"] }) => Effect.gen(function* () {
  const db = yield* Database.Service
  const events = yield* EventRuntime.Service
  const sessions = yield* Session.Service
  const store = yield* SessionStore.Service
  const execution = yield* SessionExecution.Service
  const projects = yield* Project.Service
  const kv = yield* KV.Service
  const reviews = yield* SessionReview.Service
  const orchestration = yield* SessionOrchestration.Service
  const locations = yield* LocationServiceMap.Service
  const home = yield* temporaryDirectory("dots-executor-home-")
  const data = yield* temporaryDirectory("dots-executor-data-")
  const documents: Config.GlobalDocuments = { entries: [new Config.Document({ type: "document", scope: "global", info: new Config.Info({ dots: { enabled: true, profile: "trusted" } }) })], diagnostics: [] }
  const credential = new Credential.Info({ id: Credential.ID.make("cred_dots_executor"), integrationID: Integration.ID.make("openai"), label: "trusted", value: { type: "oauth", methodID: Integration.MethodID.make("chatgpt-browser"), access: "synthetic", refresh: "synthetic", expires: 0, metadata: { accountID: "synthetic-account" } } })
  const access = DotsAccess.make({ db, kv, configuration: () => Effect.succeed({ ready: true, profile: "trusted" }) })
  if (!(yield* access.get()).enabled) yield* access.set({ enabled: true, expectedRevision: (yield* access.get()).revision })
  const recorded = new Set<string>()
  const catalog: CatalogProject[] = []
  let denied = false
  const fsutil = yield* FSUtil.Service.pipe(Effect.provide(FSUtil.layer.pipe(Layer.provide(NodeFileSystem.layer))))
  const options = (): NativeDots.Options => ({
    access, db, kv, reviews, home, data, store, events, execution,
    ...(input.library === undefined ? {} : { library: input.library }),
    projectRoot: (directory) => Project.root(fsutil, directory),
    sessions,
    authorization: (session) => input.realAuthorization ? Effect.gen(function* () {
      const supervisor = yield* PluginSupervisor.Service
      yield* supervisor.flush
      return { permission: yield* Permission.Service, guardrail: yield* SessionGuardrail.Service }
    }).pipe(Effect.provide(locations.get(session.location, [LocationServiceMap.full]))) : Effect.succeed({
      permission: { ...({} as Permission.Interface), assert: () => denied ? Effect.fail(new Permission.BlockedError({ rules: [], permission: "read", resources: [] })) : Effect.void } as Permission.Interface,
      guardrail: { ...({} as SessionGuardrail.Interface), assert: () => Effect.succeed({ release: Effect.void }) } as SessionGuardrail.Interface,
    }),
    decisions: (session) => Effect.gen(function* () {
      const permission = yield* Permission.Service
      const guardrail = yield* SessionGuardrail.Service
      const forms = yield* Form.Service
      const questions = yield* Question.Service
      return NativeDecisions.make({ permission, guardrail, forms, questions, reviews, orchestration, sessions })
    }).pipe(Effect.provide(locations.get(session.location, [LocationServiceMap.full]))),
    models: () => Effect.succeed([]),
    skills: () => Effect.succeed([]),
    selectedModel: () => Effect.succeed(undefined),
    projects: {
      ...projects,
      list: () => Effect.succeed([{ id: "global", worktree: "/", updated: 0 }, ...catalog].sort((left, right) => right.updated - left.updated).map((item) => ({
        id: Project.ID.make(item.id), worktree: AbsolutePath.make(item.worktree), ...(item.name === undefined ? {} : { name: item.name }),
        sandboxes: [], time: { created: item.updated, updated: item.updated },
      }))),
      directories: () => Effect.sync(() => [...recorded].map((item) => ({ directory: AbsolutePath.make(item) }))),
      recordOpened: (opened) => Effect.sync(() => { if (existsSync(opened) && statSync(opened).isDirectory()) recorded.add(opened) }),
    },
    credentials: { list: () => Effect.succeed([credential]) },
    credential: () => Effect.succeed(undefined),
    config: { snapshot: () => Effect.succeed(documents), subscribe: () => () => {} },
  })
  const host = yield* NativeDots.make(options())
  const messages = (sessionID: string) => sessions.messages({ sessionID: Session.ID.make(sessionID) })
  const log = (sessionID: string) => events.log({ aggregateID: sessionID }).pipe(Stream.runCollect, Effect.map((items) => [...items].filter((item): item is EventRuntime.Payload => !EventRuntime.isSynced(item))))
  return {
    host, sessions, store, kv, events, home, data, catalog, messages, log, locations, access,
    deny: (value: boolean) => { denied = value },
    restart: () => NativeDots.make(options()),
  }
})

export const dotsExecutorHost = dotsExecutorHostWith({})

export type DotsExecutorFixture = Effect.Success<typeof dotsExecutorHost>

export const channel = async (
  host: NativeDots.Host,
  options: Partial<Omit<CcaExecutorOptions, "scopeFor">> = {},
) => {
  const executor = createCcaExecutor({ scopeFor: NativeDots.executorScopeFor(host, "environment"), ...options })
  const notifications: { readonly method: string; readonly params: unknown }[] = []
  const initialized = await executor.initialize({ clientName: "dots-executor-test" }, {
    signal: new AbortController().signal,
    notify: (method, params) => { notifications.push({ method, params }) },
  })
  const ctx = { signal: new AbortController().signal, sessionId: initialized.sessionId }
  return { executor, ctx, notifications }
}

export const uri = (target: string) => CcaPolicy.toPathUri(target)
