import type { YCodingClient } from "../../promise/index.js"
import type { RequestOptions } from "../../promise/generated/client.js"
import type { LocationGetInput, SkillListInput } from "../../promise/generated/types.js"
import type {
  ProviderConfigureInput,
  ProviderConfigureOutput,
  McpConfigureInput,
  McpConfigureOutput,
  FrontendPackageResolveInput,
  FrontendPackageResolveOutput,
  RemoteEnrollInput,
  RemoteEnrollOutput,
  FrontendBoundaryClient,
  RemoteStatusOutput,
  BackendLocationOutput,
  BackendSkillListOutput,
} from "../frontend-boundary.js"
import type { LocalTransport } from "../socket.js"
export function bindFrontendBoundary(
  transport: LocalTransport,
  client: YCodingClient,
): Omit<YCodingClient, keyof FrontendBoundaryClient> & {
  [K in keyof FrontendBoundaryClient]: K extends keyof YCodingClient
    ? Omit<YCodingClient[K], keyof FrontendBoundaryClient[K]> & FrontendBoundaryClient[K]
    : FrontendBoundaryClient[K]
} {
  return {
    ...client,
    provider: {
      ...client.provider,
      configure: (input: ProviderConfigureInput, requestOptions?: RequestOptions) =>
        transport.call<ProviderConfigureOutput>(
          { method: "provider.configure", operationID: 2060, resultPath: ["data"], empty: false },
          {
            query: { location: input.location },
            payload: {
              providerID: input.providerID,
              scope: input.scope,
              endpoint: input.endpoint,
              catalog: input.catalog,
              models: input.models,
            },
          },
          input,
          requestOptions,
        ),
    },
    mcp: {
      ...client.mcp,
      configure: (input: McpConfigureInput, requestOptions?: RequestOptions) =>
        transport.call<McpConfigureOutput>(
          { method: "mcp.configure", operationID: 2061, resultPath: ["data"], empty: false },
          {
            query: { location: input.location },
            payload: { name: input.name, scope: input.scope, config: input.config },
          },
          input,
          requestOptions,
        ),
    },
    frontendPackage: {
      resolve: (input: FrontendPackageResolveInput, requestOptions?: RequestOptions) =>
        transport.call<FrontendPackageResolveOutput>(
          { method: "frontendPackage.resolve", operationID: 2062, resultPath: ["data"], empty: false },
          { query: { location: input.location }, payload: { spec: input.spec } },
          input,
          requestOptions,
        ),
    },
    remote: {
      ...client.remote,
      enroll: (input: RemoteEnrollInput, requestOptions?: RequestOptions) =>
        transport.call<RemoteEnrollOutput>(
          { method: "remote.enroll", operationID: 3053, resultPath: ["data"], empty: false },
          {
            payload: {
              relayOrigin: input.relayOrigin,
              enrollmentID: input.enrollmentID,
              code: input.code,
              name: input.name,
              replace: input.replace,
            },
          },
          input,
          requestOptions,
        ),
      get: (requestOptions?: RequestOptions) => client.remote.get(requestOptions) as Promise<RemoteStatusOutput>,
    },
    location: {
      ...client.location,
      get: (input?: LocationGetInput, requestOptions?: RequestOptions) =>
        client.location.get(input, requestOptions) as Promise<BackendLocationOutput>,
    },
    skill: {
      ...client.skill,
      list: (input?: SkillListInput, requestOptions?: RequestOptions) =>
        client.skill.list(input, requestOptions) as Promise<BackendSkillListOutput>,
    },
  }
}
