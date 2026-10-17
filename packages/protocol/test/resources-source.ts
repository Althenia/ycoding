import { Schema } from "effect"
import { HttpApiEndpoint } from "effect/unstable/httpapi"
import { AgentGroup } from "../src/groups/agent.js"
import { CommandGroup } from "../src/groups/command.js"
import { ConfigGroup } from "../src/groups/config.js"
import { CredentialGroup } from "../src/groups/credential.js"
import { IntegrationGroup } from "../src/groups/integration.js"
import { LocationGroup } from "../src/groups/location.js"
import { McpGroup } from "../src/groups/mcp.js"
import { ModelGroup } from "../src/groups/model.js"
import { PluginGroup } from "../src/groups/plugin.js"
import { ProjectArtifactGroup } from "../src/groups/project-artifact.js"
import { ProjectGroup } from "../src/groups/project.js"
import { ProviderGroup } from "../src/groups/provider.js"
import { ProviderUsageGroup } from "../src/groups/provider-usage.js"
import { ReferenceGroup } from "../src/groups/reference.js"
import { SkillGroup } from "../src/groups/skill.js"
import { UsageGroup } from "../src/groups/usage.js"
import { ClientApi } from "../src/client.js"
import { Authorization } from "../src/middleware/authorization.js"
import { SchemaErrorMiddleware } from "../src/middleware/schema-error.js"

export const resourceGroups = [
  AgentGroup,
  CommandGroup,
  ConfigGroup,
  CredentialGroup,
  IntegrationGroup,
  LocationGroup,
  McpGroup,
  ModelGroup,
  PluginGroup,
  ProjectArtifactGroup,
  ProjectGroup,
  ProviderGroup,
  ProviderUsageGroup,
  ReferenceGroup,
  SkillGroup,
  UsageGroup,
  ClientApi.groups["server.incident"],
]
type Endpoint = Pick<
  HttpApiEndpoint.Top,
  "identifier" | "method" | "params" | "query" | "payload" | "success" | "error"
>

export const middlewareErrors = [...Authorization.error, ...SchemaErrorMiddleware.error]

export function allEndpoints() {
  return Object.values(ClientApi.groups).flatMap((group) => Object.values<Endpoint>(group.endpoints))
}

export function resourceSources() {
  return resourceGroups
    .flatMap((group) =>
      Object.values<Endpoint>(group.endpoints).map((endpoint) => ({
        name: endpoint.identifier,
        group: group.identifier,
        method: endpoint.method,
        params: endpoint.params && Schema.toJsonSchemaDocument(endpoint.params),
        query: endpoint.query && Schema.toJsonSchemaDocument(endpoint.query),
        payload: Array.from(endpoint.payload.values()).flatMap((payload) =>
          payload.schemas.map((schema) => Schema.toJsonSchemaDocument(schema)),
        ),
        success: Array.from(endpoint.success).map((schema) => Schema.toJsonSchemaDocument(schema)),
        error: Array.from(endpoint.error).map((schema) => Schema.toJsonSchemaDocument(schema)),
      })),
    )
    .sort((left, right) => left.name.localeCompare(right.name))
}

export function resourceEndpoints() {
  return resourceGroups
    .flatMap((group) =>
      Object.values<Endpoint>(group.endpoints).map((endpoint) => ({ group: group.identifier, endpoint })),
    )
    .sort((left, right) => left.endpoint.identifier.localeCompare(right.endpoint.identifier))
}
