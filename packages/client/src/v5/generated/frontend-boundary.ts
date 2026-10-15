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
export type CapturedChangesInput = { sessionID: string } & { cursor?: string }
export type CapturedChangesOutput = {
  data: {
    placementMessageID: string
    path: string
    additions: number
    deletions: number
    status: "created" | "deleted" | "modified"
    files: {
      diff: string
      path: string
      additions: number
      deletions: number
      status: "created" | "deleted" | "modified"
      unavailable?: boolean
    }[]
  }[]
  cursor?: { next?: string }
}
export type TeamEconomicsInput = { sessionID: string } & { sessionIDs: string[] }
export type TeamEconomicsOutput = {
  data: {
    sessionID: string
    cost: number
    tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
    contextTotal?: number
    contextLimit?: number
    cacheHitRatio?: number
    cacheRead?: number
    cacheWrite?: number
  }[]
}
export type FamilyActivityInput = { sessionID: string } & { sessionIDs: string[] }
export type FamilyActivityOutput = {
  data: {
    sessionID: string
    executing: boolean
    activity?: {
      kind: "tool" | "thinking" | "replying"
      room: "research" | "qa" | "meeting" | "developer" | "hold"
      text: string
    }
  }[]
}
export type FamilyOperationError = {
  code:
    | "invalid_message"
    | "message_too_large"
    | "unknown_operation"
    | "session_required"
    | "session_not_allowed"
    | "subagent_read_only"
    | "not_found"
    | "not_subscribed"
    | "rate_limited"
    | "agent_unavailable"
    | "outcome_unknown"
    | "forbidden"
    | "telemetry_disabled"
    | "unauthorized"
    | "internal_error"
  message: string
}
function bindFamily(transport: LocalTransport, session: YCodingClient["session"]) {
  return {
    ...session,
    capturedChanges: {
      list: (input: CapturedChangesInput, requestOptions?: RequestOptions) =>
        transport.call<CapturedChangesOutput>(
          { method: "session.capturedChanges.list", operationID: 5008, resultPath: [], empty: false },
          { payload: { cursor: input.cursor } },
          input,
          requestOptions,
        ),
    },
    team: {
      economics: (input: TeamEconomicsInput, requestOptions?: RequestOptions) =>
        transport.call<TeamEconomicsOutput>(
          { method: "session.team.economics", operationID: 5013, resultPath: [], empty: false },
          { payload: { sessionIDs: input.sessionIDs } },
          input,
          requestOptions,
        ),
    },
    family: {
      activity: (input: FamilyActivityInput, requestOptions?: RequestOptions) =>
        transport.call<FamilyActivityOutput>(
          { method: "session.family.activity", operationID: 5018, resultPath: [], empty: false },
          { payload: { sessionIDs: input.sessionIDs } },
          input,
          requestOptions,
        ),
    },
  }
}
export function bindFrontendBoundary(
  transport: LocalTransport,
  client: YCodingClient,
): Omit<YCodingClient, keyof FrontendBoundaryClient | "session"> & { session: ReturnType<typeof bindFamily> } & {
  [K in keyof FrontendBoundaryClient]: K extends keyof YCodingClient
    ? Omit<YCodingClient[K], keyof FrontendBoundaryClient[K]> & FrontendBoundaryClient[K]
    : FrontendBoundaryClient[K]
} {
  return {
    ...client,
    session: bindFamily(transport, client.session),
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
