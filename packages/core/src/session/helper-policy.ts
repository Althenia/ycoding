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
export type GoalMode = "local" | "model"
export type Role = "title" | "goal" | "compaction"
export type ModelSelection = ModelV2.Ref | "session"

export interface Settings {
  readonly titleMode: TitleMode
  readonly goalMode: GoalMode
  readonly models: Partial<Record<Role, ModelSelection>>
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

const configuredModel = (selected: NonNullable<ConfigEfficiency.Info["helper_models"]>[Role] | undefined) => {
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
  const goal = configuredModel(efficiency?.helper_models?.goal)
  const compaction = configuredModel(efficiency?.helper_models?.compaction)
  return {
    titleMode: efficiency?.title ?? "local",
    goalMode: efficiency?.goal_synthesis ?? "local",
    models: {
      ...(title === undefined ? {} : { title }),
      ...(goal === undefined ? {} : { goal }),
      ...(compaction === undefined ? {} : { compaction }),
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
    const selected = selectHelperModel({
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
