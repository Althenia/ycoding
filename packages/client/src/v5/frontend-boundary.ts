import type {
  LocationGetInput,
  LocationGetOutput,
  McpAddInput,
  RemoteGetOutput,
  SkillInfo,
  SkillListInput,
} from "../promise/generated/types.js"
import type { RequestOptions } from "../promise/generated/client.js"

export type ConfigurationScope = "global" | "project"
export type ConfigurationTarget = { scope: ConfigurationScope; path: string }
export type ProviderEndpointAPI = "chat" | "responses"
export type ProviderEndpoint =
  | { baseURL: string; api: ProviderEndpointAPI }
  | { baseURL: string; worker: "ollama" | "vllm" }
export type ProviderEndpointModel = {
  id: string
  modelID?: string
  name?: string
  family?: string
  api?: ProviderEndpointAPI
  disabled?: boolean
  tools?: boolean
}
export type ProviderConfigureInput = {
  location?: LocationGetInput["location"]
  providerID: string
  scope: ConfigurationScope
  endpoint: ProviderEndpoint
  catalog?: "openai-models"
  models?: ProviderEndpointModel[]
}
export type ProviderConfigureOutput = { providerID: string; target: ConfigurationTarget; registered: boolean }
export type McpConfigureInput = {
  location?: LocationGetInput["location"]
  name: string
  scope: ConfigurationScope
  config: McpAddInput["config"]
}
export type McpConfigureOutput = { name: string; target: ConfigurationTarget; reloaded: boolean }
export type FrontendPackageResolveInput = { location?: LocationGetInput["location"]; spec: string }
export type FrontendPackageAsset = { path: string; digest: string }
export type FrontendPackageResolveOutput = {
  name: string
  version: string
  digest: string
  root: string
  entrypoint: FrontendPackageAsset
  assets?: FrontendPackageAsset[]
}
export type RemoteEnrollInput = {
  relayOrigin: string
  enrollmentID: string
  code: string
  name?: string
  replace?: boolean
}
export type RemoteDevice = {
  deviceID: string
  name: string
  relayOrigin: string
  enrolledAt: number
  credentialState: "not_authenticated" | "valid" | "expired" | "revoked"
  credentialExpiresAt?: number
}
export type RemoteEnrollOutput = RemoteDevice
export type RemoteStatusOutput = RemoteGetOutput & { device?: RemoteDevice }
export type BackendPaths = { home: string; state: string; worktree: string; config: string }
export type BackendLocationOutput = LocationGetOutput & { backendPaths?: BackendPaths }
export type BackendSkillListOutput = {
  location: BackendLocationOutput
  data: (SkillInfo & { scope?: ConfigurationScope })[]
}
export type ConfigurationWriteError = {
  _tag: "ConfigurationWriteError"
  code: "invalid_config" | "scope_not_allowed" | "provider_collision" | "write_failed"
}
export type ConfigurationPartialFailure = {
  _tag: "ConfigurationPartialFailure"
  target: ConfigurationTarget
  stage: "reload" | "registration"
}
export type FrontendPackageError = {
  _tag: "FrontendPackageError"
  code: "invalid_package" | "permission_denied" | "install_failed" | "entrypoint_missing" | "integrity_failed"
}
export type RemoteEnrollmentError = {
  _tag: "RemoteEnrollmentError"
  code:
    | "invalid_origin"
    | "invalid_code"
    | "already_enrolled"
    | "relay_rejected"
    | "relay_unavailable"
    | "key_failed"
    | "store_failed"
}
export type RemoteEnrollmentPartialFailure = { _tag: "RemoteEnrollmentPartialFailure"; device: RemoteDevice }
export type FrontendBoundaryClient = {
  provider: {
    configure: (input: ProviderConfigureInput, requestOptions?: RequestOptions) => Promise<ProviderConfigureOutput>
  }
  mcp: { configure: (input: McpConfigureInput, requestOptions?: RequestOptions) => Promise<McpConfigureOutput> }
  frontendPackage: {
    resolve: (
      input: FrontendPackageResolveInput,
      requestOptions?: RequestOptions,
    ) => Promise<FrontendPackageResolveOutput>
  }
  remote: {
    enroll: (input: RemoteEnrollInput, requestOptions?: RequestOptions) => Promise<RemoteEnrollOutput>
    get: (requestOptions?: RequestOptions) => Promise<RemoteStatusOutput>
  }
  location: { get: (input?: LocationGetInput, requestOptions?: RequestOptions) => Promise<BackendLocationOutput> }
  skill: { list: (input?: SkillListInput, requestOptions?: RequestOptions) => Promise<BackendSkillListOutput> }
}
