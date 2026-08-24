import type { SessionApi } from "@ycoding-ai/client/promise/api"
import type { Message, SystemPart } from "@ycoding-ai/ai"
import type { Agent } from "@ycoding-ai/schema/agent"
import type { Model } from "@ycoding-ai/schema/model"
import type { Session } from "@ycoding-ai/schema/session"
import type { JsonSchema } from "effect"
import type { Hooks } from "./registration.js"

export interface SessionContext {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly routeID?: string
  system: Array<SystemPart>
  messages: Array<Message>
  tools: Record<string, { description: string; input: JsonSchema.JsonSchema }>
}

export interface SessionHooks {
  readonly context: SessionContext
}

export type SessionDomain = Pick<
  SessionApi,
  "create" | "get" | "prompt" | "generate" | "command" | "synthetic" | "interrupt"
> & {
  readonly hook: Hooks<SessionHooks>
}
