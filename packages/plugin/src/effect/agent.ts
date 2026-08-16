import type { AgentApi } from "@ycoding-ai/client/effect/api"
import type { Agent } from "@ycoding-ai/schema/agent"
import type { Effect } from "effect"
import type { Mutable } from "./mutable.js"
import type { Transform } from "./registration.js"

type AgentRequest = Omit<Mutable<Agent.Info["request"]>, "settings" | "body"> & {
  settings: Record<string, unknown>
  body: Record<string, unknown>
}
type AgentInfo = Omit<Mutable<Agent.Info>, "request" | "locations"> & {
  request: AgentRequest
  locations?: Agent.Info["locations"]
}

export interface AgentDraft {
  list(): readonly AgentInfo[]
  get(id: string): AgentInfo | undefined
  default(id: string | undefined): void
  update(id: string, update: (agent: AgentInfo) => void): void
  remove(id: string): void
}

export interface AgentDomain extends AgentApi<unknown> {
  readonly get: (id: string) => Effect.Effect<AgentGetOutput | undefined>
  readonly transform: Transform<AgentDraft>
  readonly reload: () => Effect.Effect<void>
}

type AgentGetOutput = Effect.Success<ReturnType<AgentApi<unknown>["list"]>>["data"][number]
