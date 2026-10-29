export * as CcaCredentialBroker from "./credential-broker"

import { randomInt } from "node:crypto"
import net from "node:net"
import type { CcaCredentialAuthMethod, CcaCredentialProviderConfig } from "./network-proxy"

export const CCA_CREDENTIAL_BROKER_ACTIVE_ENV_KEY = "CODEX_NETWORK_PROXY_CREDENTIAL_BROKER_ACTIVE"
export const CCA_BROKERED_CREDENTIALS_ENV_KEY = "CODEX_NETWORK_PROXY_BROKERED_CREDENTIALS"
export const CCA_CREDENTIAL_MASKING_PARTIAL_WARNING =
  "Credential masking could not protect some environment credentials; continuing with those values unmasked."

export type CcaHeader = readonly [string, string]

export interface CcaBrokeredProtocols {
  readonly tls: boolean
  readonly http: boolean
}

const MIN_EMBEDDED_CREDENTIAL_LENGTH = 16
const DUMMY_ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
const MAX_REGEX_BYTES = 2048
const MAX_REGEX_REPEAT = 64
const MAX_DUMMY_ATTEMPTS = 64
const MAX_DUMMY_VALUE_BYTES = 2048
const HEADER_VALUE = /^[\x20-\x7e\t]*$/

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase())
}

function normalizeHost(host: string): string {
  const trimmed = host.trim()
  const bracketed = trimmed.startsWith("[") && trimmed.indexOf("]") > 0 ? trimmed.slice(1, trimmed.indexOf("]")) : trimmed
  return asciiLower(bracketed).replace(/\.+$/, "")
}

function isLoopbackHost(host: string): boolean {
  if (host === "localhost") return true
  if (net.isIPv4(host)) return host.startsWith("127.")
  return host === "::1"
}

function randomAlphanumeric(length: number): string {
  let output = ""
  for (let index = 0; index < length; index++) output += DUMMY_ALPHANUMERIC[randomInt(DUMMY_ALPHANUMERIC.length)]
  return output
}

function shapedDummy(real: string, prefix: string, minimumLength: number): string {
  const marker = `${prefix}masked`
  const target = Math.max(real.length, minimumLength, marker.length + 22)
  return `${marker}${randomAlphanumeric(target - marker.length)}`
}

function headerValid(value: string): boolean {
  return HEADER_VALUE.test(value)
}

function getHeader(headers: readonly CcaHeader[], name: string): string | undefined {
  return headers.find(([key]) => asciiLower(key) === asciiLower(name))?.[1]
}

function translateStandardAuthorization(headers: readonly CcaHeader[], expected: string, replacement: string): string | undefined {
  const header = getHeader(headers, "authorization")
  if (header === undefined) return undefined
  const space = header.indexOf(" ")
  if (space < 0) return undefined
  const scheme = header.slice(0, space)
  const value = header.slice(space + 1).trim()
  if (asciiLower(scheme) === "basic") {
    const decoded = Buffer.from(value, "base64")
    if (decoded.toString("base64") !== value.replace(/=+$/, "").padEnd(Math.ceil(value.replace(/=+$/, "").length / 4) * 4, "=")) {
      return undefined
    }
    const text = decoded.toString("latin1")
    const expectedLatin = Buffer.from(expected).toString("latin1")
    const replacementLatin = Buffer.from(replacement).toString("latin1")
    let translated: string
    if (text === expectedLatin) translated = replacementLatin
    else {
      const separator = text.indexOf(":")
      if (separator < 0) return undefined
      const user = text.slice(0, separator)
      const password = text.slice(separator + 1)
      if (user !== expectedLatin && password !== expectedLatin) return undefined
      translated = `${user === expectedLatin ? replacementLatin : user}:${password === expectedLatin ? replacementLatin : password}`
    }
    return `${scheme} ${Buffer.from(translated, "latin1").toString("base64")}`
  }
  if ((asciiLower(scheme) === "bearer" || asciiLower(scheme) === "token") && value === expected) return `${scheme} ${replacement}`
  return undefined
}

function trustedBaseUrlHost(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" || url.username || url.password) return undefined
    return normalizeHost(url.hostname)
  } catch {
    return undefined
  }
}

interface Destination {
  readonly scheme: "http" | "https"
  readonly host: string
  readonly wildcard: boolean
  readonly port: number
  readonly pathPrefix: string
}

function parseDestination(input: string): Destination {
  const value = input.trim()
  const separator = value.indexOf("://")
  const explicit = separator >= 0 ? asciiLower(value.slice(0, separator)) : undefined
  let authority = separator >= 0 ? value.slice(separator + 3) : value
  const wildcard = authority.startsWith("*.")
  if (wildcard) authority = `wildcard.${authority.slice(2)}`
  const url = new URL(`https://${authority}`)
  if (url.username || url.password || url.search || url.hash || authority.includes("?") || authority.includes("#")) {
    throw new Error("credential destination cannot include user information, a query, or a fragment")
  }
  let host = url.hostname
  if (wildcard) {
    if (!host.startsWith("wildcard.")) throw new Error("credential destination has an invalid wildcard")
    host = host.slice("wildcard.".length)
  }
  host = normalizeHost(host)
  if (!host || host.includes("*") || host.includes("/")) throw new Error("credential destination must have an exact hostname or scoped wildcard")
  const loopback = !wildcard && isLoopbackHost(host)
  let scheme: "http" | "https"
  if (explicit === undefined) scheme = loopback ? "http" : "https"
  else if (explicit === "https") scheme = "https"
  else if (explicit === "http" && loopback) scheme = "http"
  else throw new Error("credential destination must use HTTPS unless it targets loopback over HTTP")
  const parsed = scheme === "http" ? new URL(`http://${authority}`) : url
  return {
    scheme,
    host,
    wildcard,
    port: parsed.port ? Number(parsed.port) : scheme === "https" ? 443 : 80,
    pathPrefix: parsed.pathname || "/",
  }
}

function destinationMatchesHost(destination: Destination, host: string, port: number): boolean {
  if (destination.port !== port) return false
  return destination.wildcard ? host.endsWith(destination.host) && host.slice(0, -destination.host.length).endsWith(".") : host === destination.host
}

function safeAuthorizationPath(rawPath: string): boolean {
  return !/%(?:2e|2f|5c)/i.test(rawPath) && !rawPath.includes("\\") && !rawPath.split("/").some((segment) => segment === "." || segment === "..")
}

function destinationMatchesRequest(destination: Destination, host: string, url: URL, rawPath: string): boolean {
  if (url.protocol !== `${destination.scheme}:`) return false
  const port = url.port ? Number(url.port) : destination.scheme === "https" ? 443 : 80
  if (!destinationMatchesHost(destination, host, port) || !safeAuthorizationPath(rawPath)) return false
  const requestPath = url.pathname
  if (destination.pathPrefix === "/" || requestPath === destination.pathPrefix) return true
  if (!requestPath.startsWith(destination.pathPrefix)) return false
  return destination.pathPrefix.endsWith("/") || requestPath.slice(destination.pathPrefix.length).startsWith("/")
}

type Binding =
  | { readonly kind: "hosts"; readonly hosts: readonly string[]; readonly suffixes: readonly string[] }
  | { readonly kind: "configured"; readonly destinations: readonly Destination[] }

function bindingKey(binding: Binding): string {
  return JSON.stringify(binding)
}

function bindingMatchesHost(binding: Binding, host: string): boolean {
  return binding.kind === "hosts" && (binding.hosts.includes(host) || binding.suffixes.some((suffix) => host.endsWith(suffix)))
}

function bindingProtocols(binding: Binding, host: string, port: number): CcaBrokeredProtocols {
  if (binding.kind === "hosts") return { tls: bindingMatchesHost(binding, host), http: false }
  return {
    tls: binding.destinations.some((destination) => destination.scheme === "https" && destinationMatchesHost(destination, host, port)),
    http: binding.destinations.some((destination) => destination.scheme === "http" && destinationMatchesHost(destination, host, port)),
  }
}

function bindingMatchesRequest(binding: Binding, host: string, url: URL, rawPath: string): boolean {
  if (binding.kind === "hosts") return url.protocol === "https:" && bindingMatchesHost(binding, host)
  return binding.destinations.some((destination) => destinationMatchesRequest(destination, host, url, rawPath))
}

interface Provider {
  readonly id: string
  readonly builtin: boolean
  readonly envVars: readonly string[]
  readonly binding: (env: Readonly<Record<string, string>>) => Binding | undefined
  readonly accepts: (value: string) => boolean
  readonly dummy: (real: string) => string | undefined
  readonly translate: (headers: readonly CcaHeader[], expected: string, replacement: string) => CcaHeader[]
}

const OPENAI_PREFIXES = ["sk-proj-", "sk-svcacct-", "sk-admin-", "sk-"]
const GITHUB_PREFIXES = ["github_pat_", "ghp_", "gho_", "ghu_", "ghs_", "ghr_"]
const GITHUB_CLOUD_HOSTS = ["api.github.com", "github.com", "uploads.github.com"]
const GITHUB_CLOUD_SUFFIXES = [".ghe.com"]

function prefixOf(value: string, prefixes: readonly string[], fallback: string): string {
  return prefixes.find((prefix) => value.startsWith(prefix)) ?? fallback
}

function githubHostHint(env: Readonly<Record<string, string>>): string | undefined {
  const value = env.GH_HOST?.trim()
  if (!value || /[/\\@?#*]/.test(value)) return undefined
  try {
    const host = new URL(`https://${net.isIPv6(value) ? `[${value}]` : value}`).hostname
    return normalizeHost(host)
  } catch {
    return undefined
  }
}

function githubCloudHost(host: string): boolean {
  return GITHUB_CLOUD_HOSTS.includes(host) || GITHUB_CLOUD_SUFFIXES.some((suffix) => host.endsWith(suffix))
}

const bearerOnly = (headers: readonly CcaHeader[], expected: string, replacement: string): CcaHeader[] => {
  const header = getHeader(headers, "authorization")
  return header !== undefined && header.includes(expected) && headerValid(`Bearer ${replacement}`)
    ? [["authorization", `Bearer ${replacement}`]]
    : []
}

const standardAuthorization = (headers: readonly CcaHeader[], expected: string, replacement: string): CcaHeader[] => {
  const translated = translateStandardAuthorization(headers, expected, replacement)
  return translated === undefined ? [] : [["authorization", translated]]
}

const builtinProviders: readonly Provider[] = [
  {
    id: "builtin:github",
    builtin: true,
    envVars: ["GH_TOKEN", "GITHUB_TOKEN"],
    binding: () => ({ kind: "hosts", hosts: GITHUB_CLOUD_HOSTS, suffixes: GITHUB_CLOUD_SUFFIXES }),
    accepts: (value) => headerValid(`Bearer ${value}`),
    dummy: (real) => shapedDummy(real, prefixOf(real, GITHUB_PREFIXES, "ghp_"), 40),
    translate: standardAuthorization,
  },
  {
    id: "builtin:github-enterprise",
    builtin: true,
    envVars: ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"],
    binding: (env) => {
      const host = githubHostHint(env)
      return host && !githubCloudHost(host) ? { kind: "hosts", hosts: [host], suffixes: [] } : undefined
    },
    accepts: (value) => headerValid(`Bearer ${value}`),
    dummy: (real) => shapedDummy(real, prefixOf(real, GITHUB_PREFIXES, "ghp_"), 40),
    translate: standardAuthorization,
  },
  {
    id: "builtin:openai",
    builtin: true,
    envVars: ["OPENAI_API_KEY"],
    binding: (env) => {
      const hosts = ["api.openai.com"]
      const configured = trustedBaseUrlHost(env.OPENAI_BASE_URL)
      if (configured && !hosts.includes(configured)) hosts.push(configured)
      return { kind: "hosts", hosts, suffixes: [] }
    },
    accepts: (value) => headerValid(`Bearer ${value}`),
    dummy: (real) => shapedDummy(real, prefixOf(real, OPENAI_PREFIXES, "sk-"), 51),
    translate: bearerOnly,
  },
]

const BUILTIN_ENV_KEYS = new Set(["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_HOST", "OPENAI_API_KEY", "OPENAI_BASE_URL"])

type RegexNode =
  | { readonly kind: "literal"; readonly text: string }
  | { readonly kind: "class"; readonly chars: readonly string[] }
  | { readonly kind: "sequence"; readonly items: readonly RegexNode[] }
  | { readonly kind: "alternation"; readonly options: readonly RegexNode[] }
  | { readonly kind: "repeat"; readonly node: RegexNode; readonly min: number; readonly max: number }

const PRINTABLE = Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index))
const DIGITS = PRINTABLE.filter((character) => /\d/.test(character))
const WORD = PRINTABLE.filter((character) => /\w/.test(character))

function parseRegex(pattern: string): RegexNode {
  let position = 0
  const fail = (): never => {
    throw new Error("unsupported credential pattern syntax")
  }
  const escapeSet = (character: string): readonly string[] | undefined => {
    if (character === "d") return DIGITS
    if (character === "w") return WORD
    if (/[DWsSbBpPkuxc0-9]/.test(character)) return fail()
    return undefined
  }
  const parseClass = (): RegexNode => {
    position++
    const negated = pattern[position] === "^"
    if (negated) position++
    const members = new Set<string>()
    let first = true
    while (position < pattern.length && (pattern[position] !== "]" || first)) {
      first = false
      let character = pattern[position++]
      if (character === "[") fail()
      if (character === "\\") {
        const escaped = pattern[position++] ?? fail()
        const set = escapeSet(escaped)
        if (set) {
          for (const item of set) members.add(item)
          continue
        }
        character = escaped
      }
      if (pattern[position] === "-" && pattern[position + 1] !== undefined && pattern[position + 1] !== "]") {
        position++
        let end = pattern[position++]
        if (end === "\\") end = pattern[position++] ?? fail()
        const from = character.codePointAt(0)!
        const to = end.codePointAt(0)!
        if (to < from || to - from > 0xffff) fail()
        for (let code = from; code <= to; code++) members.add(String.fromCodePoint(code))
      } else members.add(character)
    }
    if (pattern[position] !== "]") fail()
    position++
    const chars = negated ? PRINTABLE.filter((character) => !members.has(character)) : [...members]
    if (chars.length === 0) fail()
    return { kind: "class", chars }
  }
  const parseAtom = (): RegexNode => {
    const character = pattern[position]
    if (character === "(") {
      position++
      if (pattern.startsWith("?:", position)) position += 2
      else if (pattern[position] === "?") fail()
      const inner = parseAlternation()
      if (pattern[position] !== ")") fail()
      position++
      return inner
    }
    if (character === "[") return parseClass()
    if (character === ".") {
      position++
      return { kind: "class", chars: PRINTABLE }
    }
    if (character === "\\") {
      const escaped = pattern[position + 1] ?? fail()
      position += 2
      const set = escapeSet(escaped)
      return set ? { kind: "class", chars: set } : { kind: "literal", text: escaped }
    }
    if ("*+?{)|".includes(character)) fail()
    position += character.length
    return { kind: "literal", text: character }
  }
  const parseRepeat = (node: RegexNode): RegexNode => {
    const character = pattern[position]
    let min: number
    let max: number
    if (character === "*") [min, max] = [0, MAX_REGEX_REPEAT]
    else if (character === "+") [min, max] = [1, MAX_REGEX_REPEAT]
    else if (character === "?") [min, max] = [0, 1]
    else if (character === "{") {
      const match = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(position))
      if (!match) fail()
      min = Number(match![1])
      max = match![2] === undefined ? min : match![3] ? Number(match![3]) : Math.max(min, MAX_REGEX_REPEAT)
      if (max < min || min > MAX_REGEX_REPEAT) fail()
      position += match![0].length - 1
    } else return node
    position++
    if (pattern[position] === "?" || pattern[position] === "+") fail()
    return { kind: "repeat", node, min, max: Math.min(max, MAX_REGEX_REPEAT) }
  }
  const parseSequence = (): RegexNode => {
    const items: RegexNode[] = []
    while (position < pattern.length && pattern[position] !== "|" && pattern[position] !== ")") {
      if (pattern[position] === "^" && position === 0) {
        position++
        continue
      }
      if (pattern[position] === "$" && position === pattern.length - 1) {
        position++
        continue
      }
      if (pattern[position] === "^" || pattern[position] === "$") fail()
      items.push(parseRepeat(parseAtom()))
    }
    return { kind: "sequence", items }
  }
  const parseAlternation = (): RegexNode => {
    const options = [parseSequence()]
    while (pattern[position] === "|") {
      position++
      options.push(parseSequence())
    }
    return options.length === 1 ? options[0] : { kind: "alternation", options }
  }
  const node = parseAlternation()
  if (position !== pattern.length) fail()
  return node
}

function generate(node: RegexNode): string {
  switch (node.kind) {
    case "literal":
      return node.text
    case "class":
      return node.chars[randomInt(node.chars.length)]
    case "sequence":
      return node.items.map(generate).join("")
    case "alternation":
      return generate(node.options[randomInt(node.options.length)])
    default: {
      const count = node.min + randomInt(node.max - node.min + 1)
      let output = ""
      for (let index = 0; index < count; index++) output += generate(node.node)
      return output
    }
  }
}

function validEnvironmentKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
}

function compileConfiguredProvider(id: string, config: CcaCredentialProviderConfig): Provider {
  if (!id) throw new Error("credential provider name must not be empty")
  if (config.env.length === 0) throw new Error(`credential provider \`${id}\` has no environment keys`)
  if (config.patterns.length === 0) throw new Error(`credential provider \`${id}\` has no credential patterns`)
  if (config.url_prefixes.length === 0 && config.url_prefix_from_env === undefined) {
    throw new Error(`credential provider \`${id}\` has no destination URL prefixes`)
  }
  if (!config.env.every(validEnvironmentKey)) throw new Error(`credential provider \`${id}\` has an invalid environment key`)
  if (config.env.some((key) => BUILTIN_ENV_KEYS.has(key))) throw new Error(`credential provider \`${id}\` overlaps a built-in credential source`)
  const dynamicKey = config.url_prefix_from_env
  if (dynamicKey !== undefined && (!validEnvironmentKey(dynamicKey) || config.env.includes(dynamicKey))) {
    throw new Error(`credential provider \`${id}\` has an invalid host environment key`)
  }
  const staticDestinations = config.url_prefixes.map(parseDestination)
  const methods: readonly CcaCredentialAuthMethod[] = config.auth.length === 0 ? ["bearer"] : config.auth
  const header = config.header
  if (header !== undefined && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header)) throw new Error(`invalid header for credential provider \`${id}\``)
  if (methods.includes("header") !== (header !== undefined)) {
    throw new Error(`credential provider \`${id}\` requires a header name exactly when using header authentication`)
  }
  if (config.prefix !== undefined && header === undefined) {
    throw new Error(`credential provider \`${id}\` requires header authentication to use a header prefix`)
  }
  const patterns = config.patterns.map((pattern) => {
    if (Buffer.byteLength(pattern) > MAX_REGEX_BYTES) throw new Error(`credential pattern exceeds ${MAX_REGEX_BYTES} bytes`)
    const full = new RegExp(`^(?:${pattern})$`, "su")
    const generator = parseRegex(pattern)
    const candidates = function* () {
      for (let attempt = 0; attempt < MAX_DUMMY_ATTEMPTS; attempt++) {
        const candidate = generate(generator)
        if (candidate && Buffer.byteLength(candidate) <= MAX_DUMMY_VALUE_BYTES && !candidate.includes("\0") && full.test(candidate)) yield candidate
      }
    }
    if (full.test("")) throw new Error("credential pattern must not match an empty value")
    if (candidates().next().done) throw new Error("credential pattern could not independently generate a matching dummy")
    return { full, candidates }
  })

  const headerValueFor = (method: CcaCredentialAuthMethod, value: string): string | undefined => {
    const rendered =
      method === "bearer"
        ? `Bearer ${value}`
        : method === "token"
          ? `token ${value}`
          : method === "basic"
            ? `Basic ${Buffer.from(value).toString("base64")}`
            : `${config.prefix ?? ""}${value}`
    return headerValid(rendered) ? rendered : undefined
  }
  const translate = (headers: readonly CcaHeader[], expected: string, replacement: string): CcaHeader[] => {
    const translated: CcaHeader[] = []
    for (const method of methods) {
      if (method === "header") {
        const value = header === undefined ? undefined : getHeader(headers, header)
        const prefix = config.prefix ?? ""
        if (header !== undefined && value === `${prefix}${expected}` && !translated.some(([name]) => name === asciiLower(header))) {
          const replaced = `${prefix}${replacement}`
          if (headerValid(replaced)) translated.push([asciiLower(header), replaced])
        }
        continue
      }
      const authorization = getHeader(headers, "authorization")
      const scheme = authorization?.split(" ")[0]
      if (scheme === undefined || asciiLower(scheme) !== method || translated.some(([name]) => name === "authorization")) continue
      const value = translateStandardAuthorization(headers, expected, replacement)
      if (value !== undefined) translated.push(["authorization", value])
    }
    return translated
  }
  const usable = (real: string, dummy: string) =>
    methods.every((method) => {
      if (method === "basic" && real.includes(":") !== dummy.includes(":")) return false
      const realHeader = headerValueFor(method, real)
      if (realHeader === undefined) return true
      const dummyHeader = headerValueFor(method, dummy)
      if (dummyHeader === undefined || dummyHeader.trim() !== dummyHeader) return false
      const name = method === "header" ? asciiLower(header!) : "authorization"
      return translate([[name, dummyHeader]], dummy, real).some(([key, value]) => key === name && value === realHeader)
    })

  return {
    id: `configured:${id}`,
    builtin: false,
    envVars: config.env,
    binding: (env) => {
      const destinations = [...staticDestinations]
      const dynamicValue = dynamicKey === undefined ? undefined : env[dynamicKey]
      if (dynamicValue !== undefined) {
        try {
          const destination = parseDestination(dynamicValue)
          if (!destination.wildcard && !destinations.some((item) => bindingKey({ kind: "configured", destinations: [item] }) === bindingKey({ kind: "configured", destinations: [destination] }))) {
            destinations.push(destination)
          }
        } catch {}
      }
      return destinations.length === 0 ? undefined : { kind: "configured", destinations }
    },
    accepts: (value) => patterns.some((pattern) => pattern.full.test(value)) && methods.some((method) => headerValueFor(method, value) !== undefined),
    dummy: (real) => {
      const pattern = patterns.find((item) => item.full.test(real))
      if (!pattern) return undefined
      for (const candidate of pattern.candidates()) if (candidate !== real && usable(real, candidate)) return candidate
      return undefined
    },
    translate,
  }
}

interface CredentialRecord {
  readonly envVar: string
  readonly provider: Provider
  readonly real: string
  readonly dummy: string
  readonly bindings: Binding[]
}

export interface CcaCredentialBroker {
  readonly maskEnvironment: (env: Readonly<Record<string, string>>) => { readonly env: Record<string, string>; readonly unmaskedKeys: readonly string[] }
  readonly restoreEnvironment: (env: Readonly<Record<string, string>>) => Record<string, string>
  readonly maskText: (text: string) => string
  readonly restoreText: (text: string) => string
  readonly brokeredKeys: (env: Readonly<Record<string, string>>) => readonly string[]
  readonly interception: (host: string, port: number) => CcaBrokeredProtocols
  readonly restoreRequestHeaders: (destination: URL, rawPath: string, headers: readonly CcaHeader[]) => CcaHeader[]
}

export interface CcaCredentialBrokerKey {
  readonly environmentId?: string
  readonly conversationId?: string
  readonly providers: Readonly<Record<string, CcaCredentialProviderConfig>>
}

export interface CcaCredentialBrokerCache {
  readonly brokerFor: (key: CcaCredentialBrokerKey) => { readonly broker: CcaCredentialBroker; readonly ignoredProviders: readonly string[] }
}

function containsRealValue(record: CredentialRecord, text: string): boolean {
  return text === record.real || (record.real.length >= MIN_EMBEDDED_CREDENTIAL_LENGTH && text.includes(record.real))
}

function replaceAllLongestFirst(text: string, pairs: readonly (readonly [string, string])[]): string {
  let output = text
  for (const [from, to] of [...pairs].toSorted((left, right) => right[0].length - left[0].length)) {
    if (from) output = output.split(from).join(to)
  }
  return output
}

const BUILTIN_SHAPED = new RegExp(
  [
    ...OPENAI_PREFIXES.map((prefix) => `${prefix.replace(/-/g, "\\-")}[A-Za-z0-9_-]{${51 - prefix.length},}`),
    ...GITHUB_PREFIXES.map((prefix) => `${prefix}[A-Za-z0-9_]{${40 - prefix.length},}`),
  ].join("|"),
  "g",
)

function createBroker(providers: readonly Provider[]): CcaCredentialBroker {
  const records: CredentialRecord[] = []
  const isDummy = (value: string) => records.some((record) => record.dummy === value)

  const maskText = (text: string) =>
    replaceAllLongestFirst(
      text,
      records.filter((record) => containsRealValue(record, text)).map((record) => [record.real, record.dummy] as const),
    )

  const restoreText = (text: string) =>
    replaceAllLongestFirst(
      text,
      records.filter((record) => text.includes(record.dummy)).map((record) => [record.dummy, record.real] as const),
    )

  const maskEnvironment: CcaCredentialBroker["maskEnvironment"] = (input) => {
    const env = { ...input }
    for (const provider of providers) {
      const binding = provider.binding(env)
      if (!binding) continue
      for (const envVar of provider.envVars) {
        const raw = env[envVar]
        if (raw === undefined) continue
        const real = provider.builtin ? raw.trim() : raw
        if (!real || isDummy(real) || !provider.accepts(real)) continue
        let record = records.find((item) => item.provider === provider && item.envVar === envVar && item.real === real)
        if (!record) {
          const dummy = provider.dummy(real)
          if (dummy === undefined || isDummy(dummy)) continue
          record = { envVar, provider, real, dummy, bindings: [] }
          records.push(record)
        }
        if (!record.bindings.some((item) => bindingKey(item) === bindingKey(binding))) record.bindings.push(binding)
        env[envVar] = record.dummy
      }
    }
    for (const [key, value] of Object.entries(env)) {
      if (key === CCA_CREDENTIAL_BROKER_ACTIVE_ENV_KEY || key === CCA_BROKERED_CREDENTIALS_ENV_KEY) continue
      env[key] = maskText(value)
    }
    const present = records
      .filter((record) => Object.entries(env).some(([key, value]) => key !== CCA_BROKERED_CREDENTIALS_ENV_KEY && value.includes(record.dummy)))
      .map((record) => [record.envVar, record.dummy] as const)
      .toSorted((left, right) => (left[0] === right[0] ? left[1].localeCompare(right[1]) : left[0].localeCompare(right[0])))
    env[CCA_CREDENTIAL_BROKER_ACTIVE_ENV_KEY] = "1"
    env[CCA_BROKERED_CREDENTIALS_ENV_KEY] = JSON.stringify(present)
    const shapedUnmasked = (value: string) =>
      [...value.matchAll(BUILTIN_SHAPED)].some(([match]) => !records.some((record) => record.dummy.includes(match) || match.includes(record.dummy)))
    const unmaskedKeys = Object.entries(env)
      .filter(
        ([key, value]) =>
          key !== CCA_BROKERED_CREDENTIALS_ENV_KEY &&
          (records.some((record) => containsRealValue(record, value.trim())) || shapedUnmasked(value)),
      )
      .map(([key]) => key)
    return { env, unmaskedKeys }
  }

  const restoreEnvironment: CcaCredentialBroker["restoreEnvironment"] = (input) => {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(input)) {
      if (key === CCA_CREDENTIAL_BROKER_ACTIVE_ENV_KEY || key === CCA_BROKERED_CREDENTIALS_ENV_KEY) continue
      env[key] = restoreText(value)
    }
    return env
  }

  const brokeredKeys: CcaCredentialBroker["brokeredKeys"] = (env) =>
    Object.entries(env)
      .filter(([key, value]) => key !== CCA_BROKERED_CREDENTIALS_ENV_KEY && records.some((record) => value.includes(record.dummy)))
      .map(([key]) => key)
      .toSorted()

  const interception: CcaCredentialBroker["interception"] = (input, port) => {
    const host = normalizeHost(input)
    let tlsRequired = false
    let httpRequired = false
    for (const record of records) {
      for (const binding of record.bindings) {
        const protocols = bindingProtocols(binding, host, port)
        tlsRequired ||= protocols.tls
        httpRequired ||= protocols.http
      }
    }
    return { tls: tlsRequired, http: httpRequired }
  }

  const restoreRequestHeaders: CcaCredentialBroker["restoreRequestHeaders"] = (destination, rawPath, headers) => {
    const host = normalizeHost(destination.hostname)
    const matching = records.filter((record) => record.bindings.some((binding) => bindingMatchesRequest(binding, host, destination, rawPath)))
    const selected = new Map<string, { readonly record: CredentialRecord; readonly value: string }>()
    const ambiguous = new Set<string>()
    for (const record of matching) {
      for (const candidate of matching.filter((item) => item.provider === record.provider && item.real === record.real)) {
        for (const [name, value] of record.provider.translate(headers, candidate.dummy, record.real)) {
          if (ambiguous.has(name)) continue
          const existing = selected.get(name)
          if (!existing) selected.set(name, { record, value })
          else if (existing.record.provider !== record.provider || existing.record.real !== record.real || existing.value !== value) {
            selected.delete(name)
            ambiguous.add(name)
          }
        }
      }
    }
    if (selected.size === 0) return [...headers]
    return [
      ...headers.filter(([name]) => !selected.has(asciiLower(name))),
      ...[...selected].map(([name, { value }]) => [name, value] as const),
    ]
  }

  return { maskEnvironment, restoreEnvironment, maskText, restoreText, brokeredKeys, interception, restoreRequestHeaders }
}

export function createCcaCredentialBrokerCache(): CcaCredentialBrokerCache {
  const brokers = new Map<string, { readonly broker: CcaCredentialBroker; readonly ignoredProviders: readonly string[] }>()
  return {
    brokerFor: (key) => {
      const cacheKey = JSON.stringify([key.environmentId ?? null, key.conversationId ?? null, Object.entries(key.providers).toSorted(([left], [right]) => left.localeCompare(right))])
      const cached = brokers.get(cacheKey)
      if (cached) return cached
      const configured: Provider[] = []
      const ignoredProviders: string[] = []
      for (const [id, config] of Object.entries(key.providers).toSorted(([left], [right]) => left.localeCompare(right))) {
        try {
          const provider = compileConfiguredProvider(id, config)
          if (configured.some((existing) => existing.envVars.some((envVar) => provider.envVars.includes(envVar)))) {
            ignoredProviders.push(id)
            continue
          }
          configured.push(provider)
        } catch {
          ignoredProviders.push(id)
        }
      }
      const entry = { broker: createBroker([...builtinProviders, ...configured]), ignoredProviders }
      brokers.set(cacheKey, entry)
      return entry
    },
  }
}
