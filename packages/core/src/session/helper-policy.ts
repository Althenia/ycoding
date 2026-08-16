export * as SessionHelperPolicy from "./helper-policy"

import { Context, Effect, Layer } from "effect"
import { AgentV2 } from "../agent"
import { Config } from "../config"
import { ConfigEfficiency } from "../config/efficiency"
import { makeLocationNode } from "../effect/app-node"
import { ModelV2 } from "../model"
import { ProviderV2 } from "../provider"
import { SessionRunnerModel } from "./runner/model"
import { SessionSchema } from "./schema"

export type TitleMode = "local" | "model" | "off"
export type Role = "title" | "compaction"
export type CompactionScope = "main" | "subagent"
export type ModelSelection = ModelV2.Ref | "session"

export interface Settings {
  readonly titleMode: TitleMode
  readonly models: Partial<Record<Role, ModelSelection>>
  readonly compactionScopes?: Partial<Record<CompactionScope, ModelSelection>>
}

export interface SelectHelperModelInput {
  readonly agentModel?: ModelV2.Ref
  readonly roleModel?: ModelSelection
  readonly sessionModel?: ModelV2.Ref
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

export const localGoal = (input: string) => collapse(stripControls(input))

export const selectHelperModel = (input: SelectHelperModelInput) =>
  input.agentModel ?? (input.roleModel === "session" ? input.sessionModel : input.roleModel) ?? input.sessionModel

/**
 * Summmarizer model selection for role `compaction`, scoped by chat type.
 * A session with a defined `parentID` is a subagent chat; undefined means main chat.
 * Precedence differs from the other helper roles deliberately: an explicit configured
 * model (a `ConfigModel.Selection`, not `"session"` and not absent) overrides an
 * agent-pinned model, otherwise the configured per-chat setting would be inert
 * whenever an agent pins a model. Absent and `"session"` keep the historical
 * `agentModel ?? sessionModel` precedence. `title` never takes this path.
 */
const selectCompactionModel = (
  scopes: NonNullable<Settings["compactionScopes"]>,
  session: SessionSchema.Info,
  agent?: AgentV2.Info,
): ModelV2.Ref | undefined => {
  const roleModel = scopes[session.parentID ? "subagent" : "main"]
  if (roleModel !== undefined && roleModel !== "session") return roleModel
  return agent?.model ?? session.model
}

const configuredModel = (
  selected: "session" | { readonly providerID: string; readonly model: string; readonly variant?: string } | undefined,
) => {
  if (!selected || selected === "session") return selected
  return ModelV2.Ref.make({
    providerID: ProviderV2.ID.make(selected.providerID),
    id: ModelV2.ID.make(selected.model),
    ...(selected.variant === undefined ? {} : { variant: ModelV2.VariantID.make(selected.variant) }),
  })
}

export const settings = (entries: readonly Config.Entry[]): Settings => {
  const efficiency = Config.latest(entries, "efficiency")
  const title = configuredModel(efficiency?.helper_models?.title)
  const compactionMain = configuredModel(efficiency?.helper_models?.compaction?.main)
  const compactionSubagent = configuredModel(efficiency?.helper_models?.compaction?.subagent)
  return {
    titleMode: efficiency?.title ?? "local",
    models: {
      ...(title === undefined ? {} : { title }),
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
  readonly localGoal: (input: string) => string
  readonly resolveModel: (
    session: SessionSchema.Info,
    role: Role,
    agent?: AgentV2.Info,
  ) => Effect.Effect<SessionRunnerModel.Resolved | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/SessionHelperPolicy") {}

export const make = (policy: Settings, models: SessionRunnerModel.Interface): Interface => ({
  settings: policy,
  localTitle,
  localGoal,
  resolveModel: (session, role, agent) => {
    const selected =
      role === "compaction"
        ? selectCompactionModel(policy.compactionScopes ?? {}, session, agent)
        : selectHelperModel({
            agentModel: agent?.model,
            roleModel: policy.models[role],
            sessionModel: session.model,
          })
    return models.resolve(selected === undefined ? session : { ...session, model: selected }).pipe(
      Effect.map((resolved): SessionRunnerModel.Resolved | undefined => resolved),
      Effect.catch(() => Effect.succeed(undefined)),
    )
  },
})

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
