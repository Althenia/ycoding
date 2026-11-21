export * as Codec from "./codec"
export { frame, FrameReader } from "@ycoding-ai/protocol/v5/framing"

type Scalar = "string" | "bytes" | "bool" | "uint32" | "uint64" | "double" | "enum"
type Label = "required" | "optional" | "repeated"
export type Field = {
  readonly tag: number
  readonly name: string
  readonly type: Scalar | string
  readonly label: Label
}

const r = (tag: number, name: string, type: string): Field => ({ tag, name, type, label: "required" })
const o = (tag: number, name: string, type: string): Field => ({ tag, name, type, label: "optional" })
const m = (tag: number, name: string, type: string): Field => ({ tag, name, type, label: "repeated" })

const call = r(1, "call", "Call")
const mcpOperations = (start: number) => [
  o(start, "servers", "McpServers"),
  o(start + 1, "tools", "McpTools"),
  o(start + 2, "read_resource", "McpReadResource"),
  o(start + 3, "call_tool", "McpCallTool"),
  o(start + 4, "session_get", "SessionGet"),
  o(start + 5, "session_prompt", "SessionPrompt"),
  o(start + 6, "session_interrupt", "SessionInterrupt"),
  o(start + 7, "session_create", "SessionCreate"),
  o(start + 8, "session_generate", "SessionGenerate"),
  o(start + 9, "session_command", "SessionCommand"),
  o(start + 10, "session_synthetic", "SessionSynthetic"),
  o(start + 11, "agents_list", "AgentList"),
  o(start + 12, "agent_get", "DomainGet"),
  o(start + 13, "agent_reload", "DomainReload"),
  o(start + 14, "commands_list", "DomainList"),
  o(start + 15, "command_reload", "DomainReload"),
  o(start + 16, "references_list", "DomainList"),
  o(start + 17, "reference_reload", "DomainReload"),
  o(start + 18, "skills_list", "DomainList"),
  o(start + 19, "skill_reload", "DomainReload"),
  o(start + 20, "providers_list", "DomainList"),
  o(start + 21, "provider_get", "DomainGet"),
  o(start + 22, "models_list", "DomainList"),
  o(start + 23, "model_get", "ModelGet"),
  o(start + 24, "model_default", "DomainList"),
  o(start + 25, "catalog_reload", "DomainReload"),
  o(start + 26, "plugins_list", "DomainList"),
  o(start + 27, "integrations_list", "DomainList"),
  o(start + 28, "integration_get", "DomainGet"),
  o(start + 29, "integration_active", "DomainGet"),
  o(start + 30, "integration_reload", "DomainReload"),
  o(start + 31, "integration_connect_key", "IntegrationKey"),
  o(start + 32, "integration_oauth_connect", "IntegrationConnect"),
  o(start + 33, "integration_oauth_status", "IntegrationAttempt"),
  o(start + 34, "integration_oauth_complete", "IntegrationAttempt"),
  o(start + 35, "integration_oauth_cancel", "IntegrationAttempt"),
  o(start + 36, "integration_command_connect", "IntegrationConnect"),
  o(start + 37, "integration_command_status", "IntegrationAttempt"),
  o(start + 38, "integration_command_cancel", "IntegrationAttempt"),
  o(start + 39, "integration_connection_resolve", "IntegrationResolve"),
]

// Mirrors protocol/ycoding/extension/v5/extension.proto; the plugin-host test fails on drift.
export const messages: Record<string, ReadonlyArray<Field>> = {
  Text: [o(1, "utf8", "string"), o(2, "utf16_le", "bytes")],
  Null: [],
  Value: [
    o(1, "null", "Null"),
    o(2, "boolean", "bool"),
    o(3, "number", "double"),
    o(4, "string", "Text"),
    o(5, "list", "List"),
    o(6, "object", "Object"),
  ],
  List: [m(1, "items", "Value")],
  Object: [m(1, "entries", "Entry")],
  Entry: [r(1, "key", "Text"), r(2, "value", "Value")],
  File: [r(1, "uri", "Text"), r(2, "mime", "Text"), o(3, "name", "Text")],
  Content: [o(1, "text", "Text"), o(2, "file", "File")],
  ToolScope: [
    r(1, "namespace", "string"),
    m(2, "tools", "string"),
    r(3, "action", "string"),
    m(4, "resources", "string"),
  ],
  FamilyScope: [m(1, "scopes", "string"), r(2, "action", "string"), m(3, "resources", "string")],
  Grant: [r(1, "family", "enum"), o(2, "scope", "ToolScope"), o(3, "family_scope", "FamilyScope")],
  Hello: [
    r(1, "revision", "uint32"),
    r(2, "identity", "string"),
    r(3, "generation", "string"),
    m(4, "grants", "Grant"),
    r(5, "registration_order", "uint32"),
    o(6, "plugin", "PluginLaunch"),
    o(7, "parent_plugin", "bool"),
  ],
  PluginLaunch: [
    r(1, "target", "Text"),
    r(2, "options", "Value"),
    r(3, "cache", "Text"),
    o(4, "model_package", "bool"),
  ],
  PluginDeclared: [r(1, "id", "Text")],
  PluginSetup: [],
  Ready: [r(1, "revision", "uint32"), r(2, "identity", "string"), r(3, "generation", "string")],
  Tool: [
    r(1, "namespace", "string"),
    r(2, "name", "string"),
    r(3, "description", "Text"),
    r(4, "input_schema", "Value"),
    r(5, "output_schema", "Value"),
    r(6, "direct", "bool"),
    r(7, "code_mode", "bool"),
    o(8, "permission", "string"),
    o(9, "implementation", "uint64"),
    o(10, "path", "Text"),
  ],
  TransformRegistration: [r(1, "id", "string"), r(2, "stage", "enum")],
  DomainRegistration: [r(1, "domain", "enum"), r(2, "key", "string"), r(3, "value", "Value")],
  Subscription: [r(1, "id", "uint64"), m(2, "families", "string")],
  OAuthRegistration: [
    r(1, "integration", "string"),
    r(2, "method", "Value"),
    r(3, "refresh", "bool"),
    r(4, "label", "bool"),
    o(5, "implementation", "uint64"),
  ],
  RegisterTools: [
    m(1, "tools", "Tool"),
    m(2, "transforms", "TransformRegistration"),
    m(3, "domains", "DomainRegistration"),
    m(4, "subscriptions", "Subscription"),
    m(5, "oauth", "OAuthRegistration"),
  ],
  Call: [
    r(1, "invocation", "uint64"),
    r(2, "session_id", "string"),
    r(3, "message_id", "string"),
    r(4, "call_id", "Text"),
    r(5, "agent", "string"),
  ],
  Execute: [call, r(2, "namespace", "string"), r(3, "tool", "string"), r(4, "input", "Value"), o(5, "implementation", "uint64")],
  Output: [r(1, "structured", "Value"), m(2, "content", "Content")],
  Failure: [r(1, "code", "enum"), o(2, "message", "Text")],
  Result: [call, o(2, "output", "Output"), o(3, "failure", "Failure")],
  Progress: [call, r(2, "output", "Output")],
  Cancel: [call],
  Cleanup: [call],
  Shutdown: [],
  Stopped: [],
  Diagnostic: [r(1, "code", "enum")],
  Transform: [
    call,
    r(2, "registration", "string"),
    r(3, "stage", "enum"),
    r(4, "revision", "uint64"),
    r(5, "draft", "Value"),
  ],
  Transformed: [
    call,
    r(2, "stage", "enum"),
    r(3, "revision", "uint64"),
    o(4, "draft", "Value"),
    o(5, "failure", "Failure"),
    m(6, "oauth", "OAuthRegistration"),
  ],
  EventDelivery: [
    r(1, "delivery", "uint64"),
    r(2, "subscription", "uint64"),
    r(3, "family", "string"),
    r(4, "envelope", "Value"),
  ],
  EventReceipt: [r(1, "delivery", "uint64")],
  Unsubscribe: [r(1, "subscription", "uint64")],
  McpServers: [],
  McpTools: [],
  McpReadResource: [r(1, "server", "string"), r(2, "uri", "string")],
  McpCallTool: [r(1, "server", "string"), r(2, "name", "string"), r(3, "args", "Value")],
  SessionGet: [r(1, "session", "string")],
  SessionPrompt: [r(1, "session", "string"), r(2, "message", "string"), r(3, "input", "Value"), o(4, "resume", "bool")],
  SessionInterrupt: [r(1, "session", "string")],
  SessionCreate: [
    o(1, "session", "string"),
    o(2, "parent", "string"),
    o(3, "agent", "Text"),
    o(4, "model", "Value"),
    o(5, "title", "Text"),
    o(6, "permission_ceiling", "Value"),
    o(7, "location", "Value"),
  ],
  SessionGenerate: [r(1, "session", "string"), r(2, "prompt", "Text")],
  SessionCommand: [
    r(1, "session", "string"),
    r(2, "message", "string"),
    r(3, "command", "Text"),
    r(4, "arguments", "Text"),
    r(5, "input", "Value"),
    o(6, "agent", "Text"),
    o(7, "model", "Value"),
    o(8, "resume", "bool"),
  ],
  SessionSynthetic: [
    r(1, "session", "string"),
    r(2, "message", "string"),
    r(3, "input", "Value"),
    o(4, "resume", "bool"),
  ],
  DomainList: [],
  AgentList: [o(1, "directory", "Text"), o(2, "workspace", "Text")],
  DomainGet: [r(1, "id", "string")],
  DomainReload: [],
  ModelGet: [r(1, "provider", "string"), r(2, "model", "string")],
  IntegrationKey: [r(1, "integration", "string"), r(2, "key", "Text"), o(3, "label", "Text")],
  IntegrationConnect: [r(1, "integration", "string"), r(2, "method", "string"), o(3, "inputs", "Value"), o(4, "label", "Text")],
  IntegrationAttempt: [r(1, "integration", "string"), r(2, "attempt", "string"), o(3, "code", "Text")],
  IntegrationResolve: [r(1, "connection", "Value")],
  HostCall: [call, r(2, "request", "uint64"), ...mcpOperations(3)],
  HostReply: [call, r(2, "request", "uint64"), o(3, "value", "Value"), o(4, "failure", "Failure")],
  PluginCall: [r(1, "request", "uint64"), ...mcpOperations(2)],
  PluginReply: [r(1, "request", "uint64"), o(2, "value", "Value"), o(3, "failure", "Failure")],
  AuthAuthorize: [r(1, "integration", "string"), r(2, "method", "string"), r(3, "inputs", "Value"), o(4, "implementation", "uint64")],
  AuthCallback: [r(1, "authorization", "uint64"), o(2, "code", "Text")],
  AuthSubmit: [r(1, "authorization", "uint64"), r(2, "code", "Text")],
  AuthRefresh: [r(1, "integration", "string"), r(2, "method", "string"), r(3, "credential", "Value"), o(4, "implementation", "uint64")],
  AuthLabel: [r(1, "integration", "string"), r(2, "method", "string"), r(3, "credential", "Value"), o(4, "implementation", "uint64")],
  RegistrationUpdate: [r(1, "request", "uint64"), o(2, "add", "RegisterTools"), m(3, "remove", "string")],
  RegistrationReply: [r(1, "request", "uint64"), o(2, "done", "Null"), o(3, "failure", "Failure")],
  Release: [m(1, "implementations", "uint64")],
  ParentEntry: [r(1, "id", "string"), r(2, "version", "uint64")],
  ParentManifest: [r(1, "pid", "uint32"), m(2, "plugins", "ParentEntry")],
  ParentOpen: [r(1, "generation", "string"), r(2, "id", "string"), r(3, "version", "uint64")],
  ParentData: [r(1, "generation", "string"), r(2, "payload", "bytes")],
  ParentClosed: [r(1, "generation", "string"), o(2, "failure", "Text")],
  ParentRetire: [],
  ParentShutdown: [],
  ParentFrame: [o(1, "manifest", "ParentManifest"), o(2, "open", "ParentOpen"), o(3, "data", "ParentData"), o(4, "closed", "ParentClosed"), o(5, "retire", "ParentRetire"), o(6, "shutdown", "ParentShutdown")],
  AuthAuthorization: [
    r(1, "url", "Text"),
    r(2, "instructions", "Text"),
    o(3, "expires_at", "double"),
    r(4, "mode", "enum"),
    r(5, "manual_code", "bool"),
  ],
  AuthRequest: [
    r(1, "request", "uint64"),
    o(2, "authorize", "AuthAuthorize"),
    o(3, "callback", "AuthCallback"),
    o(4, "submit", "AuthSubmit"),
    o(5, "refresh", "AuthRefresh"),
    o(6, "label", "AuthLabel"),
  ],
  AuthReply: [
    r(1, "request", "uint64"),
    o(2, "authorization", "AuthAuthorization"),
    o(3, "credential", "Value"),
    o(4, "label", "Text"),
    o(5, "done", "Null"),
    o(6, "failure", "Failure"),
  ],
  ProviderAttempt: [
    r(1, "package", "string"),
    r(2, "model", "string"),
    o(3, "options", "Value"),
    r(4, "body", "Value"),
  ],
  ProviderRequest: [r(1, "request", "uint64"), r(2, "attempt", "ProviderAttempt")],
  ProviderResult: [r(1, "request", "uint64"), o(2, "frames", "Value"), o(3, "failure", "Failure")],
  ProviderCancel: [r(1, "request", "uint64")],
  LanguageResolve: [
    r(1, "request", "uint64"),
    r(2, "package", "string"),
    r(3, "model", "Value"),
    r(4, "options", "Value"),
  ],
  LanguageResolved: [r(1, "request", "uint64"), r(2, "handled", "bool"), o(3, "failure", "Failure")],
  LanguageAttempt: [
    r(1, "request", "uint64"),
    r(2, "package", "string"),
    r(3, "model", "Value"),
    r(4, "options", "Value"),
    r(5, "body", "Value"),
  ],
  LanguageParts: [r(1, "request", "uint64"), m(2, "parts", "Value")],
  LanguageResult: [r(1, "request", "uint64"), o(2, "done", "Null"), o(3, "failure", "Failure")],
  LanguageCancel: [r(1, "request", "uint64")],
  LanguageCredit: [r(1, "request", "uint64")],
  HostFrame: [
    r(1, "generation", "string"),
    o(2, "hello", "Hello"),
    o(3, "execute", "Execute"),
    o(4, "cancel", "Cancel"),
    o(5, "shutdown", "Shutdown"),
    o(6, "transform", "Transform"),
    o(7, "event", "EventDelivery"),
    o(8, "host_reply", "HostReply"),
    o(9, "auth", "AuthRequest"),
    o(10, "provider", "ProviderRequest"),
    o(11, "provider_cancel", "ProviderCancel"),
    o(12, "plugin_reply", "PluginReply"),
    o(13, "language_resolve", "LanguageResolve"),
    o(14, "language_attempt", "LanguageAttempt"),
    o(15, "language_cancel", "LanguageCancel"),
    o(16, "language_credit", "LanguageCredit"),
    o(17, "setup", "PluginSetup"),
    o(18, "registration_reply", "RegistrationReply"),
    o(19, "release", "Release"),
  ],
  ChildFrame: [
    r(1, "generation", "string"),
    o(2, "ready", "Ready"),
    o(3, "register_tools", "RegisterTools"),
    o(4, "result", "Result"),
    o(5, "progress", "Progress"),
    o(6, "cleanup", "Cleanup"),
    o(7, "stopped", "Stopped"),
    o(8, "diagnostic", "Diagnostic"),
    o(9, "transformed", "Transformed"),
    o(10, "subscribe", "Subscription"),
    o(11, "unsubscribe", "Unsubscribe"),
    o(12, "event_receipt", "EventReceipt"),
    o(13, "host_call", "HostCall"),
    o(14, "auth_reply", "AuthReply"),
    o(15, "provider_result", "ProviderResult"),
    o(16, "plugin_call", "PluginCall"),
    o(17, "language_resolved", "LanguageResolved"),
    o(18, "language_parts", "LanguageParts"),
    o(19, "language_result", "LanguageResult"),
    o(20, "declared", "PluginDeclared"),
    o(21, "registration_update", "RegistrationUpdate"),
  ],
}

export const FRAME_BYTES = 1_048_576
export type Message = Record<string, unknown>
export type Text = { utf8?: string; utf16_le?: Uint8Array }
export type Value = Message

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

export function encode(name: string, value: Message): Uint8Array {
  const parts: number[] = []
  write(parts, name, value)
  return Uint8Array.from(parts)
}

function write(parts: number[], name: string, value: Message) {
  const fields = messages[name]
  if (!fields) throw new Error(`Unknown channel message ${name}`)
  for (const field of fields) {
    const item = value[field.name]
    if (item === undefined || item === null) {
      if (field.label === "required") throw new Error(`Missing required ${name}.${field.name}`)
      continue
    }
    const items = field.label === "repeated" ? (item as unknown[]) : [item]
    for (const entry of items) writeField(parts, field, entry)
  }
}

function writeField(parts: number[], field: Field, value: unknown) {
  if (field.type === "double") {
    varint(parts, BigInt((field.tag << 3) | 1))
    const bytes = new Uint8Array(8)
    new DataView(bytes.buffer).setFloat64(0, value as number, true)
    parts.push(...bytes)
    return
  }
  if (field.type === "bool" || field.type === "uint32" || field.type === "uint64" || field.type === "enum") {
    varint(parts, BigInt(field.tag << 3))
    varint(parts, BigInt(field.type === "bool" ? (value ? 1 : 0) : (value as number)))
    return
  }
  const bytes =
    field.type === "string"
      ? encoder.encode(value as string)
      : field.type === "bytes"
        ? (value as Uint8Array)
        : encode(field.type, value as Message)
  varint(parts, BigInt((field.tag << 3) | 2))
  varint(parts, BigInt(bytes.length))
  for (const byte of bytes) parts.push(byte)
}

function varint(parts: number[], value: bigint) {
  let rest = value
  while (rest > 127n) {
    parts.push(Number(rest & 127n) | 128)
    rest >>= 7n
  }
  parts.push(Number(rest))
}

export function decode(name: string, bytes: Uint8Array): Message {
  const fields = messages[name]
  if (!fields) throw new Error(`Unknown channel message ${name}`)
  const result: Message = {}
  for (const field of fields) if (field.label === "repeated") result[field.name] = []
  let offset = 0
  const read = () => {
    let value = 0n
    let shift = 0n
    for (;;) {
      const byte = bytes[offset++]
      if (byte === undefined) throw new Error("Truncated channel varint")
      value |= BigInt(byte & 127) << shift
      if (byte < 128) return value
      shift += 7n
    }
  }
  while (offset < bytes.length) {
    const key = read()
    const tag = Number(key >> 3n)
    const wire = Number(key & 7n)
    const field = fields.find((item) => item.tag === tag)
    const value = (() => {
      if (wire === 0) return read()
      if (wire === 1) {
        const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8)
        offset += 8
        return view.getFloat64(0, true)
      }
      if (wire !== 2) throw new Error("Unsupported channel wire type")
      const length = Number(read())
      const slice = bytes.subarray(offset, offset + length)
      offset += length
      return slice
    })()
    if (!field) continue
    const parsed =
      field.type === "string"
        ? decoder.decode(value as Uint8Array)
        : field.type === "bytes"
          ? Uint8Array.from(value as Uint8Array)
          : field.type === "bool"
            ? value === 1n
            : field.type === "uint32" || field.type === "uint64" || field.type === "enum"
              ? Number(value as bigint)
              : field.type === "double"
                ? value
                : decode(field.type, value as Uint8Array)
    if (field.label === "repeated") (result[field.name] as unknown[]).push(parsed)
    else result[field.name] = parsed
  }
  return result
}

export function text(value: string): Text {
  if (value.isWellFormed()) return { utf8: value }
  const bytes = new Uint8Array(value.length * 2)
  const view = new DataView(bytes.buffer)
  for (let index = 0; index < value.length; index++) view.setUint16(index * 2, value.charCodeAt(index), true)
  return { utf16_le: bytes }
}

export function readText(value: unknown): string {
  const item = value as Text
  if (typeof item.utf8 === "string") return item.utf8
  const bytes = item.utf16_le ?? new Uint8Array(0)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return Array.from({ length: bytes.length / 2 }, (_, index) =>
    String.fromCharCode(view.getUint16(index * 2, true)),
  ).join("")
}

export function value(input: unknown): Value {
  if (input === null || input === undefined) return { null: {} }
  if (typeof input === "boolean") return { boolean: input }
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new Error("Channel numbers must be finite")
    return { number: input }
  }
  if (typeof input === "string") return { string: text(input) }
  if (typeof input === "bigint") return { number: Number(input) }
  if (Array.isArray(input)) return { list: { items: input.map(value) } }
  if (input instanceof Date) return { number: input.getTime() }
  if (input instanceof Error) return value({ ...input, name: input.name, message: input.message })
  if (input instanceof Uint8Array) return { string: text(Buffer.from(input).toString("base64")) }
  if (typeof input === "object") {
    const json = "toJSON" in input && typeof input.toJSON === "function" ? input.toJSON() : input
    if (json !== input) return value(json)
    return {
      object: {
        entries: Object.entries(input)
          .filter((entry) => entry[1] !== undefined && typeof entry[1] !== "function")
          .map(([key, item]) => ({ key: text(key), value: value(item) })),
      },
    }
  }
  throw new Error(`Unsupported channel value ${typeof input}`)
}

export function readValue(input: unknown): unknown {
  const item = input as Record<string, any>
  if ("null" in item) return null
  if ("boolean" in item) return item.boolean
  if ("number" in item) return item.number
  if ("string" in item) return readText(item.string)
  if ("list" in item) return (item.list.items as unknown[]).map(readValue)
  if ("object" in item)
    return Object.fromEntries(
      (item.object.entries as any[]).map((entry) => [readText(entry.key), readValue(entry.value)]),
    )
  throw new Error("Invalid channel value")
}
