// TODO: Keep additional network capabilities inside Schema and Protocol as the client grows; /effect must never import
// Core or Server. Preserve these datatype exports so internal model reorganizations do not require caller migrations.
import type { Effect } from "effect"

export * from "./generated/index"
export type {
  AgentApi,
  AppApi,
  CatalogApi,
  CommandApi,
  EventApi,
  IntegrationApi,
  ModelApi,
  PluginApi,
  ProviderApi,
  ReferenceApi,
  SessionApi,
  SkillApi,
} from "./api.js"
export { Agent } from "@ycoding-ai/schema/agent"
export { Command } from "@ycoding-ai/schema/command"
export { Credential } from "@ycoding-ai/schema/credential"
export { Event } from "@ycoding-ai/schema/event"
export { EventLog } from "@ycoding-ai/schema/event-log"
export { FileSystem } from "@ycoding-ai/schema/filesystem"
export { Form } from "@ycoding-ai/schema/form"
export { Integration } from "@ycoding-ai/schema/integration"
export { Location } from "@ycoding-ai/schema/location"
export { Model } from "@ycoding-ai/schema/model"
export { Permission } from "@ycoding-ai/schema/permission"
export { PermissionSaved } from "@ycoding-ai/schema/permission-saved"
export { Project } from "@ycoding-ai/schema/project"
export { ProjectCopy } from "@ycoding-ai/schema/project-copy"
export { Provider } from "@ycoding-ai/schema/provider"
export { Pty } from "@ycoding-ai/schema/pty"
export { Question } from "@ycoding-ai/schema/question"
export { Reference } from "@ycoding-ai/schema/reference"
export { AbsolutePath, RelativePath } from "@ycoding-ai/schema/schema"
export { Session } from "@ycoding-ai/schema/session"
export { SessionPending } from "@ycoding-ai/schema/session-pending"
export { SessionMessage } from "@ycoding-ai/schema/session-message"
export { Skill } from "@ycoding-ai/schema/skill"
export { Prompt } from "@ycoding-ai/schema/prompt"
export { PromptInput } from "@ycoding-ai/schema/prompt-input"
export type { YCodingEvent } from "@ycoding-ai/protocol/groups/event"
export type YCodingClient = Effect.Success<ReturnType<typeof import("./generated/client").make>>
