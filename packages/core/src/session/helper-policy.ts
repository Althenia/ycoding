export * as SessionHelperPolicy from "./helper-policy"

import { Context, Effect, Layer } from "effect"
import { Agent } from "../agent"
import { Config } from "../config"
import { makeLocationNode } from "../effect/app-node"
import { CatalogModel } from "../model"
import { Provider } from "../provider"
import { SessionRunnerModel } from "./runner/model"
import { SessionSchema } from "./schema"

export type TitleMode = "local" | "model" | "off"
export type Role = "title" | "goal" | "decision" | "compaction" | "prediction" | "prompt"
export type CompactionScope = "main" | "subagent"
export type ModelSelection = CatalogModel.Ref | "session"

export interface Settings {
  readonly titleMode: TitleMode
  readonly models: Partial<Record<Role, ModelSelection>>
  readonly compactionScopes?: Partial<Record<CompactionScope, ModelSelection>>
}

export interface ResolveOptions {
  readonly refresh?: boolean
}

export interface SelectHelperModelInput {
  readonly agentModel?: CatalogModel.Ref
  readonly roleModel?: ModelSelection
  readonly sessionModel?: CatalogModel.Ref
}

const ANSI_CSI = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g
const ANSI_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g
const stripControls = (value: string) =>
  value
    .replace(ANSI_OSC, "")
    .replace(ANSI_CSI, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ")
const collapse = (value: string) => value.replace(/\s+/g, " ").trim()
const stripMarkdownPrefix = (value: string) => value.replace(/^(?:(?:#{1,6}|>|[-*+])\s+|\d+[.)]\s+)/, "").trim()
const truncate = (value: string, limit: number) => {
  const characters = Array.from(value)
  if (characters.length <= limit) return value
  return `${characters.slice(0, limit - 3).join("")}...`
}

export const localTitle = (input: string) => {
  const first = stripControls(input)
    .split(/\r?\n/)
    .map((line) => collapse(line))
    .find((line) => line.length > 0)
  const normalized = first ? collapse(stripMarkdownPrefix(first)) : ""
  return truncate(normalized || "New session", 50)
}

export const selectHelperModel = (input: SelectHelperModelInput) =>
  input.agentModel ?? (input.roleModel === "session" ? input.sessionModel : input.roleModel) ?? input.sessionModel

export interface SelectHelperCandidatesInput {
  readonly agentModels: ReadonlyArray<CatalogModel.Ref | undefined>
  readonly roleModel?: ModelSelection
  readonly sessionModel?: CatalogModel.Ref
}

const sameRef = (left: CatalogModel.Ref, right: CatalogModel.Ref) =>
  left.providerID === right.providerID &&
  left.id === right.id &&
  left.variant === right.variant &&
  left.profile === right.profile

export const selectHelperCandidates = (input: SelectHelperCandidatesInput): ReadonlyArray<CatalogModel.Ref | undefined> => {
  const explicit = [
    ...input.agentModels,
    input.roleModel === "session" ? undefined : input.roleModel,
  ].filter((value): value is CatalogModel.Ref => value !== undefined)
  const unique = explicit.filter((value, index) => explicit.findIndex((other) => sameRef(other, value)) === index)
  const sessionModel = input.sessionModel
  if (sessionModel === undefined) return [...unique, undefined]
  return unique.some((value) => sameRef(value, sessionModel)) ? unique : [...unique, sessionModel]
}

/**
 * Summmarizer model selection for role `compaction`, scoped by chat type.
 * A session with a defined `parentID` is a subagent chat; undefined means main chat.
 * Precedence differs from the other helper roles deliberately: an explicit configured
 * model (a `ConfigModel.Selection`, not `"session"` and not absent) overrides an
 * agent-pinned model, otherwise the configured per-chat setting would be inert
 * whenever an agent pins a model. Absent and `"session"` keep the historical
 * `agentModel ?? sessionModel` precedence. `title` and `goal` never take this path.
 */
const selectCompactionModel = (
  scopes: NonNullable<Settings["compactionScopes"]>,
  session: SessionSchema.Info,
  agent?: Agent.Info,
): CatalogModel.Ref | undefined => {
  const roleModel = scopes[session.parentID ? "subagent" : "main"]
  if (roleModel !== undefined && roleModel !== "session") return roleModel
  return agent?.model ?? session.model
}

const configuredModel = (
  selected:
    | "session"
    | { readonly providerID: string; readonly model: string; readonly variant?: string; readonly profile?: string }
    | undefined,
) => {
  if (!selected || selected === "session") return selected
  return CatalogModel.Ref.make({
    providerID: Provider.ID.make(selected.providerID),
    id: CatalogModel.ID.make(selected.model),
    ...(selected.variant === undefined ? {} : { variant: CatalogModel.VariantID.make(selected.variant) }),
    ...(selected.profile === undefined ? {} : { profile: selected.profile }),
  })
}

export const settings = (entries: readonly Config.Entry[]): Settings => {
  const efficiency = Config.latest(entries, "efficiency")
  const title = configuredModel(efficiency?.helper_models?.title)
  const prediction = configuredModel(efficiency?.helper_models?.prediction)
  const prompt = configuredModel(efficiency?.helper_models?.prompt)
  const goal = configuredModel(efficiency?.helper_models?.goal)
  const decision = configuredModel(efficiency?.helper_models?.decision)
  const compactionMain = configuredModel(efficiency?.helper_models?.compaction?.main)
  const compactionSubagent = configuredModel(efficiency?.helper_models?.compaction?.subagent)
  return {
    titleMode: efficiency?.title ?? "local",
    models: {
      ...(title === undefined ? {} : { title }),
      ...(prediction === undefined ? {} : { prediction }),
      ...(prompt === undefined ? {} : { prompt }),
      ...(goal === undefined ? {} : { goal }),
      ...(decision === undefined ? {} : { decision }),
    },
    compactionScopes: {
      ...(compactionMain === undefined ? {} : { main: compactionMain }),
      ...(compactionSubagent === undefined ? {} : { subagent: compactionSubagent }),
    },
  }
}

export interface Interface {
  readonly settings: Settings
  readonly localTitle: (input: string) => string
  readonly resolveModel: (
    session: SessionSchema.Info,
    role: Role,
    agent?: Agent.Info,
    options?: ResolveOptions,
  ) => Effect.Effect<SessionRunnerModel.Resolved | undefined>
  readonly resolveRef: (
    session: SessionSchema.Info,
    selected: CatalogModel.Ref | undefined,
    options?: ResolveOptions,
  ) => Effect.Effect<SessionRunnerModel.Resolved | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/SessionHelperPolicy") {}

export const make = (policy: Settings, models: SessionRunnerModel.Interface): Interface => {
  const resolveRef: Interface["resolveRef"] = (session, selected, options) =>
    models.resolve(selected === undefined ? session : { ...session, model: selected }, options).pipe(
      Effect.map((resolved): SessionRunnerModel.Resolved | undefined => resolved),
      Effect.catch(() => Effect.succeed(undefined)),
    )
  return {
    settings: policy,
    localTitle,
    resolveRef,
    resolveModel: (session, role, agent, options) =>
      resolveRef(
        session,
        role === "compaction"
          ? selectCompactionModel(policy.compactionScopes ?? {}, session, agent)
          : selectHelperModel({
              agentModel: agent?.model,
              roleModel: policy.models[role],
              sessionModel: session.model,
            }),
        options,
      ),
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const models = yield* SessionRunnerModel.Service
    return Service.of(make(settings(yield* config.entries()), models))
  }),
)

export const layerWith = (policy: Settings) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const models = yield* SessionRunnerModel.Service
      return Service.of(make(policy, models))
    }),
  )

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, SessionRunnerModel.node],
})
