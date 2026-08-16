export * from "./generated/index"
export type {
  AgentApi,
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
export type { EventSubscribeOutput as YCodingEvent } from "./generated/types"
export type YCodingClient = ReturnType<typeof import("./generated/client").make>
