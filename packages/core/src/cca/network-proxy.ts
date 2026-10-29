export * as CcaNetworkProxy from "./network-proxy"

import dns from "node:dns/promises"
import net from "node:net"
import path from "node:path"
import { Duplex } from "node:stream"
import tls from "node:tls"
import {
  CCA_CREDENTIAL_MASKING_PARTIAL_WARNING,
  type CcaBrokeredProtocols,
  type CcaCredentialBroker,
  type CcaCredentialBrokerCache,
  type CcaHeader,
} from "./credential-broker"
import type { CcaAuthorizationGrant, CcaAuthorizationInput } from "./executor"
import { CCA_CUSTOM_CA_ENV_KEYS, loadCcaMitmAuthority, type CcaMitmAuthority } from "./mitm-ca"

export class CcaNetworkProxyError extends Error {
  readonly code: number

  constructor(code: number, message: string) {
    super(message.slice(0, 512))
    this.name = "CcaNetworkProxyError"
    this.code = code
  }
}

export type CcaNetworkMode = "limited" | "full"
export type CcaNetworkDomainPermission = "none" | "allow" | "deny"
export type CcaNetworkUnixSocketPermission = "allow" | "deny"
export type CcaCredentialAuthMethod = "bearer" | "token" | "basic" | "header"

export interface CcaCredentialProviderConfig {
  readonly env: readonly string[]
  readonly patterns: readonly string[]
  readonly url_prefixes: readonly string[]
  readonly url_prefix_from_env?: string
  readonly auth: readonly CcaCredentialAuthMethod[]
  readonly header?: string
  readonly prefix?: string
}

export interface CcaRemoteNetworkProxyConfig {
  readonly enabled: boolean
  readonly credentialMasking: boolean
  readonly credentialProviders: Readonly<Record<string, CcaCredentialProviderConfig>>
  readonly enableSocks5: boolean
  readonly enableSocks5Udp: boolean
  readonly allowUpstreamProxy: boolean
  readonly dangerouslyAllowAllUnixSockets: boolean
  readonly mode: CcaNetworkMode
  readonly domains?: Readonly<Record<string, CcaNetworkDomainPermission>>
  readonly reviewDomains: readonly string[]
  readonly unixSockets?: Readonly<Record<string, CcaNetworkUnixSocketPermission>>
  readonly allowLocalBinding: boolean
}

export interface CcaNetworkProxyAuditMetadata {
  readonly conversationId?: string
  readonly appVersion?: string
  readonly userAccountId?: string
  readonly authMode?: string
  readonly originator?: string
  readonly userEmail?: string
  readonly terminalType?: string
  readonly model?: string
  readonly slug?: string
}

export interface CcaRemoteNetworkProxyLaunchConfig {
  readonly proxy: CcaRemoteNetworkProxyConfig
  readonly auditMetadata: CcaNetworkProxyAuditMetadata
  readonly environmentId?: string
  readonly executionId?: string
  readonly policyDecisionTimeoutMs?: number
}

export type CcaCredentialMasking = "disabled" | "builtInOnly" | "withConfiguredProviders"

export function ccaCredentialMasking(capabilities: {
  readonly credentialMasking?: boolean
  readonly credentialMaskingCustomProviders?: boolean
}): CcaCredentialMasking {
  if (capabilities.credentialMasking !== true) return "disabled"
  return capabilities.credentialMaskingCustomProviders === true ? "withConfiguredProviders" : "builtInOnly"
}

export interface CcaNetworkProxyCapabilities {
  readonly networkProxyLaunch: boolean
  readonly networkProxyReviewDomains: boolean
  readonly credentialMasking: boolean
  readonly credentialMaskingCustomProviders: boolean
  readonly shellSnapshotV2: boolean
}

export function ccaNetworkProxyCapabilities(input: {
  readonly platform?: NodeJS.Platform
  readonly shell: string
}): CcaNetworkProxyCapabilities {
  const platform = input.platform ?? process.platform
  const shell = path.basename(input.shell).replace(/\.exe$/i, "")
  const credentialMasking = (platform === "linux" || platform === "darwin") && (shell === "bash" || shell === "zsh")
  return {
    networkProxyLaunch: true,
    networkProxyReviewDomains: true,
    credentialMasking,
    credentialMaskingCustomProviders: credentialMasking,
    shellSnapshotV2: platform !== "win32",
  }
}

export type CcaNetworkProtocol = "http" | "https_connect" | "socks5_tcp" | "socks5_udp"

export interface CcaNetworkPolicyRequest {
  readonly protocol: CcaNetworkProtocol
  readonly host: string
  readonly port: number
}

export type CcaNetworkDecision =
  | { readonly type: "allow" }
  | { readonly type: "deny" | "ask"; readonly reason: string }

export type CcaNetworkPolicyDecider = (request: CcaNetworkPolicyRequest) => Promise<CcaNetworkDecision>

export type CcaNetworkDecisionSource = "baseline_policy" | "mode_guard" | "proxy_state" | "decider"

export interface CcaNetworkPolicyAuditEvent {
  readonly timestamp: string
  readonly scope: "domain"
  readonly decision: "allow" | "deny" | "ask"
  readonly source: CcaNetworkDecisionSource
  readonly reason: string
  readonly protocol: CcaNetworkProtocol
  readonly host: string
  readonly port: number
  readonly method?: string
  readonly client?: string
  readonly policyOverride: boolean
}

export type CcaHostBlockDecision = "allowed" | "denied" | "not_allowed" | "not_allowed_local"

export type CcaDnsLookup = (host: string, port: number) => Promise<readonly string[]>

const REASON_DENIED = "denied"
const REASON_METHOD_NOT_ALLOWED = "method_not_allowed"
const REASON_MITM_REQUIRED = "mitm_required"
const REASON_NOT_ALLOWED = "not_allowed"
const REASON_NOT_ALLOWED_LOCAL = "not_allowed_local"
const REASON_POLICY_DENIED = "policy_denied"
const DNS_LOOKUP_TIMEOUT_MS = 2_000
const MAX_REQUEST_HEAD_BYTES = 64 * 1024

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase())
}

function strictIp(value: string): 0 | 4 | 6 {
  if (value.includes("%")) return 0
  const family = net.isIP(value)
  return family === 4 || family === 6 ? family : 0
}

function normalizeIpLiteral(host: string): string | undefined {
  if (strictIp(host)) return host
  for (const delimiter of ["%25", "%"]) {
    const index = host.indexOf(delimiter)
    if (index >= 0 && strictIp(host.slice(0, index))) return `${host.slice(0, index)}%${host.slice(index + delimiter.length)}`
  }
  return undefined
}

function normalizeDnsHostOrIpLiteral(host: string): string {
  const lowered = asciiLower(host).replace(/\.+$/, "")
  return normalizeIpLiteral(lowered) ?? lowered
}

export function normalizeHost(host: string): string {
  const trimmed = host.trim()
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]")
    if (end >= 0) return normalizeDnsHostOrIpLiteral(trimmed.slice(1, end))
  }
  if (trimmed.split(":").length === 2) return normalizeDnsHostOrIpLiteral(trimmed.split(":")[0])
  return normalizeDnsHostOrIpLiteral(trimmed)
}

function unscopedIpLiteral(host: string): string | undefined {
  const index = host.indexOf("%")
  if (index < 0) return undefined
  const ip = host.slice(0, index)
  return strictIp(ip) ? ip : undefined
}

function normalizePattern(pattern: string): string {
  const trimmed = pattern.trim()
  if (trimmed === "*") return "*"
  const prefix = trimmed.startsWith("**.") ? "**." : trimmed.startsWith("*.") ? "*." : ""
  return `${prefix}${normalizeHost(trimmed.slice(prefix.length))}`
}

function expandDomainPattern(pattern: string): string[] {
  const trimmed = pattern.trim()
  const prefix = trimmed.startsWith("**.") ? "**." : trimmed.startsWith("*.") ? "*." : ""
  if (!prefix) return [trimmed]
  const domain = trimmed.slice(prefix.length).trim()
  if (!domain) return [""]
  return prefix === "**." ? [domain, `?*.${domain}`] : [`?*.${domain}`]
}

function lowerByte(byte: number): number {
  return byte >= 65 && byte <= 90 ? byte + 32 : byte
}

function matchesBytes(pattern: Uint8Array, host: Uint8Array): boolean {
  let p = 0
  let h = 0
  let star: { resume: number; consumed: number } | undefined
  while (h < host.length) {
    const current = pattern[p]
    if (current === 42) {
      star = { resume: p + 1, consumed: h }
      p++
    } else if (current !== undefined && (current === 63 || lowerByte(current) === lowerByte(host[h]))) {
      p++
      h++
    } else if (star) {
      star.consumed++
      p = star.resume
      h = star.consumed
    } else {
      return false
    }
  }
  for (; p < pattern.length; p++) if (pattern[p] !== 42) return false
  return true
}

export interface CcaDomainPatternSet {
  readonly isMatch: (host: string) => boolean
}

export function compileDomainPatterns(
  patterns: readonly string[],
  options: { readonly globalWildcard: "allow" | "reject" },
): CcaDomainPatternSet {
  const compiled: Uint8Array[] = []
  const seen = new Set<string>()
  for (const pattern of patterns) {
    if (options.globalWildcard === "reject" && expandDomainPattern(normalizePattern(pattern)).includes("*")) {
      throw new Error(
        'unsupported global wildcard domain pattern "*"; use exact hosts or scoped wildcards like *.example.com or **.example.com',
      )
    }
    const raw = pattern.trim()
    if (/[{}\\/]/.test(raw) || /\s/.test(raw)) throw new Error(`unsupported domain pattern syntax: ${pattern}`)
    const host = raw.startsWith("**.") ? raw.slice(3) : raw.startsWith("*.") ? raw.slice(2) : raw
    if (host.includes("**")) throw new Error(`unsupported repeated wildcard: ${pattern}`)
    if (host.includes("[") || host.includes("]")) {
      const close = host.startsWith("[") ? host.indexOf("]") : -1
      const ip = close >= 0 ? host.slice(1, close) : ""
      const suffix = close >= 0 ? host.slice(close + 1) : ""
      const normalized = normalizeDnsHostOrIpLiteral(ip)
      const unscoped = normalized.split("%")[0] ?? ""
      const valid =
        close >= 0 &&
        !/[[\]]/.test(ip) &&
        (normalized === "*" || strictIp(unscoped) === 6) &&
        !/[[\]]/.test(suffix) &&
        (/^\.*$/.test(suffix) || suffix.startsWith(":"))
      if (!valid) throw new Error(`brackets are only supported for IPv6 literals or [*]: ${pattern}`)
    }
    for (const candidate of expandDomainPattern(normalizePattern(pattern))) {
      if (seen.has(candidate)) continue
      seen.add(candidate)
      if (!candidate) throw new Error("domain pattern is empty")
      compiled.push(Buffer.from(candidate, "utf8"))
    }
  }
  return {
    isMatch: (host) => {
      const bytes = Buffer.from(host, "utf8")
      return compiled.some((pattern) => matchesBytes(pattern, bytes))
    },
  }
}

function parseIpv4(text: string): number[] | undefined {
  if (strictIp(text) !== 4) return undefined
  return text.split(".").map(Number)
}

function parseIpv6(text: string): number[] | undefined {
  if (strictIp(text) !== 6) return undefined
  let source = text
  const lastColon = source.lastIndexOf(":")
  const tail = source.slice(lastColon + 1)
  if (tail.includes(".")) {
    const octets = parseIpv4(tail)
    if (!octets) return undefined
    source = `${source.slice(0, lastColon + 1)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`
  }
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((item) => parseInt(item, 16)))
  const halves = source.split("::")
  const groups =
    halves.length === 2
      ? (() => {
          const left = parse(halves[0])
          const right = parse(halves[1])
          return [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right]
        })()
      : parse(source)
  if (groups.length !== 8 || groups.some((group) => !Number.isInteger(group))) return undefined
  return groups.flatMap((group) => [group >> 8, group & 0xff])
}

function inCidr(octets: readonly number[], base: readonly number[], prefix: number): boolean {
  const value = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0
  const baseValue = ((base[0] << 24) | (base[1] << 16) | (base[2] << 8) | base[3]) >>> 0
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return ((value & mask) >>> 0) === ((baseValue & mask) >>> 0)
}

function nonPublicIpv4(octets: readonly number[]): boolean {
  return (
    inCidr(octets, [127, 0, 0, 0], 8) ||
    inCidr(octets, [10, 0, 0, 0], 8) ||
    inCidr(octets, [172, 16, 0, 0], 12) ||
    inCidr(octets, [192, 168, 0, 0], 16) ||
    inCidr(octets, [169, 254, 0, 0], 16) ||
    inCidr(octets, [224, 0, 0, 0], 4) ||
    inCidr(octets, [255, 255, 255, 255], 32) ||
    inCidr(octets, [0, 0, 0, 0], 8) ||
    inCidr(octets, [100, 64, 0, 0], 10) ||
    inCidr(octets, [192, 0, 0, 0], 24) ||
    inCidr(octets, [192, 0, 2, 0], 24) ||
    inCidr(octets, [198, 18, 0, 0], 15) ||
    inCidr(octets, [198, 51, 100, 0], 24) ||
    inCidr(octets, [203, 0, 113, 0], 24) ||
    inCidr(octets, [240, 0, 0, 0], 4)
  )
}

export function isNonPublicIp(ip: string): boolean {
  const v4 = parseIpv4(ip)
  if (v4) return nonPublicIpv4(v4)
  const v6 = parseIpv6(ip)
  if (!v6) return false
  const zeroPrefix = v6.slice(0, 10).every((byte) => byte === 0)
  const embedded = zeroPrefix && ((v6[10] === 0 && v6[11] === 0) || (v6[10] === 0xff && v6[11] === 0xff))
  const loopback = v6.slice(0, 15).every((byte) => byte === 0) && v6[15] === 1
  if (embedded) return nonPublicIpv4(v6.slice(12)) || loopback
  return (
    loopback ||
    v6.every((byte) => byte === 0) ||
    v6[0] === 0xff ||
    (v6[0] & 0xfe) === 0xfc ||
    (v6[0] === 0xfe && (v6[1] & 0xc0) === 0x80)
  )
}

function isLoopbackHost(host: string): boolean {
  const candidate = unscopedIpLiteral(host) ?? host
  if (candidate === "localhost") return true
  const v4 = parseIpv4(candidate)
  if (v4) return v4[0] === 127
  const v6 = parseIpv6(candidate)
  return v6 !== undefined && v6.slice(0, 15).every((byte) => byte === 0) && v6[15] === 1
}

const defaultLookup: CcaDnsLookup = async (host) => (await dns.lookup(host, { all: true })).map((entry) => entry.address)

export interface CcaHostPolicyEvaluation {
  readonly decision: CcaNetworkDecision
  readonly event: CcaNetworkPolicyAuditEvent
}

export interface CcaHostPolicy {
  readonly hostBlocked: (host: string, port: number, approved?: boolean) => Promise<CcaHostBlockDecision>
  readonly evaluate: (
    request: CcaNetworkPolicyRequest,
    options?: { readonly decider?: CcaNetworkPolicyDecider; readonly method?: string; readonly client?: string },
  ) => Promise<CcaHostPolicyEvaluation>
}

function domainEntries(config: CcaRemoteNetworkProxyConfig, permission: CcaNetworkDomainPermission): string[] {
  return Object.entries(config.domains ?? {})
    .filter(([, value]) => value === permission)
    .map(([pattern]) => pattern)
}

function allowedUnixSockets(config: CcaRemoteNetworkProxyConfig): string[] {
  return Object.entries(config.unixSockets ?? {})
    .filter(([, value]) => value === "allow")
    .map(([socket]) => socket)
    .toSorted()
}

export function createCcaHostPolicy(
  config: CcaRemoteNetworkProxyConfig,
  options: { readonly lookup?: CcaDnsLookup; readonly platform?: NodeJS.Platform } = {},
): CcaHostPolicy {
  const platform = options.platform ?? process.platform
  const absolute = (target: string) => (platform === "win32" ? path.win32.isAbsolute(target) : path.posix.isAbsolute(target))
  for (const [index, socket] of allowedUnixSockets(config).entries()) {
    if (!absolute(socket) || socket.includes("\0")) {
      throw new Error(`invalid network.allow_unix_sockets[${index}]: expected a NUL-free absolute path`)
    }
  }
  const allowedDomains = domainEntries(config, "allow")
  const denySet = compileDomainPatterns(domainEntries(config, "deny"), { globalWildcard: "reject" })
  const allowSet = compileDomainPatterns(allowedDomains, { globalWildcard: "allow" })
  const reviewSet = compileDomainPatterns(config.reviewDomains, { globalWildcard: "allow" })
  const lookup = options.lookup ?? defaultLookup

  const matches = (set: CcaDomainPatternSet, host: string) => {
    const unscoped = unscopedIpLiteral(host)
    return set.isMatch(host) || (unscoped !== undefined && set.isMatch(unscoped))
  }

  const explicitLocalAllowlisted = (host: string) => {
    const unscoped = unscopedIpLiteral(host)
    return allowedDomains.some((entry) => {
      const pattern = entry.trim()
      if (pattern === "*" || pattern.startsWith("*.") || pattern.startsWith("**.")) return false
      if (pattern.includes("*") || pattern.includes("?")) return false
      const normalized = normalizeHost(pattern)
      return normalized === host || (unscoped !== undefined && normalized === unscoped)
    })
  }

  const resolvesToNonPublicIp = async (host: string, port: number) => {
    if (strictIp(host)) return isNonPublicIp(host)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const addresses = await Promise.race([
        lookup(host, port),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("DNS lookup timed out")), DNS_LOOKUP_TIMEOUT_MS)
        }),
      ])
      return addresses.some((address) => isNonPublicIp(address))
    } catch {
      return true
    } finally {
      clearTimeout(timer)
    }
  }

  const hostBlocked = async (input: string, port: number, approved = false): Promise<CcaHostBlockDecision> => {
    const host = normalizeHost(input)
    if (!host) return REASON_NOT_ALLOWED
    if (matches(denySet, host)) return REASON_DENIED
    const authorized = approved || (!matches(reviewSet, host) && matches(allowSet, host))
    if (!config.allowLocalBinding) {
      const unscoped = unscopedIpLiteral(host) ?? host
      const localLiteral = isLoopbackHost(host) || (strictIp(unscoped) !== 0 && isNonPublicIp(unscoped))
      if (localLiteral) {
        if (!explicitLocalAllowlisted(host)) return REASON_NOT_ALLOWED_LOCAL
      } else if (authorized && (await resolvesToNonPublicIp(host, port))) {
        return REASON_NOT_ALLOWED_LOCAL
      }
    }
    return authorized ? "allowed" : REASON_NOT_ALLOWED
  }

  const evaluate: CcaHostPolicy["evaluate"] = async (request, evaluation = {}) => {
    const event = (
      decision: CcaNetworkPolicyAuditEvent["decision"],
      source: CcaNetworkDecisionSource,
      reason: string,
      policyOverride: boolean,
    ): CcaNetworkPolicyAuditEvent => ({
      timestamp: new Date().toISOString(),
      scope: "domain",
      decision,
      source,
      reason,
      protocol: request.protocol,
      host: request.host,
      port: request.port,
      ...(evaluation.method === undefined ? {} : { method: evaluation.method }),
      ...(evaluation.client === undefined ? {} : { client: evaluation.client }),
      policyOverride,
    })
    const blocked = await hostBlocked(request.host, request.port)
    if (blocked === "allowed") return { decision: { type: "allow" }, event: event("allow", "baseline_policy", "allow", false) }
    if (blocked !== REASON_NOT_ALLOWED || !evaluation.decider) {
      return { decision: { type: "deny", reason: blocked }, event: event("deny", "baseline_policy", blocked, false) }
    }
    let decided: CcaNetworkDecision
    try {
      decided = await evaluation.decider(request)
    } catch {
      decided = { type: "deny", reason: REASON_NOT_ALLOWED }
    }
    if (decided.type !== "allow") {
      const reason = decided.reason || REASON_POLICY_DENIED
      return { decision: { type: decided.type, reason }, event: event(decided.type, "decider", reason, false) }
    }
    const approved = await hostBlocked(request.host, request.port, true)
    if (approved !== "allowed") {
      return { decision: { type: "deny", reason: approved }, event: event("deny", "baseline_policy", approved, false) }
    }
    return { decision: { type: "allow" }, event: event("allow", "decider", REASON_NOT_ALLOWED, true) }
  }

  return { hostBlocked, evaluate }
}

const DEFAULT_NO_PROXY_VALUE = "localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"
const HTTP_PROXY_ENV_KEYS = [
  "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "YARN_HTTP_PROXY", "YARN_HTTPS_PROXY",
  "npm_config_http_proxy", "npm_config_https_proxy", "npm_config_proxy", "NPM_CONFIG_HTTP_PROXY",
  "NPM_CONFIG_HTTPS_PROXY", "NPM_CONFIG_PROXY", "BUNDLE_HTTP_PROXY", "BUNDLE_HTTPS_PROXY", "PIP_PROXY",
  "DOCKER_HTTP_PROXY", "DOCKER_HTTPS_PROXY",
]
const WEBSOCKET_PROXY_ENV_KEYS = ["WS_PROXY", "WSS_PROXY", "ws_proxy", "wss_proxy"]
const NO_PROXY_ENV_KEYS = ["NO_PROXY", "no_proxy", "npm_config_noproxy", "NPM_CONFIG_NOPROXY", "BUNDLE_NO_PROXY"]
const ALL_PROXY_ENV_KEYS = ["ALL_PROXY", "all_proxy"]
const FTP_PROXY_ENV_KEYS = ["FTP_PROXY", "ftp_proxy"]
export const CCA_PROXY_ACTIVE_ENV_KEY = "CODEX_NETWORK_PROXY_ACTIVE"
const ALLOW_LOCAL_BINDING_ENV_KEY = "CODEX_NETWORK_ALLOW_LOCAL_BINDING"
const GIT_SSH_COMMAND_ENV_KEY = "GIT_SSH_COMMAND"
const GIT_SSH_COMMAND_PREFIX = "CODEX_PROXY_GIT_SSH_COMMAND=1 ssh -o ProxyCommand='nc -X 5 -x "
const GIT_SSH_COMMAND_SUFFIX = " %h %p'"
export const CCA_MANAGED_PROXY_ENV_KEYS: readonly string[] = [
  CCA_PROXY_ACTIVE_ENV_KEY,
  "CODEX_NETWORK_PROXY_CREDENTIAL_BROKER_ACTIVE",
  "CODEX_NETWORK_PROXY_BROKERED_CREDENTIALS",
  ALLOW_LOCAL_BINDING_ENV_KEY,
  "CODEX_NETWORK_PROXY_ATTRIBUTION_TOKEN",
  "ELECTRON_GET_USE_PROXY",
  "NODE_USE_ENV_PROXY",
  ...HTTP_PROXY_ENV_KEYS,
  ...WEBSOCKET_PROXY_ENV_KEYS,
  ...NO_PROXY_ENV_KEYS,
  "YARN_NO_PROXY",
  ...ALL_PROXY_ENV_KEYS,
  ...FTP_PROXY_ENV_KEYS,
]

export function isCcaManagedProxyEnvVar(key: string, value: string, platform: NodeJS.Platform = process.platform): boolean {
  if (CCA_MANAGED_PROXY_ENV_KEYS.includes(key)) return true
  if (CCA_CUSTOM_CA_ENV_KEYS.includes(key)) return /(?:^|[/\\])ca-bundle-[0-9a-f]{64}\.pem$/.test(value)
  return platform === "darwin" && key === GIT_SSH_COMMAND_ENV_KEY && value.startsWith("CODEX_PROXY_GIT_SSH_COMMAND=1 ")
}

function applyProxyEnv(
  env: Record<string, string>,
  input: { readonly httpPort: number; readonly socksPort?: number; readonly allowLocalBinding: boolean; readonly platform: NodeJS.Platform },
): void {
  const httpUrl = `http://127.0.0.1:${input.httpPort}`
  const set = (keys: readonly string[], value: string) => {
    for (const key of keys) env[key] = value
  }
  env[CCA_PROXY_ACTIVE_ENV_KEY] = "1"
  env[ALLOW_LOCAL_BINDING_ENV_KEY] = input.allowLocalBinding ? "1" : "0"
  set(HTTP_PROXY_ENV_KEYS, httpUrl)
  set(WEBSOCKET_PROXY_ENV_KEYS, httpUrl)
  set(NO_PROXY_ENV_KEYS, input.allowLocalBinding ? DEFAULT_NO_PROXY_VALUE : "")
  env.ELECTRON_GET_USE_PROXY = "true"
  env.NODE_USE_ENV_PROXY = "1"
  if (input.socksPort === undefined) {
    set(ALL_PROXY_ENV_KEYS, httpUrl)
    set(FTP_PROXY_ENV_KEYS, httpUrl)
    return
  }
  const socksUrl = `socks5h://127.0.0.1:${input.socksPort}`
  set(ALL_PROXY_ENV_KEYS, socksUrl)
  set(FTP_PROXY_ENV_KEYS, socksUrl)
  const existing = env[GIT_SSH_COMMAND_ENV_KEY]
  const injected = existing?.startsWith(GIT_SSH_COMMAND_PREFIX) && existing.endsWith(GIT_SSH_COMMAND_SUFFIX)
  if (input.platform === "darwin" && (existing === undefined || injected)) {
    env[GIT_SSH_COMMAND_ENV_KEY] = `${GIT_SSH_COMMAND_PREFIX}127.0.0.1:${input.socksPort}${GIT_SSH_COMMAND_SUFFIX}`
  }
}

export interface CcaManagedNetworkSandboxContext {
  readonly loopbackPorts: readonly number[]
  readonly allowLocalBinding: boolean
  readonly allowUnixSockets: readonly string[]
  readonly dangerouslyAllowAllUnixSockets: boolean
}

export interface CcaNetworkProxyCommand {
  readonly argv: readonly string[]
  readonly arg0?: string
  readonly shellSnapshot?: { readonly shell: { readonly name: string; readonly path: string } }
}

export interface StartCcaNetworkProxyOptions {
  readonly processId: string
  readonly launch: CcaRemoteNetworkProxyLaunchConfig
  readonly env: Readonly<Record<string, string>>
  readonly authorize: (input: CcaAuthorizationInput) => Promise<CcaAuthorizationGrant>
  readonly decider?: CcaNetworkPolicyDecider
  readonly onPolicyDecision?: (event: CcaNetworkPolicyAuditEvent) => void
  readonly credentialBrokers?: CcaCredentialBrokerCache
  readonly caDirectory?: string
  readonly startupEnv?: Readonly<Record<string, string | undefined>>
  readonly command?: CcaNetworkProxyCommand
  readonly lookup?: CcaDnsLookup
  readonly platform?: NodeJS.Platform
}

export type CcaCredentialMaskingState = "disabled" | "enabled" | "snapshot" | "unavailable"

export interface CcaNetworkProxyHandle {
  readonly env: Readonly<Record<string, string>>
  readonly managedNetwork: CcaManagedNetworkSandboxContext
  readonly credentialMasking: CcaCredentialMaskingState
  readonly credentialBroker?: CcaCredentialBroker
  readonly warnings: readonly string[]
  readonly close: () => Promise<void>
}

export const CCA_CREDENTIAL_MASKING_UNAVAILABLE_WARNING =
  "Credential masking is unavailable for this shell startup; preserving shell profiles and snapshots and running with unmasked credentials."

const BLOCKED_HEADERS: Readonly<Record<string, string>> = {
  [REASON_NOT_ALLOWED]: "blocked-by-allowlist",
  [REASON_NOT_ALLOWED_LOCAL]: "blocked-by-allowlist",
  [REASON_DENIED]: "blocked-by-denylist",
  [REASON_METHOD_NOT_ALLOWED]: "blocked-by-method-policy",
  [REASON_MITM_REQUIRED]: "blocked-by-mitm-required",
}

const BLOCKED_MESSAGES: Readonly<Record<string, string>> = {
  [REASON_NOT_ALLOWED]: "Domain not in allowlist.",
  [REASON_NOT_ALLOWED_LOCAL]: "Sandbox policy blocks local/private network addresses.",
  [REASON_DENIED]: "Domain denied by the sandbox policy.",
  [REASON_METHOD_NOT_ALLOWED]: "Method not allowed in limited mode.",
  [REASON_MITM_REQUIRED]: "MITM required for limited HTTPS.",
}

function textResponse(status: number, statusText: string, body: string, headers: readonly string[] = []): string {
  const length = Buffer.byteLength(body)
  return [`HTTP/1.1 ${status} ${statusText}`, "content-type: text/plain", ...headers, `content-length: ${length}`, "connection: close", "", body].join("\r\n")
}

function blockedResponse(reason: string): string {
  return textResponse(403, "Forbidden", BLOCKED_MESSAGES[reason] ?? "Request blocked by network policy.", [
    `x-proxy-error: ${BLOCKED_HEADERS[reason] ?? "blocked-by-policy"}`,
  ])
}

interface RequestHead {
  readonly method: string
  readonly target: string
  readonly version: string
  readonly headers: CcaHeader[]
  readonly rest: Buffer
}

function readRequestHead(stream: Duplex): Promise<RequestHead | undefined> {
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0)
    const finish = (head: RequestHead | undefined) => {
      stream.off("data", onData)
      stream.off("end", onEnd)
      stream.pause()
      resolve(head)
    }
    const onEnd = () => finish(undefined)
    const onData = (data: Buffer) => {
      buffer = Buffer.concat([buffer, data])
      const end = buffer.indexOf("\r\n\r\n")
      if (end < 0) {
        if (buffer.length > MAX_REQUEST_HEAD_BYTES) finish(undefined)
        return
      }
      const lines = buffer.subarray(0, end).toString("latin1").split("\r\n")
      const [method, target, version, extra] = lines[0].split(" ")
      if (!method || !target || !version?.startsWith("HTTP/1.") || extra !== undefined) return finish(undefined)
      const headers: CcaHeader[] = []
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(":")
        if (colon <= 0) return finish(undefined)
        headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()])
      }
      finish({ method, target, version, headers, rest: buffer.subarray(end + 4) })
    }
    stream.on("data", onData)
    stream.on("end", onEnd)
    stream.resume()
  })
}

function readFirstChunk(stream: net.Socket): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const onData = (data: Buffer) => {
      cleanup()
      stream.pause()
      resolve(data)
    }
    const onEnd = () => {
      cleanup()
      resolve(undefined)
    }
    const cleanup = () => {
      stream.off("data", onData)
      stream.off("end", onEnd)
      stream.off("close", onEnd)
    }
    stream.on("data", onData)
    stream.once("end", onEnd)
    stream.once("close", onEnd)
    stream.resume()
  })
}

function prefixedDuplex(socket: net.Socket, prefix: Buffer): Duplex {
  const duplex = new Duplex({
    read() {
      socket.resume()
    },
    write(chunk: Buffer, _encoding, callback) {
      socket.write(chunk, callback)
    },
    final(callback) {
      socket.end()
      callback()
    },
    destroy(error, callback) {
      socket.destroy()
      callback(error)
    },
  })
  if (prefix.length > 0) duplex.push(prefix)
  socket.on("data", (data: Buffer) => {
    if (!duplex.push(data)) socket.pause()
  })
  socket.once("end", () => duplex.push(null))
  socket.once("close", () => duplex.destroy())
  return duplex
}

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authorization", "proxy-authenticate", "te", "trailer", "upgrade"])
const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"]
const HTTP_METHOD_START = /^[A-Z]{3,10} /

function parseAuthority(authority: string): { host: string; port: number } | undefined {
  const match = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(authority)
  if (!match) return undefined
  const port = Number(match[3])
  if (port < 1 || port > 65_535) return undefined
  return { host: match[1] ?? match[2], port }
}

function urlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host
}

function rawPathOf(target: string): string {
  const withoutOrigin = target.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "")
  return withoutOrigin.split(/[?#]/)[0] || "/"
}

function forwardedHeaders(head: RequestHead): CcaHeader[] {
  const connectionTokens = new Set(
    head.headers
      .filter(([name]) => asciiLower(name) === "connection")
      .flatMap(([, value]) => value.split(",").map((token) => asciiLower(token.trim()))),
  )
  return head.headers.filter(([name]) => !HOP_BY_HOP.has(asciiLower(name)) && !connectionTokens.has(asciiLower(name)))
}

function forwardRequest(client: Duplex, upstream: Duplex, head: RequestHead, target: string, headers: readonly CcaHeader[]): void {
  upstream.once("close", () => client.end())
  client.once("close", () => upstream.destroy())
  upstream.write(
    `${head.method} ${target} ${head.version}\r\n${[...headers, ["Connection", "close"] as const].map(([name, value]) => `${name}: ${value}`).join("\r\n")}\r\n\r\n`,
    "latin1",
  )
  const contentLength = head.headers.find(([name]) => asciiLower(name) === "content-length")?.[1]
  const chunked = head.headers.some(([name, value]) => asciiLower(name) === "transfer-encoding" && /chunked/i.test(value))
  let remaining = chunked ? Infinity : contentLength !== undefined && /^\d+$/.test(contentLength) ? Number(contentLength) : 0
  const forward = (data: Buffer) => {
    if (remaining <= 0) return
    const slice = remaining === Infinity ? data : data.subarray(0, remaining)
    remaining -= slice.length
    upstream.write(slice)
  }
  forward(head.rest)
  client.on("data", forward)
  upstream.pipe(client)
  client.resume()
}

type TunnelMode = "disabled" | "enabled" | "detect"

export async function startCcaNetworkProxy(options: StartCcaNetworkProxyOptions): Promise<CcaNetworkProxyHandle> {
  const proxy = options.launch.proxy
  const platform = options.platform ?? process.platform
  let policy: CcaHostPolicy
  try {
    if (!proxy.enabled) throw new Error("executor-local network proxy launch requires an enabled proxy")
    policy = createCcaHostPolicy(proxy, { lookup: options.lookup, platform })
  } catch (error) {
    throw new CcaNetworkProxyError(-32602, `invalid network proxy config: ${error instanceof Error ? error.message : "invalid"}`)
  }
  const maskingRequested = proxy.credentialMasking && options.credentialBrokers !== undefined && options.caDirectory !== undefined
  let broker: CcaCredentialBroker | undefined
  let authority: CcaMitmAuthority | undefined
  if (maskingRequested) {
    try {
      authority = loadCcaMitmAuthority(options.caDirectory, options.startupEnv ?? process.env)
    } catch {
      throw new CcaNetworkProxyError(-32603, "failed to build executor network proxy")
    }
    broker = options.credentialBrokers.brokerFor({
      environmentId: options.launch.environmentId,
      conversationId: options.launch.auditMetadata.conversationId,
      providers: proxy.credentialProviders,
    }).broker
  }
  const sockets = new Set<Duplex>()
  const grants = new Set<CcaAuthorizationGrant>()
  let closed = false

  const emit = (event: CcaNetworkPolicyAuditEvent) => {
    try {
      options.onPolicyDecision?.(event)
    } catch {}
  }

  const releaseGrant = (grant: CcaAuthorizationGrant) => {
    if (!grants.delete(grant)) return
    grant.release().catch(() => {})
  }

  const admit = async (
    request: CcaNetworkPolicyRequest,
    method: string,
    client: string | undefined,
    resource: string,
    guard: (mode: CcaNetworkMode) => string | undefined,
  ): Promise<{ readonly grant: CcaAuthorizationGrant } | { readonly reason: string }> => {
    const evaluation = await policy.evaluate(request, { decider: options.decider, method, client })
    if (evaluation.decision.type !== "allow") {
      emit(evaluation.event)
      return { reason: evaluation.decision.reason }
    }
    const guarded = guard(proxy.mode)
    if (guarded) {
      emit(evaluation.event)
      emit({ ...evaluation.event, decision: "deny", source: "mode_guard", reason: guarded, policyOverride: false })
      return { reason: guarded }
    }
    let grant: CcaAuthorizationGrant | undefined
    try {
      grant = await options.authorize({
        action: "webfetch",
        resources: [resource],
        metadata: { processId: options.processId, networkProtocol: request.protocol, networkMethod: method },
      })
    } catch {}
    if (!grant || typeof grant.release !== "function" || closed) {
      if (grant && typeof grant.release === "function") grant.release().catch(() => {})
      emit({ ...evaluation.event, decision: "deny", source: "proxy_state", reason: REASON_POLICY_DENIED, policyOverride: false })
      return { reason: REASON_POLICY_DENIED }
    }
    grants.add(grant)
    emit(evaluation.event)
    return { grant }
  }

  const track = <T extends Duplex>(stream: T): T => {
    sockets.add(stream)
    stream.on("close", () => sockets.delete(stream))
    stream.on("error", () => stream.destroy())
    return stream
  }

  const connectUpstream = (host: string, port: number) =>
    new Promise<net.Socket>((resolve, reject) => {
      const upstream = track(net.connect({ host, port }))
      upstream.once("connect", () => resolve(upstream))
      upstream.once("error", reject)
    })

  const connectUpstreamTls = (host: string, port: number) =>
    new Promise<tls.TLSSocket>((resolve, reject) => {
      const upstream = track(
        tls.connect({
          host,
          port,
          ...(net.isIP(host) ? {} : { servername: host }),
          ca: [...authority!.upstreamCa],
          ALPNProtocols: ["http/1.1"],
        }),
      )
      upstream.once("secureConnect", () => resolve(upstream))
      upstream.once("error", reject)
    })

  const protocolsFor = (host: string, port: number): CcaBrokeredProtocols => broker?.interception(host, port) ?? { tls: false, http: false }

  const tunnelModeFor = (host: string, port: number): TunnelMode => {
    const protocols = protocolsFor(host, port)
    if (proxy.mode === "limited" && !protocols.http) return "enabled"
    return protocols.tls || protocols.http ? "detect" : "disabled"
  }

  const handleIntercepted = async (stream: Duplex, scheme: "http" | "https", host: string, port: number) => {
    const head = await readRequestHead(stream)
    if (!head) {
      stream.end(textResponse(400, "Bad Request", "invalid request"))
      return
    }
    if (head.method === "CONNECT") {
      stream.end(textResponse(405, "Method Not Allowed", "CONNECT not supported inside MITM"))
      return
    }
    let url: URL
    try {
      url = head.target.startsWith("/") ? new URL(`${scheme}://${urlHost(host)}:${port}${head.target}`) : new URL(head.target)
    } catch {
      stream.end(textResponse(400, "Bad Request", "invalid request target"))
      return
    }
    const targetPort = url.port ? Number(url.port) : scheme === "https" ? 443 : 80
    const requestHosts = head.headers.filter(([name]) => asciiLower(name) === "host").map(([, value]) => value)
    const mismatched =
      url.protocol !== `${scheme}:` ||
      normalizeHost(url.hostname) !== host ||
      targetPort !== port ||
      requestHosts.some((value) => {
        try {
          const parsed = new URL(`${scheme}://${value}`)
          return normalizeHost(parsed.hostname) !== host || (scheme === "http" && (parsed.port ? Number(parsed.port) : 80) !== port)
        } catch {
          return true
        }
      })
    if (mismatched) {
      stream.end(textResponse(400, "Bad Request", "host mismatch"))
      return
    }
    if (proxy.mode === "limited" && !SAFE_METHODS.includes(head.method)) {
      stream.end(blockedResponse(REASON_METHOD_NOT_ALLOWED))
      return
    }
    const rebinding = await policy.hostBlocked(host, port, true)
    if (rebinding !== "allowed") {
      stream.end(blockedResponse(rebinding))
      return
    }
    let headers = forwardedHeaders(head)
    if (requestHosts.length === 0) headers.unshift(["Host", url.host])
    if (broker) headers = broker.restoreRequestHeaders(url, rawPathOf(head.target), headers)
    let upstream: Duplex
    try {
      upstream = scheme === "https" ? await connectUpstreamTls(host, port) : await connectUpstream(host, port)
    } catch {
      stream.end(textResponse(502, "Bad Gateway", "upstream connection failed"))
      return
    }
    forwardRequest(stream, upstream, head, `${url.pathname}${url.search}`, headers)
  }

  const interceptTls = (socket: net.Socket, prefix: Buffer, host: string, port: number) => {
    let context: tls.SecureContext
    try {
      context = authority!.secureContextForHost(host)
    } catch {
      socket.destroy()
      return
    }
    const secure = track(new tls.TLSSocket(prefixedDuplex(socket, prefix), { isServer: true, secureContext: context, ALPNProtocols: ["http/1.1"] }))
    secure.once("secure", () => void handleIntercepted(secure, "https", host, port).catch(() => secure.destroy()))
  }

  const forwardOpaque = async (socket: net.Socket, prefix: Buffer, host: string, port: number) => {
    let upstream: net.Socket
    try {
      upstream = await connectUpstream(host, port)
    } catch {
      socket.destroy()
      return
    }
    upstream.once("close", () => socket.destroy())
    socket.once("close", () => upstream.destroy())
    if (prefix.length > 0) upstream.write(prefix)
    socket.pipe(upstream)
    upstream.pipe(socket)
    socket.resume()
  }

  const runTunnel = async (socket: net.Socket, prefix: Buffer, host: string, port: number, mode: TunnelMode) => {
    if (mode === "disabled") return forwardOpaque(socket, prefix, host, port)
    if (mode === "enabled") {
      const first = prefix.length > 0 ? prefix : await readFirstChunk(socket)
      if (!first) return
      interceptTls(socket, first, host, port)
      return
    }
    const first = prefix.length > 0 ? prefix : await readFirstChunk(socket)
    if (!first) return
    const protocols = protocolsFor(host, port)
    if (first[0] === 0x16 && protocols.tls) {
      interceptTls(socket, first, host, port)
      return
    }
    if (protocols.http && HTTP_METHOD_START.test(first.subarray(0, 12).toString("latin1"))) {
      socket.unshift(first)
      await handleIntercepted(socket, "http", host, port)
      return
    }
    if (proxy.mode === "limited") {
      socket.destroy()
      return
    }
    await forwardOpaque(socket, first, host, port)
  }

  const handleConnect = async (socket: net.Socket, head: RequestHead, client: string | undefined) => {
    const target = parseAuthority(head.target)
    const host = target ? normalizeHost(target.host) : ""
    if (!target || !host) {
      socket.end(textResponse(400, "Bad Request", "missing authority"))
      return
    }
    const mode = tunnelModeFor(host, target.port)
    const admitted = await admit(
      { protocol: "https_connect", host, port: target.port },
      "CONNECT",
      client,
      `https://${urlHost(host)}:${target.port}`,
      () => (mode === "enabled" && !authority ? REASON_MITM_REQUIRED : undefined),
    )
    if ("reason" in admitted) {
      socket.end(blockedResponse(admitted.reason))
      return
    }
    socket.once("close", () => releaseGrant(admitted.grant))
    socket.write("HTTP/1.1 200 Connection established\r\n\r\n")
    await runTunnel(socket, head.rest, host, target.port, mode)
  }

  const handlePlain = async (socket: net.Socket, head: RequestHead, client: string | undefined) => {
    const hostHeaders = head.headers.filter(([name]) => asciiLower(name) === "host")
    if (hostHeaders.length > 1) {
      socket.end(textResponse(400, "Bad Request", "multiple Host headers"))
      return
    }
    let url: URL
    try {
      url = new URL(head.target)
    } catch {
      socket.end(textResponse(400, "Bad Request", "missing host"))
      return
    }
    if (url.protocol !== "http:") {
      socket.end(textResponse(400, "Bad Request", "unsupported scheme"))
      return
    }
    const host = normalizeHost(url.hostname)
    if (!host) {
      socket.end(textResponse(400, "Bad Request", "missing host"))
      return
    }
    const port = url.port ? Number(url.port) : 80
    const admitted = await admit(
      { protocol: "http", host, port },
      head.method,
      client,
      `http://${urlHost(host)}:${port}${url.pathname}${url.search}`,
      (mode) => (mode === "limited" && !SAFE_METHODS.includes(head.method) ? REASON_METHOD_NOT_ALLOWED : undefined),
    )
    if ("reason" in admitted) {
      socket.end(blockedResponse(admitted.reason))
      return
    }
    socket.once("close", () => releaseGrant(admitted.grant))
    let headers = forwardedHeaders(head)
    if (hostHeaders.length === 0) headers.unshift(["Host", url.host])
    if (broker) headers = broker.restoreRequestHeaders(url, rawPathOf(head.target), headers)
    let upstream: net.Socket
    try {
      upstream = await connectUpstream(host, port)
    } catch {
      socket.end(textResponse(502, "Bad Gateway", "upstream connection failed"))
      return
    }
    forwardRequest(socket, upstream, head, `${url.pathname}${url.search}`, headers)
  }

  const httpServer = net.createServer((socket) => {
    track(socket)
    const client = socket.remoteAddress
    void readRequestHead(socket)
      .then(async (head) => {
        if (!head) {
          socket.end(textResponse(400, "Bad Request", "invalid request"))
          return
        }
        if (head.method === "CONNECT") await handleConnect(socket, head, client)
        else await handlePlain(socket, head, client)
      })
      .catch(() => socket.destroy())
  })

  const socksReply = (code: number) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0])

  const readExactly = (socket: net.Socket, state: { buffer: Buffer }, count: number) =>
    new Promise<Buffer | undefined>((resolve) => {
      const attempt = () => {
        if (state.buffer.length >= count) {
          socket.off("data", onData)
          socket.off("close", onClose)
          socket.pause()
          const result = state.buffer.subarray(0, count)
          state.buffer = state.buffer.subarray(count)
          resolve(result)
          return true
        }
        return false
      }
      const onData = (data: Buffer) => {
        state.buffer = Buffer.concat([state.buffer, data])
        attempt()
      }
      const onClose = () => {
        socket.off("data", onData)
        resolve(undefined)
      }
      if (attempt()) return
      socket.on("data", onData)
      socket.once("close", onClose)
      socket.resume()
    })

  const handleSocks = async (socket: net.Socket) => {
    const state = { buffer: Buffer.alloc(0) }
    const greeting = await readExactly(socket, state, 2)
    if (!greeting || greeting[0] !== 5) {
      socket.destroy()
      return
    }
    const methods = await readExactly(socket, state, greeting[1])
    if (!methods) return
    if (!methods.includes(0)) {
      socket.end(Buffer.from([5, 0xff]))
      return
    }
    socket.write(Buffer.from([5, 0]))
    const request = await readExactly(socket, state, 4)
    if (!request || request[0] !== 5) {
      socket.destroy()
      return
    }
    let rawHost: string
    if (request[3] === 1) {
      const address = await readExactly(socket, state, 4)
      if (!address) return
      rawHost = [...address].join(".")
    } else if (request[3] === 3) {
      const length = await readExactly(socket, state, 1)
      const name = length && (await readExactly(socket, state, length[0]))
      if (!name) return
      rawHost = name.toString("utf8")
    } else if (request[3] === 4) {
      const address = await readExactly(socket, state, 16)
      if (!address) return
      rawHost = Array.from({ length: 8 }, (_, index) => address.readUInt16BE(index * 2).toString(16)).join(":")
    } else {
      socket.end(socksReply(8))
      return
    }
    const portBytes = await readExactly(socket, state, 2)
    if (!portBytes) return
    if (request[1] !== 1) {
      socket.end(socksReply(7))
      return
    }
    const port = portBytes.readUInt16BE(0)
    const host = normalizeHost(rawHost)
    if (!host || port === 0) {
      socket.end(socksReply(1))
      return
    }
    const mode = tunnelModeFor(host, port)
    const admitted = await admit(
      { protocol: "socks5_tcp", host, port },
      "CONNECT",
      socket.remoteAddress,
      `socks5h://${urlHost(host)}:${port}`,
      (networkMode) => {
        if (networkMode === "limited" && port !== 443 && !protocolsFor(host, port).http) return REASON_METHOD_NOT_ALLOWED
        return mode === "enabled" && !authority ? REASON_MITM_REQUIRED : undefined
      },
    )
    if ("reason" in admitted) {
      socket.end(socksReply(2))
      return
    }
    socket.once("close", () => releaseGrant(admitted.grant))
    socket.write(socksReply(0))
    await runTunnel(socket, state.buffer, host, port, mode)
  }

  const socksServer = proxy.enableSocks5
    ? net.createServer((socket) => {
        track(socket)
        void handleSocks(socket).catch(() => socket.destroy())
      })
    : undefined

  const listen = (server: net.Server) =>
    new Promise<number>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => {
        const address = server.address()
        if (address && typeof address === "object") resolve(address.port)
        else reject(new Error("proxy listener has no TCP address"))
      })
    })
  const servers = [httpServer, ...(socksServer ? [socksServer] : [])]

  const close = async () => {
    if (closed) return
    closed = true
    for (const socket of sockets) socket.destroy()
    for (const grant of grants) releaseGrant(grant)
    await Promise.all(
      servers.filter((server) => server.listening).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    )
  }

  let httpPort: number
  let socksPort: number | undefined
  try {
    httpPort = await listen(httpServer)
    socksPort = socksServer ? await listen(socksServer) : undefined
  } catch {
    await close()
    throw new CcaNetworkProxyError(-32603, "failed to start executor network proxy")
  }

  const warnings: string[] = []
  let credentialMasking: CcaCredentialMaskingState = proxy.credentialMasking ? "unavailable" : "disabled"
  let env: Record<string, string> = { ...options.env }
  if (broker && authority) {
    const masked = broker.maskEnvironment(env)
    applyProxyEnv(masked.env, { httpPort, socksPort, allowLocalBinding: proxy.allowLocalBinding, platform })
    authority.applyChildTrust(masked.env)
    const command = options.command
    const program = command?.argv[0] ?? ""
    const unixLike = platform === "linux" || platform === "darwin"
    const snapshotShell = command?.shellSnapshot?.shell
    const credentialSnapshot =
      unixLike &&
      command !== undefined &&
      command.arg0 === undefined &&
      snapshotShell?.name === "zsh" &&
      command.argv.length === 3 &&
      program === snapshotShell.path &&
      command.argv[1] === "-lc" &&
      path.posix.basename(program) === "zsh"
    const supportedShell =
      unixLike &&
      command !== undefined &&
      command.argv.length === 3 &&
      path.posix.basename(program) === "bash" &&
      command.argv[1] === "-c" &&
      !["BASH_ENV", "ENV", "SSH_CLIENT", "SSH2_CLIENT"].some((key) => key in env) &&
      command.arg0 === undefined &&
      command.shellSnapshot === undefined
    if (credentialSnapshot) {
      env = broker.restoreEnvironment(masked.env)
      credentialMasking = "snapshot"
    } else if (supportedShell) {
      env = masked.env
      credentialMasking = "enabled"
      if (masked.unmaskedKeys.length > 0) warnings.push(CCA_CREDENTIAL_MASKING_PARTIAL_WARNING)
    } else {
      env = broker.restoreEnvironment(masked.env)
      warnings.push(CCA_CREDENTIAL_MASKING_UNAVAILABLE_WARNING)
    }
  } else {
    applyProxyEnv(env, { httpPort, socksPort, allowLocalBinding: proxy.allowLocalBinding, platform })
  }
  return {
    env,
    managedNetwork: {
      loopbackPorts: socksPort === undefined ? [httpPort] : [httpPort, socksPort],
      allowLocalBinding: proxy.allowLocalBinding,
      allowUnixSockets: allowedUnixSockets(proxy),
      dangerouslyAllowAllUnixSockets: proxy.dangerouslyAllowAllUnixSockets,
    },
    credentialMasking,
    ...(credentialMasking === "snapshot" && broker ? { credentialBroker: broker } : {}),
    warnings,
    close,
  }
}
