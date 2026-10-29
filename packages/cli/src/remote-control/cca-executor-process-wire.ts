import type {
  CcaCredentialAuthMethod,
  CcaCredentialProviderConfig,
  CcaNetworkDecision,
  CcaNetworkDomainPermission,
  CcaNetworkPolicyAuditEvent,
  CcaNetworkPolicyDecider,
  CcaNetworkPolicyRequest,
  CcaNetworkProxyAuditMetadata,
  CcaNetworkUnixSocketPermission,
  CcaRemoteNetworkProxyConfig,
  CcaRemoteNetworkProxyLaunchConfig,
} from "@ycoding-ai/core/cca/network-proxy"
import type { CcaShellSnapshotRequest } from "@ycoding-ai/core/cca/shell-snapshot"
import { CcaRpcError } from "./cca-executor-rpc"

export const CCA_NETWORK_POLICY_REQUEST_METHOD = "network/policyRequest"
export const CCA_NETWORK_POLICY_DECISION_METHOD = "network/policyDecision"
export const CCA_MAX_NETWORK_POLICY_HOST_BYTES = 253
export const CCA_MAX_NETWORK_POLICY_PROCESS_ID_BYTES = 256
export const CCA_MAX_NETWORK_POLICY_REASON_BYTES = 1024
export const CCA_NETWORK_POLICY_TRANSPORT_MARGIN_MS = 5_000

export interface CcaProcessStartExtensions {
  readonly networkProxy?: CcaRemoteNetworkProxyLaunchConfig
  readonly shellSnapshot?: CcaShellSnapshotRequest
}

type Json = Record<string, unknown>

function invalid(message: string): CcaRpcError {
  return new CcaRpcError(-32602, `Invalid params: ${message}`)
}

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function object(value: unknown, field: string): Json {
  if (!isRecord(value)) throw invalid(`${field} must be an object`)
  return value
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string") throw invalid(`${field} must be a string`)
  return value
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw invalid(`${field} must be a boolean`)
  return value
}

function optionalString(value: unknown, field: string): string | undefined {
  return value == null ? undefined : string(value, field)
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw invalid(`${field} must be a string array`)
  const items = value.filter((item): item is string => typeof item === "string")
  if (items.length !== value.length) throw invalid(`${field} must be a string array`)
  return items
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  const match = allowed.find((item) => item === value)
  if (match === undefined) throw invalid(`${field} must be one of ${allowed.join(", ")}`)
  return match
}

function permissionMap<T extends string>(value: unknown, allowed: readonly T[], field: string): Record<string, T> | undefined {
  if (value == null) return undefined
  const entries = Object.entries(object(value, field)).map(([key, item]) => [key, oneOf(item, allowed, `${field}.${key}`)] as const)
  return Object.fromEntries(entries)
}

const PROVIDER_FIELDS = new Set(["env", "patterns", "url_prefixes", "url_prefix_from_env", "auth", "header", "prefix"])
const AUTH_METHODS: readonly CcaCredentialAuthMethod[] = ["bearer", "token", "basic", "header"]

function provider(value: unknown, field: string): CcaCredentialProviderConfig {
  const raw = object(value, field)
  for (const key of Object.keys(raw)) if (!PROVIDER_FIELDS.has(key)) throw invalid(`${field} has unknown field ${key}`)
  const urlPrefixFromEnv = optionalString(raw.url_prefix_from_env, `${field}.url_prefix_from_env`)
  const header = optionalString(raw.header, `${field}.header`)
  const prefix = optionalString(raw.prefix, `${field}.prefix`)
  return {
    env: raw.env === undefined ? [] : strings(raw.env, `${field}.env`),
    patterns: raw.patterns === undefined ? [] : strings(raw.patterns, `${field}.patterns`),
    url_prefixes: raw.url_prefixes === undefined ? [] : strings(raw.url_prefixes, `${field}.url_prefixes`),
    ...(urlPrefixFromEnv === undefined ? {} : { url_prefix_from_env: urlPrefixFromEnv }),
    auth:
      raw.auth === undefined
        ? []
        : (() => {
            if (!Array.isArray(raw.auth)) throw invalid(`${field}.auth must be an array`)
            return raw.auth.map((item, index) => oneOf(item, AUTH_METHODS, `${field}.auth[${index}]`))
          })(),
    ...(header === undefined ? {} : { header }),
    ...(prefix === undefined ? {} : { prefix }),
  }
}

const DOMAIN_PERMISSIONS: readonly CcaNetworkDomainPermission[] = ["none", "allow", "deny"]
const SOCKET_PERMISSIONS: readonly CcaNetworkUnixSocketPermission[] = ["allow", "deny"]
const AUDIT_FIELDS = ["conversationId", "appVersion", "userAccountId", "authMode", "originator", "userEmail", "terminalType", "model", "slug"] as const

function proxyConfig(value: unknown): CcaRemoteNetworkProxyConfig {
  const raw = object(value, "networkProxy.proxy")
  const field = (name: string) => `networkProxy.proxy.${name}`
  const credentialMasking = raw.credentialMasking === undefined ? false : boolean(raw.credentialMasking, field("credentialMasking"))
  const providers =
    raw.credentialProviders === undefined
      ? {}
      : Object.fromEntries(
          Object.entries(object(raw.credentialProviders, field("credentialProviders"))).map(([id, item]) => [
            id,
            provider(item, `${field("credentialProviders")}.${id}`),
          ]),
        )
  const domains = permissionMap(raw.domains, DOMAIN_PERMISSIONS, field("domains"))
  const unixSockets = permissionMap(raw.unixSockets, SOCKET_PERMISSIONS, field("unixSockets"))
  return {
    enabled: boolean(raw.enabled, field("enabled")),
    credentialMasking,
    credentialProviders: credentialMasking ? providers : {},
    enableSocks5: boolean(raw.enableSocks5, field("enableSocks5")),
    enableSocks5Udp: boolean(raw.enableSocks5Udp, field("enableSocks5Udp")),
    allowUpstreamProxy: boolean(raw.allowUpstreamProxy, field("allowUpstreamProxy")),
    dangerouslyAllowAllUnixSockets: boolean(raw.dangerouslyAllowAllUnixSockets, field("dangerouslyAllowAllUnixSockets")),
    mode: oneOf(raw.mode, ["limited", "full"] as const, field("mode")),
    ...(domains === undefined ? {} : { domains }),
    reviewDomains: raw.reviewDomains === undefined ? [] : strings(raw.reviewDomains, field("reviewDomains")),
    ...(unixSockets === undefined ? {} : { unixSockets }),
    allowLocalBinding: boolean(raw.allowLocalBinding, field("allowLocalBinding")),
  }
}

function launchConfig(value: unknown, processId: unknown): CcaRemoteNetworkProxyLaunchConfig {
  const raw = object(value, "networkProxy")
  const auditRaw = raw.auditMetadata === undefined ? {} : object(raw.auditMetadata, "networkProxy.auditMetadata")
  const auditMetadata: Record<string, string> = {}
  for (const key of AUDIT_FIELDS) {
    const item = optionalString(auditRaw[key], `networkProxy.auditMetadata.${key}`)
    if (item !== undefined) auditMetadata[key] = item
  }
  const environmentId = optionalString(raw.environmentId, "networkProxy.environmentId")
  const executionId = optionalString(raw.executionId, "networkProxy.executionId")
  const timeout = raw.policyDecisionTimeoutMs
  if (timeout != null && (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout < 0)) {
    throw invalid("networkProxy.policyDecisionTimeoutMs must be a non-negative integer")
  }
  if (timeout === 0) throw invalid("network policy decision callback timeout must be nonzero")
  if (
    timeout != null &&
    (typeof processId !== "string" || processId.length === 0 || Buffer.byteLength(processId) > CCA_MAX_NETWORK_POLICY_PROCESS_ID_BYTES)
  ) {
    throw invalid(`callback-enabled process ID must be non-empty and at most ${CCA_MAX_NETWORK_POLICY_PROCESS_ID_BYTES} bytes`)
  }
  return {
    proxy: proxyConfig(raw.proxy),
    auditMetadata: auditMetadata as CcaNetworkProxyAuditMetadata,
    ...(environmentId === undefined ? {} : { environmentId }),
    ...(executionId === undefined ? {} : { executionId }),
    ...(timeout == null ? {} : { policyDecisionTimeoutMs: timeout }),
  }
}

function shellSnapshot(value: unknown): CcaShellSnapshotRequest {
  const raw = object(value, "shellSnapshot")
  const shell = object(raw.shell, "shellSnapshot.shell")
  return {
    scopeId: string(raw.scopeId, "shellSnapshot.scopeId"),
    shell: { name: string(shell.name, "shellSnapshot.shell.name"), path: string(shell.path, "shellSnapshot.shell.path") },
  }
}

export function decodeCcaProcessStartExtensions(params: {
  readonly processId?: unknown
  readonly networkProxy?: unknown
  readonly shellSnapshot?: unknown
}): CcaProcessStartExtensions {
  return {
    ...(params.networkProxy == null ? {} : { networkProxy: launchConfig(params.networkProxy, params.processId) }),
    ...(params.shellSnapshot == null ? {} : { shellSnapshot: shellSnapshot(params.shellSnapshot) }),
  }
}

export interface CcaNetworkPolicyRequestParams {
  readonly processId: string
  readonly request: CcaNetworkPolicyRequest
}

export function encodeCcaNetworkPolicyRequest(processId: string, request: CcaNetworkPolicyRequest): CcaNetworkPolicyRequestParams {
  return { processId, request: { protocol: request.protocol, host: request.host, port: request.port } }
}

export type CcaNetworkPolicyDecisionNotification = { readonly processId: string } & CcaNetworkPolicyAuditEvent

export function encodeCcaNetworkPolicyDecisionNotification(
  processId: string,
  event: CcaNetworkPolicyAuditEvent,
): CcaNetworkPolicyDecisionNotification {
  return {
    processId,
    timestamp: event.timestamp,
    scope: event.scope,
    decision: event.decision,
    source: event.source,
    reason: event.reason,
    protocol: event.protocol,
    host: event.host,
    port: event.port,
    ...(event.method === undefined ? {} : { method: event.method }),
    ...(event.client === undefined ? {} : { client: event.client }),
    policyOverride: event.policyOverride,
  }
}

const NOT_ALLOWED: CcaNetworkDecision = { type: "deny", reason: "not_allowed" }
const CONTROL = /\p{Cc}/u

function decodeCcaNetworkPolicyResponse(result: unknown): CcaNetworkDecision {
  if (!isRecord(result) || !isRecord(result.decision)) return NOT_ALLOWED
  const { type, reason } = result.decision
  if (type === "allow") return { type: "allow" }
  if ((type !== "deny" && type !== "ask") || typeof reason !== "string") return NOT_ALLOWED
  if (Buffer.byteLength(reason) > CCA_MAX_NETWORK_POLICY_REASON_BYTES || CONTROL.test(reason)) return NOT_ALLOWED
  return { type, reason }
}

export interface CreateCcaNetworkPolicyDeciderOptions {
  readonly processId: string
  readonly controllerTimeoutMs: number
  readonly call: (method: string, params: CcaNetworkPolicyRequestParams, signal: AbortSignal) => Promise<unknown>
  readonly signal?: AbortSignal
  readonly transportMarginMs?: number
}

export function createCcaNetworkPolicyDecider(options: CreateCcaNetworkPolicyDeciderOptions): CcaNetworkPolicyDecider {
  const timeoutMs = options.controllerTimeoutMs + (options.transportMarginMs ?? CCA_NETWORK_POLICY_TRANSPORT_MARGIN_MS)
  return async (request) => {
    const host = request.host
    if (
      host.length === 0 ||
      Buffer.byteLength(host) > CCA_MAX_NETWORK_POLICY_HOST_BYTES ||
      CONTROL.test(host) ||
      /\s/u.test(host) ||
      options.signal?.aborted
    ) {
      return NOT_ALLOWED
    }
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let onShutdown: (() => void) | undefined
    const failClosed = new Promise<CcaNetworkDecision>((resolve) => {
      const stop = () => {
        controller.abort()
        resolve(NOT_ALLOWED)
      }
      timer = setTimeout(stop, timeoutMs)
      onShutdown = stop
      options.signal?.addEventListener("abort", stop, { once: true })
    })
    try {
      return await Promise.race([
        options
          .call(CCA_NETWORK_POLICY_REQUEST_METHOD, encodeCcaNetworkPolicyRequest(options.processId, request), controller.signal)
          .then(decodeCcaNetworkPolicyResponse, () => NOT_ALLOWED),
        failClosed,
      ])
    } finally {
      clearTimeout(timer)
      if (onShutdown) options.signal?.removeEventListener("abort", onShutdown)
    }
  }
}
