import { Schema } from "../../../../packages/schema/node_modules/effect/dist/index.js"
import {
  AbsolutePath,
  RelativePath,
  PositiveInt,
  NonNegativeInt,
  DateTimeUtcFromMillis,
  optional,
} from "../../../../packages/schema/src/schema.ts"
import { USD, USDPerMillionTokens } from "../../../../packages/schema/src/money.ts"
import { Event } from "../../../../packages/schema/src/event.ts"
import { Location } from "../../../../packages/schema/src/location.ts"
import { TokenUsage } from "../../../../packages/schema/src/token-usage.ts"
import { SessionID } from "../../../../packages/schema/src/session-id.ts"
import { ProjectID } from "../../../../packages/schema/src/project-id.ts"
import { WorkspaceID } from "../../../../packages/schema/src/workspace-id.ts"
import { ID } from "../../../../packages/schema/src/session-message-id.ts"
import { IntegrationID, IntegrationMethodID } from "../../../../packages/schema/src/integration-id.ts"
import { Snapshot } from "../../../../packages/schema/src/snapshot.ts"
import { SourceEpoch } from "../../../../packages/schema/src/source-epoch.ts"
import { create } from "../../../../packages/schema/src/identifier.ts"
import { Provider } from "../../../../packages/schema/src/provider.ts"
import { ModelsDev } from "../../../../packages/schema/src/models-dev.ts"
import { Catalog } from "../../../../packages/schema/src/catalog.ts"
import { Integration } from "../../../../packages/schema/src/integration.ts"
import { Connection } from "../../../../packages/schema/src/connection.ts"
import { Credential } from "../../../../packages/schema/src/credential.ts"
import { ProviderUsage } from "../../../../packages/schema/src/provider-usage.ts"
import { Config } from "../../../../packages/schema/src/config.ts"
import { LLM } from "../../../../packages/schema/src/llm.ts"
import { Prompt, Base64, AttachmentDigest, PromptMention, ManagedAttachmentContent, FileAttachment, AgentAttachment } from "../../../../packages/schema/src/prompt.ts"
import { PromptInput } from "../../../../packages/schema/src/prompt-input.ts"
import { Model } from "../../../../packages/schema/src/model.ts"
import { Permission } from "../../../../packages/schema/src/permission.ts"
import { PermissionSaved } from "../../../../packages/schema/src/permission-saved.ts"
import { Agent } from "../../../../packages/schema/src/agent.ts"
import { Command } from "../../../../packages/schema/src/command.ts"
import { ProviderRequest } from "../../../../packages/schema/src/provider-request.ts"
import { SessionCacheDiagnostics } from "../../../../packages/schema/src/session-cache-diagnostics.ts"

import { SessionDelivery } from "../../../../packages/schema/src/session-delivery.ts"
import { SessionError } from "../../../../packages/schema/src/session-error.ts"
import { Remote } from "../../../../packages/schema/src/remote.ts"
import { KeepAwake } from "../../../../packages/schema/src/keep-awake.ts"
import { FileDiff } from "../../../../packages/schema/src/file-diff.ts"
import { Vcs } from "../../../../packages/schema/src/vcs.ts"
import { Instruction } from "../../../../packages/schema/src/instruction.ts"
import { InstructionEntry } from "../../../../packages/schema/src/instruction-entry.ts"
import { EventLog } from "../../../../packages/schema/src/event-log.ts"
import { Workspace } from "../../../../packages/schema/src/workspace.ts"
import { WorkspaceEvent } from "../../../../packages/schema/src/workspace-event.ts"
import { WorktreeEvent } from "../../../../packages/schema/src/worktree-event.ts"
import { ServerEvent } from "../../../../packages/schema/src/server-event.ts"
import { LspEvent } from "../../../../packages/schema/src/lsp-event.ts"
import { InstallationEvent } from "../../../../packages/schema/src/installation-event.ts"
import { VcsEvent } from "../../../../packages/schema/src/vcs-event.ts"
import { SessionTodo } from "../../../../packages/schema/src/session-todo.ts"
import { SessionStatusEvent } from "../../../../packages/schema/src/session-status-event.ts"
import { SessionCompactionEvent } from "../../../../packages/schema/src/session-compaction-event.ts"
import { TuiEvent } from "../../../../packages/schema/src/tui-event.ts"

import { Skill } from "../../../../packages/schema/src/skill.ts"
import { Reference } from "../../../../packages/schema/src/reference.ts"
import { Plugin } from "../../../../packages/schema/src/plugin.ts"
import { Project } from "../../../../packages/schema/src/project.ts"
import { ProjectDirectories } from "../../../../packages/schema/src/project-directories.ts"
import { ProjectCopy } from "../../../../packages/schema/src/project-copy.ts"
import { SessionCompaction } from "../../../../packages/schema/src/session-compaction.ts"
import { SessionCapturedChanges } from "../../../../packages/schema/src/session-captured-changes.ts"
import { Telemetry } from "../../../../packages/schema/src/telemetry.ts"
import { FileSystem } from "../../../../packages/schema/src/filesystem.ts"

import { Form } from "../../../../packages/schema/src/form.ts"
import { Question } from "../../../../packages/schema/src/question.ts"
import { Guardrail } from "../../../../packages/schema/src/guardrail.ts"
import { Shell } from "../../../../packages/schema/src/shell.ts"
import { Pty } from "../../../../packages/schema/src/pty.ts"
import { PtyTicket } from "../../../../packages/schema/src/pty-ticket.ts"

import { Mcp } from "../../../../packages/schema/src/mcp.ts"
import { McpSkill } from "../../../../packages/schema/src/mcp-skill.ts"
import { McpEvent } from "../../../../packages/schema/src/mcp-event.ts"
import { Browser } from "../../../../packages/schema/src/browser.ts"
import { IsolatedBrowser } from "../../../../packages/schema/src/isolated-browser.ts"
import { SessionMessage } from "../../../../packages/schema/src/session-message.ts"
import { Revert as SessionRevertSchema } from "../../../../packages/schema/src/session-revert.ts"
import { SessionPending } from "../../../../packages/schema/src/session-pending.ts"
import { SessionOrchestration } from "../../../../packages/schema/src/session-orchestration.ts"
import { SessionSkillStatus } from "../../../../packages/schema/src/session-skill-status.ts"
import { SessionWorkCompletion } from "../../../../packages/schema/src/session-work-completion.ts"
import { SessionEvent } from "../../../../packages/schema/src/session-event.ts"
import { DurableEventManifest } from "../../../../packages/schema/src/durable-event-manifest.ts"
import { Session } from "../../../../packages/schema/src/session.ts"
import { ProjectArtifact } from "../../../../packages/schema/src/project-artifact.ts"
import { EventManifest } from "../../../../packages/schema/src/event-manifest.ts"

export type Corpus = { name: string; schema: Schema.Codec<unknown, unknown>; samples: readonly string[] }
function negativeZeros(value: unknown, path = "$", result: string[] = []) {
  if (Object.is(value, -0)) result.push(path)
  if (Array.isArray(value)) value.forEach((item, index) => negativeZeros(item, `${path}[${index}]`, result))
  if (value !== null && typeof value === "object" && !Array.isArray(value))
    Object.entries(value).forEach(([key, item]) => negativeZeros(item, `${path}[${JSON.stringify(key)}]`, result))
  return result
}
export function goldens(corpus: readonly Corpus[]) {
  const seen = new Set<string>()
  return corpus.flatMap(({ name, schema, samples }) =>
    samples.filter((input) => {
      const key = `${name}\0${input}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).map((input) => {
      const decoded = (() => {
        try {
          return { value: Schema.decodeUnknownSync(schema)(JSON.parse(input)) }
        } catch {
          return null
        }
      })()
      if (decoded === null) return { name, input, output: null, negativeZeros: [] }
      const encoded = Schema.encodeSync(schema)(decoded.value)
      const output = JSON.stringify(encoded)
      if (output === undefined) throw new Error(`Non-JSON golden: ${name}`)
      return { name, input, output, negativeZeros: negativeZeros(encoded) }
    }),
  )
}

const strings = [
  '""',
  '"global"',
  '"ses"',
  '"ses_wrong-shape"',
  '"wrk"',
  '"wrk-no-underscore"',
  '"msg_"',
  '"evt_"',
  '"\\ud800"',
  '"😀"',
  "null",
  "1",
  "{}",
]
const numbers = [
  "-1",
  "-0",
  "0",
  "1",
  "1.25",
  "-1.25",
  "9007199254740991",
  "9007199254740992",
  "1e400",
  "-1e400",
  "null",
  '"1"',
  "true",
]
const durable = Event.durable({
  type: "fixture.changed",
  durable: { version: 2, aggregate: "fixture" },
  schema: { text: Schema.String, clear: optional(Schema.NullOr(Schema.String)) },
})
const ephemeral = Event.ephemeral({ type: "fixture.ping", schema: { text: Schema.String } })
const envelope = {
  data: { clear: null, text: "\ud800", ignored: true },
  location: { workspaceID: "wrk", directory: "" },
  durable: { version: 2, seq: 0, aggregateID: "\udc00" },
  type: "fixture.changed",
  created: 1.9,
  id: "evt_",
  sourceEpoch: "epoch",
  metadata: { b: 1, "2": false, a: null, "\ud800": ["\udc00"] },
  ignored: true,
}
const samples = (values: readonly unknown[]) => values.map((value) => JSON.stringify(value))
const providerRequestTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const providerRequestModel = { id: "model", providerID: "openai" }
const providerRequestRecord = {
  id: "prq_1",
  sessionID: "ses_1",
  inputID: "msg_1",
  assistantMessageID: "msg_2",
  source: "step",
  agent: "agent",
  model: providerRequestModel,
  routeID: "route",
  promptCacheKey: "key",
  systemDigest: "system",
  toolDigest: "tools",
  request: 1,
  attempts: 1,
  invalidation: "first-request",
  continuation: "full",
  tokens: providerRequestTokens,
  time: 0,
}
const paDigest = "a".repeat(64)
const paScope = { type: "global", id: "pas_a", storageID: "00000000-0000-0000-0000-000000000000" }
const paIdentity = { scopeID: "pas_a", kind: "skill", id: "safe", versionID: "pav_a" }
const paProvenance = { source: "user" }
const paVersion = { id: "pav_a", state: "trial", contentDigest: paDigest, contentRelpath: "content/a", provenance: paProvenance, timeCreated: 0, timeStateChanged: 0 }
const paArtifact = { scope: paScope, kind: "skill", id: "safe", revision: 0, stage: "trial", currentVersionID: "pav_a", timeCreated: 0, timeUpdated: 0 }
const paSummary = { scope: paScope, kind: "skill", id: "safe", name: "Name", description: "Description", stage: "trial", revision: 0, currentVersionID: "pav_a", currentDigest: paDigest, timeUpdated: 0 }
const paDefinition = { kind: "skill", name: "Name", description: "Description", content: "content" }
const paMetrics = { score: 0, confidence: { sampleCount: 0, successCount: 0, lowerBound: 0, upperBound: 1, eligible: false }, rewardUnits: 0, penaltyUnits: 0 }
const paExpectation = { expectedRevision: 0, expectedVersionID: "pav_a", expectedDigest: paDigest }
type ASTRecord = Record<string, unknown>
function schemaCandidate(astValue: unknown, depth = 0): unknown {
  if (depth > 24 || typeof astValue !== "object" || astValue === null) return null
  const ast = astValue as ASTRecord
  const valid = (value: unknown) => {
    try {
      Schema.decodeUnknownSync(Schema.make(ast as Parameters<typeof Schema.make>[0]))(value)
      return true
    } catch {
      return false
    }
  }
  const fallback = (values: unknown[]) => values.find(valid)
  switch (ast._tag) {
    case "String": {
      const checks = Array.isArray(ast.checks) ? ast.checks as ASTRecord[] : []
      const prefix = checks.map((check) => ((check.annotations as ASTRecord | undefined)?.meta as ASTRecord | undefined)?.startsWith).find((value) => typeof value === "string")
      return fallback([...(typeof prefix === "string" ? [`${prefix}x`, prefix] : []), "a", "", "global", "pas_a", "pav_a", "ses_1", "msg_1", "evt_1", "openai", "skill", "command", "manual", "#000000"])
    }
    case "Number":
      return fallback([0, 1, -1, 0.5, 2, 100, 9007199254740991])
    case "Boolean":
      return fallback([false, true])
    case "Literal":
      return ast.literal
    case "Union": {
      const types = Array.isArray(ast.types) ? ast.types as ASTRecord[] : []
      return fallback(types.map((type) => schemaCandidate(type, depth + 1)).filter((value) => value !== undefined))
    }
    case "Objects": {
      const properties = Array.isArray(ast.propertySignatures) ? ast.propertySignatures as { name: string; type: ASTRecord }[] : []
      const value = Object.fromEntries(properties.filter((field) => !((field.type.context as ASTRecord | undefined)?.isOptional)).map((field) => [field.name, schemaCandidate(field.type, depth + 1)]))
      return valid(value) ? value : fallback([value, {}])
    }
    case "Arrays": {
      const elements = Array.isArray(ast.elements) ? ast.elements as ASTRecord[] : []
      const rest = Array.isArray(ast.rest) ? ast.rest as ASTRecord[] : []
      const parts = [...elements, ...rest]
      const value = parts.map((part) => schemaCandidate((part.type as unknown) ?? part, depth + 1))
      return fallback([[], value.slice(0, Math.max(elements.length, 1))])
    }
    case "Declaration":
    case "Unknown":
      return fallback([null, {}, [], "", 0, false])
    case "Undefined":
      return undefined
    default:
      return null
  }
}
function literalStrings(astValue: unknown): string[] {
  if (typeof astValue !== "object" || astValue === null) return []
  const ast = astValue as ASTRecord
  if (ast._tag === "Literal" && typeof ast.literal === "string") return [ast.literal]
  if (ast._tag === "Union" && Array.isArray(ast.types)) return (ast.types as ASTRecord[]).flatMap(literalStrings)
  return []
}
function topLevelInvalidLiteralVariants(schema: Schema.Codec<unknown, unknown>, value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value) || schema.ast._tag !== "Objects") return []
  const base = value as Record<string, unknown>
  return schema.ast.propertySignatures.flatMap((field) => literalStrings(field.type).length === 0 ? [] : (() => {
    const candidate = { ...base, [field.name]: "__invalid__" }
    try {
      Schema.decodeUnknownSync(schema)(candidate)
      return []
    } catch {
      return [JSON.stringify(candidate)]
    }
  })())
}
function topLevelNullVariants(schema: Schema.Codec<unknown, unknown>, value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value) || schema.ast._tag !== "Objects") return []
  const base = value as Record<string, unknown>
  return schema.ast.propertySignatures.flatMap((field) => {
    if (!field.type.context?.isOptional) return []
    const candidate = { ...base, [field.name]: null }
    try {
      Schema.decodeUnknownSync(schema)(candidate)
      return [JSON.stringify(candidate)]
    } catch {
      return []
    }
  })
}
function topLevelNumberBoundaryVariants(schema: Schema.Codec<unknown, unknown>, value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value) || schema.ast._tag !== "Objects") return []
  const base = value as Record<string, unknown>
  return schema.ast.propertySignatures.flatMap((field) => {
    if (field.type._tag !== "Number" && !(field.type._tag === "Union" && field.type.types.some((member) => member._tag === "Number"))) return []
    return [-2, -1, 0, 1, 2, 9007199254740991, 9007199254740992].map((number) => JSON.stringify({ ...base, [field.name]: number }))
  })
}
function topLevelArrayBoundaryVariants(schema: Schema.Codec<unknown, unknown>, value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value) || schema.ast._tag !== "Objects") return []
  const base = value as Record<string, unknown>
  return schema.ast.propertySignatures.flatMap((field) => {
    if (field.type._tag !== "Arrays") return []
    const current = base[field.name]
    const item = Array.isArray(current) ? current[0] : undefined
    return [[], ...(item === undefined ? [] : [[item, item]])].map((items) => JSON.stringify({ ...base, [field.name]: items }))
  })
}
function topLevelLiteralVariants(schema: Schema.Codec<unknown, unknown>, value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value) || schema.ast._tag !== "Objects") return []
  const base = value as Record<string, unknown>
  return schema.ast.propertySignatures.flatMap((field) => literalStrings(field.type).flatMap((literal) => {
    const candidate = { ...base, [field.name]: literal }
    try {
      Schema.decodeUnknownSync(schema)(candidate)
      return [JSON.stringify(candidate)]
    } catch {
      return []
    }
  }))
}
const sessionEventDataCases = SessionEvent.Definitions.map((definition) => {
  const value = schemaCandidate(definition.data.ast)
  const invalid = { ...(value as Record<string, unknown>) }
  const withUnknown = { ...(value as Record<string, unknown>), unknownField: true }
  const required = definition.data.ast.propertySignatures.find((field) => !field.type.context?.isOptional)
  if (required) delete invalid[required.name]
  return { name: `SessionEvent.${definition.type}`, schema: definition.data, samples: [JSON.stringify(value), ...topLevelLiteralVariants(definition.data, value), ...topLevelInvalidLiteralVariants(definition.data, value), ...topLevelNullVariants(definition.data, value), ...topLevelNumberBoundaryVariants(definition.data, value), ...topLevelArrayBoundaryVariants(definition.data, value), JSON.stringify(invalid), JSON.stringify(withUnknown), "{}"] }
})
const sessionEventPrivateSchemas = [
  ["SessionEvent.session.usage.recorded", SessionEvent.UsageRecorded],
  ["SessionEvent.session.provider.request.recorded", SessionEvent.ProviderRequestRecorded],
  ["SessionEvent.session.profile.bound", SessionEvent.ProfileBound],
  ["SessionEvent.session.guardrail.approved", SessionEvent.GuardrailApproved],
] as const
const sessionEventPrivateDataCases = sessionEventPrivateSchemas.map(([name, definition]) => {
  const value = schemaCandidate(definition.data.ast)
  const invalid = { ...(value as Record<string, unknown>) }
  const withUnknown = { ...(value as Record<string, unknown>), unknownField: true }
  const required = definition.data.ast.propertySignatures.find((field) => !field.type.context?.isOptional)
  if (required) delete invalid[required.name]
  return { name, schema: definition.data, samples: [JSON.stringify(value), ...topLevelLiteralVariants(definition.data, value), ...topLevelInvalidLiteralVariants(definition.data, value), ...topLevelNullVariants(definition.data, value), ...topLevelNumberBoundaryVariants(definition.data, value), ...topLevelArrayBoundaryVariants(definition.data, value), JSON.stringify(invalid), JSON.stringify(withUnknown), "{}"] }
})
function sessionEventPayload(definition: { readonly type: string; readonly data: Schema.Codec<unknown, unknown>; readonly durable?: { readonly version: number; readonly aggregate: string } }) {
  const payload = {
    id: "evt_1",
    created: 0,
    type: definition.type,
    durable: definition.durable ? { aggregateID: "ses_1", seq: 0, version: definition.durable.version } : undefined,
    data: schemaCandidate(definition.data.ast),
  }
  try {
    Schema.decodeUnknownSync(definition)(payload)
    return JSON.stringify(payload)
  } catch {
    return undefined
  }
}
const sessionEventAllDefinitions = [...SessionEvent.Definitions, SessionEvent.UsageRecorded, SessionEvent.ProviderRequestRecorded, SessionEvent.ProfileBound, SessionEvent.GuardrailApproved]
const sessionEventPayloadSamples = sessionEventAllDefinitions.map(sessionEventPayload).filter((value): value is string => value !== undefined)
const sessionDurablePayloadSamples = SessionEvent.DurableDefinitions.map(sessionEventPayload).filter((value): value is string => value !== undefined)
const sessionPublicDurablePayloadSamples = SessionEvent.PublicDurableDefinitions.map(sessionEventPayload).filter((value): value is string => value !== undefined)
export const corpus: Corpus[] = [
  { name: "SessionEvent.All", schema: SessionEvent.All, samples: [...sessionEventPayloadSamples, JSON.stringify({ id: "evt_1", created: 0, type: "session.created", durable: { aggregateID: "ses_1", seq: 0, version: 2 }, metadata: null, data: { sessionID: "ses_1", projectID: "global", location: { directory: "" }, title: "", created: 0 } }), JSON.stringify({ id: "evt_1", created: 0, type: "session.created", durable: { aggregateID: "ses_1", seq: 0, version: 2 }, sourceEpoch: null, data: { sessionID: "ses_1", projectID: "global", location: { directory: "" }, title: "", created: 0 } }), JSON.stringify({ id: "evt_1", created: 0, type: "session.created", durable: { aggregateID: "ses_1", seq: 0, version: 2 }, data: { sessionID: "ses_1", projectID: "global", location: null, title: "", created: 0 } }), "{}", JSON.stringify({ id: "evt_1", created: 0, type: "session.unknown", data: {} })] },
  { name: "SessionEvent.Durable", schema: SessionEvent.Durable, samples: [...sessionDurablePayloadSamples, "{}"] },
  { name: "SessionEvent.PublicDurable", schema: SessionEvent.PublicDurable, samples: [...sessionPublicDurablePayloadSamples, "{}"] },
  { name: "SessionEvent.ProfileBinding", schema: SessionEvent.ProfileBinding, samples: ["{\"providerID\":\"openai\",\"integrationID\":\"int_1\",\"profile\":\"default\",\"credentialID\":\"cred_1\",\"accountGeneration\":0}", "{}"] },
  { name: "SessionEvent.Source", schema: SessionEvent.Source, samples: ["{\"start\":0,\"end\":0,\"text\":\"\"}", "{\"start\":-1,\"end\":0,\"text\":\"\"}"] },
  { name: "SessionEvent.ArtifactProvenance", schema: SessionEvent.ArtifactProvenance, samples: ["{\"scopeID\":\"pas_a\",\"versionID\":\"pav_a\",\"kind\":\"skill\",\"id\":\"safe\",\"sourceScope\":\"global\"}", "{}"] },
  { name: "SessionEvent.All", schema: SessionEvent.All, samples: ['{"id":"evt_1","created":0,"type":"session.created","durable":{"aggregateID":"ses_1","seq":0,"version":2},"data":{"sessionID":"ses_1","projectID":"global","location":{"directory":""},"title":"","created":0}}', '{"id":"evt_1","created":0,"type":"session.created","durable":{"aggregateID":"ses_1","seq":0,"version":1},"data":{"sessionID":"ses_1","projectID":"global","location":{"directory":""},"title":"","created":0}}', "{}"] },
  { name: "Session.CacheMechanism", schema: Session.CacheMechanism, samples: ['"none"', '"openai-prefix-cache"', '"invalid"'] },
  { name: "Session.ProviderCacheDiagnostics", schema: Session.ProviderCacheDiagnostics, samples: ["{\"mechanism\":\"none\",\"readReported\":false,\"writeReported\":false}", "{\"mechanism\":\"bad\",\"readReported\":false,\"writeReported\":false}"] },
  { name: "Session.ID", schema: Session.ID, samples: ['"ses"', '"ses_1"', '"x"', '"\\ud800"'] },
  { name: "Session.Info", schema: Session.Info, samples: [JSON.stringify({ id: "ses_1", projectID: "global", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 0, updated: 0 }, title: "", location: { directory: "" } }), JSON.stringify({ id: "ses_1", projectID: "global", cost: -1, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 0, updated: 0 }, title: "", location: { directory: "" } }), JSON.stringify({ id: "ses_1", parentID: null, projectID: "global", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 0, updated: 0 }, title: "", location: { directory: "" } })] },
  { name: "Session.ListAnchor", schema: Session.ListAnchor, samples: ['{"id":"ses_1","time":0,"direction":"previous"}', '{"id":"ses_1","time":1,"direction":"next"}', '{"id":"ses_1","time":0,"direction":"other"}', '{"id":"ses_1","time":1e400,"direction":"next"}'] },
  { name: "Session.ModelSwitchBlocked", schema: Session.ModelSwitchBlocked, samples: ['{"status":"blocked","currentModel":{"id":"m","providerID":"p"},"targetModel":{"id":"n","providerID":"p"},"currentContextTokens":0,"targetSafeInputTokens":0,"requiredReductionTokens":0,"reason":"context-window-exceeded"}', '{"status":"blocked","currentModel":{"id":"m","providerID":"p"},"targetModel":{"id":"n","providerID":"p"},"currentContextTokens":-1,"targetSafeInputTokens":0,"requiredReductionTokens":0,"reason":"context-window-exceeded"}'] },
  { name: "ProjectArtifact.ProjectScope", schema: ProjectArtifact.ProjectScope, samples: ['{"type":"project","id":"pas_a","projectID":"global","storageID":"00000000-0000-0000-0000-000000000000"}', '{"type":"project","id":"bad","projectID":"global","storageID":"00000000-0000-0000-0000-000000000000"}'] },
  { name: "ProjectArtifact.GlobalScope", schema: ProjectArtifact.GlobalScope, samples: ['{"type":"global","id":"pas_a","storageID":"00000000-0000-0000-0000-000000000000"}', '{"type":"project","id":"pas_a","storageID":"00000000-0000-0000-0000-000000000000"}'] },
  { name: "ProjectArtifact.Scope", schema: ProjectArtifact.Scope, samples: ['{"type":"project","id":"pas_a","projectID":"global","storageID":"00000000-0000-0000-0000-000000000000"}', '{"type":"global","id":"pas_a","storageID":"00000000-0000-0000-0000-000000000000"}', '{"type":"other","id":"pas_a"}'] },
  { name: "ProjectArtifact.ProjectScopeSelector", schema: ProjectArtifact.ProjectScopeSelector, samples: ['{"type":"project"}', '{"type":"global"}'] },
  { name: "ProjectArtifact.GlobalScopeSelector", schema: ProjectArtifact.GlobalScopeSelector, samples: ['{"type":"global"}', '{"type":"project"}'] },
  { name: "ProjectArtifact.ScopeSelector", schema: ProjectArtifact.ScopeSelector, samples: ['{"type":"project"}', '{"type":"global"}', '{"type":"other"}'] },
  { name: "ProjectArtifact.SkillDefinition", schema: ProjectArtifact.SkillDefinition, samples: ['{"kind":"skill","name":"n","description":"d","content":"c"}', '{"kind":"skill","name":"n","description":"d","content":1}'] },
  { name: "ProjectArtifact.CommandDefinition", schema: ProjectArtifact.CommandDefinition, samples: ['{"kind":"command","name":"n","description":"d","template":"t","subtask":false}', '{"kind":"command","name":"n","description":"d","template":"t","subtask":true}'] },
  { name: "ProjectArtifact.AgentDefinition", schema: ProjectArtifact.AgentDefinition, samples: ['{"kind":"agent","name":"n","description":"d","system":"s","mode":"subagent","permissions":[]}', '{"kind":"agent","name":"n","description":"d","system":"s","mode":"primary","permissions":[]}'] },
  { name: "ProjectArtifact.PluginDefinition", schema: ProjectArtifact.PluginDefinition, samples: ['{"kind":"plugin","name":"n","description":"d","draft":"x"}', '{"kind":"plugin","name":"n","description":"d","draft":1}'] },
  { name: "ProjectArtifact.Definition", schema: ProjectArtifact.Definition, samples: ['{"kind":"skill","name":"n","description":"d","content":"c"}', '{"kind":"command","name":"n","description":"d","template":"t","subtask":false}', '{"kind":"agent","name":"n","description":"d","system":"s","mode":"subagent","permissions":[]}', '{"kind":"plugin","name":"n","description":"d","draft":"x"}', '{"kind":"invalid"}'] },
  { name: "ProjectArtifact.ArtifactKey", schema: ProjectArtifact.ArtifactKey, samples: ['{"scope":{"type":"global"},"kind":"skill","id":"safe"}', '{"scope":{"type":"other"},"kind":"skill","id":"safe"}'] },
  { name: "ProjectArtifact.ProjectArtifactKey", schema: ProjectArtifact.ProjectArtifactKey, samples: ['{"scope":{"type":"project"},"kind":"skill","id":"safe"}', '{"scope":{"type":"global"},"kind":"skill","id":"safe"}'] },
  { name: "ProjectArtifact.ArtifactIdentity", schema: ProjectArtifact.ArtifactIdentity, samples: ['{"scopeID":"pas_a","kind":"skill","id":"safe"}', '{"scopeID":"pas_","kind":"skill","id":"safe"}'] },
  { name: "ProjectArtifact.ArtifactVersionIdentity", schema: ProjectArtifact.ArtifactVersionIdentity, samples: ['{"scopeID":"pas_a","kind":"skill","id":"safe","versionID":"pav_a"}', '{"scopeID":"pas_a","kind":"skill","id":"safe","versionID":"pav_"}'] },
  { name: "ProjectArtifact.Confidence", schema: ProjectArtifact.Confidence, samples: ['{"sampleCount":0,"successCount":0,"lowerBound":0,"upperBound":1,"eligible":false}', '{"sampleCount":0,"successCount":1,"lowerBound":0,"upperBound":1,"eligible":false}', '{"sampleCount":1,"successCount":0,"lowerBound":0,"upperBound":0,"eligible":true}', '{"sampleCount":1,"successCount":0,"lowerBound":1,"upperBound":1,"eligible":true}', '{"sampleCount":1,"successCount":0,"lowerBound":-0.1,"upperBound":1,"eligible":true}', '{"sampleCount":1,"successCount":0,"lowerBound":0,"upperBound":1.1,"eligible":true}', '{"sampleCount":1,"successCount":0,"lowerBound":0.8,"upperBound":0.2,"eligible":true}'] },
  { name: "ProjectArtifact.ID", schema: ProjectArtifact.ID, samples: ['"a"', '"a"', '"aux"', '"com1"', '"has_underscore"', '"upper"', JSON.stringify("a".repeat(63)), JSON.stringify("a".repeat(64)), JSON.stringify("a".repeat(65)), ...["aux", "com1", "com9", "con", "lpt1", "lpt9", "nul", "prn"].map((value) => JSON.stringify(value)), "\"com0\"", "\"com10\""] },
  { name: "ProjectArtifact.ScopeID", schema: ProjectArtifact.ScopeID, samples: ['"pas_a"', '"pas_"', '"pas_-a"', JSON.stringify(`pas_${"a".repeat(60)}`), JSON.stringify(`pas_${"a".repeat(61)}`)] },
  { name: "ProjectArtifact.VersionID", schema: ProjectArtifact.VersionID, samples: ['"pav_a"', '"pav_"', '"pav_a-"'] },
  { name: "ProjectArtifact.DeletionID", schema: ProjectArtifact.DeletionID, samples: ['"pad_a"', '"pad_"'] },
  { name: "ProjectArtifact.ActivationID", schema: ProjectArtifact.ActivationID, samples: ['"paa_a"', '"paa_"'] },
  { name: "ProjectArtifact.ObservationID", schema: ProjectArtifact.ObservationID, samples: ['"pao_a"', '"pao_"'] },
  { name: "ProjectArtifact.Revision", schema: ProjectArtifact.Revision, samples: ['0', '-0', '-1', '9007199254740991', '9007199254740992'] },
  { name: "ProjectArtifact.TimestampMillis", schema: ProjectArtifact.TimestampMillis, samples: ['0', '-1', '1'] },
  { name: "ProjectArtifact.Digest", schema: ProjectArtifact.Digest, samples: [JSON.stringify("a".repeat(64)), JSON.stringify("a".repeat(63)), JSON.stringify("A".repeat(64))] },
  { name: "ProjectArtifact.StorageID", schema: ProjectArtifact.StorageID, samples: ['"00000000-0000-0000-0000-000000000000"', '"00000000-0000-0000-0000-00000000000g"', '"000000000000000000000000000000000000"'] },
  { name: "ProjectArtifact.DisplayName", schema: ProjectArtifact.DisplayName, samples: ["\"\"", JSON.stringify("x".repeat(127)), JSON.stringify("x".repeat(128)), JSON.stringify("x".repeat(129)), JSON.stringify("😀".repeat(128)), JSON.stringify("😀".repeat(129))] },
  { name: "ProjectArtifact.Description", schema: ProjectArtifact.Description, samples: ["\"\"", JSON.stringify("x".repeat(511)), JSON.stringify("x".repeat(512)), JSON.stringify("x".repeat(513)), JSON.stringify("😀".repeat(512)), JSON.stringify("😀".repeat(513))] },
  { name: "ProjectArtifact.SkillContent", schema: ProjectArtifact.SkillContent, samples: ["\"\"", JSON.stringify("x".repeat(24575)), JSON.stringify("x".repeat(24576)), JSON.stringify("x".repeat(24577)), JSON.stringify("😀".repeat(6144)), JSON.stringify("😀".repeat(6145))] },
  { name: "ProjectArtifact.CommandTemplate", schema: ProjectArtifact.CommandTemplate, samples: ["\"\"", JSON.stringify("x".repeat(16383)), JSON.stringify("x".repeat(16384)), JSON.stringify("x".repeat(16385))] },
  { name: "ProjectArtifact.AgentSystem", schema: ProjectArtifact.AgentSystem, samples: ["\"\"", JSON.stringify("x".repeat(16383)), JSON.stringify("x".repeat(16384)), JSON.stringify("x".repeat(16385))] },
  { name: "ProjectArtifact.PluginDraft", schema: ProjectArtifact.PluginDraft, samples: ["\"\"", JSON.stringify("x".repeat(32767)), JSON.stringify("x".repeat(32768)), JSON.stringify("x".repeat(32769))] },
  { name: "ProjectArtifact.ContentRelpath", schema: ProjectArtifact.ContentRelpath, samples: ['"a/b.txt"', '"../a"', '"/a"', '"~/.x"', '"a\\b"', '"a"'] },
  { name: "ProjectArtifact.ConfirmationToken", schema: ProjectArtifact.ConfirmationToken, samples: ['"a"', '""', JSON.stringify("x".repeat(512)), JSON.stringify("x".repeat(513)), '"a.b"'] },
  { name: "ProjectArtifact.RenderedContent", schema: ProjectArtifact.RenderedContent, samples: ['"x"', '""', JSON.stringify("x".repeat(32768)), JSON.stringify("x".repeat(32769))] },
  ...Object.entries({ "ProjectArtifact.Kind": ProjectArtifact.Kind, "ProjectArtifact.Stage": ProjectArtifact.Stage, "ProjectArtifact.Source": ProjectArtifact.Source, "ProjectArtifact.VersionState": ProjectArtifact.VersionState, "ProjectArtifact.ActivationSource": ProjectArtifact.ActivationSource, "ProjectArtifact.TerminalOutcome": ProjectArtifact.TerminalOutcome, "ProjectArtifact.GoalStatus": ProjectArtifact.GoalStatus, "ProjectArtifact.FeedbackAction": ProjectArtifact.FeedbackAction, "ProjectArtifact.FeedbackActor": ProjectArtifact.FeedbackActor, "ProjectArtifact.AutomaticWriteOperation": ProjectArtifact.AutomaticWriteOperation, "ProjectArtifact.AutomaticWriteResult": ProjectArtifact.AutomaticWriteResult, "ProjectArtifact.ErrorCode": ProjectArtifact.ErrorCode }).map(([name, schema]) => ({ name, schema, samples: [...literalStrings(schema.ast).map((value) => JSON.stringify(value)), '"invalid"'] })),
  ...sessionEventDataCases,
  ...sessionEventPrivateDataCases,
  { name: "ProjectArtifact.Provenance", schema: ProjectArtifact.Provenance, samples: ['{"source":"user"}', '{"source":"user","creatorAgentID":null}', '{"source":"bad"}'] },
  { name: "ProjectArtifact.Version", schema: ProjectArtifact.Version, samples: [JSON.stringify(paVersion), JSON.stringify({ ...paVersion, parentVersionID: null }), JSON.stringify({ ...paVersion, contentDigest: "bad" })] },
  { name: "ProjectArtifact.Artifact", schema: ProjectArtifact.Artifact, samples: [JSON.stringify(paArtifact), JSON.stringify({ ...paArtifact, fallbackVersionID: null }), JSON.stringify({ ...paArtifact, revision: -1 })] },
  { name: "ProjectArtifact.ArtifactSummary", schema: ProjectArtifact.ArtifactSummary, samples: [JSON.stringify(paSummary), JSON.stringify({ ...paSummary, lastUsedAt: null }), JSON.stringify({ ...paSummary, description: "x".repeat(2049) })] },
  { name: "ProjectArtifact.CollisionDiagnostic", schema: ProjectArtifact.CollisionDiagnostic, samples: ['{"type":"existing-source","kind":"skill","id":"safe","message":"Description"}', '{"type":"bad","kind":"skill","id":"safe","message":"Description"}'] },
  { name: "ProjectArtifact.ArtifactDetails", schema: ProjectArtifact.ArtifactDetails, samples: [JSON.stringify({ artifact: paArtifact, definition: paDefinition, currentVersion: paVersion, versions: [paVersion], diagnostics: [] }), "{}"] },
  { name: "ProjectArtifact.Metrics", schema: ProjectArtifact.Metrics, samples: [JSON.stringify({ ...paMetrics, score: -1 }), JSON.stringify(paMetrics), JSON.stringify({ ...paMetrics, score: 1 }), JSON.stringify({ ...paMetrics, score: -1.01 }), JSON.stringify({ ...paMetrics, score: 1.01 }), JSON.stringify({ ...paMetrics, rewardUnits: -1 }), JSON.stringify({ ...paMetrics, penaltyUnits: -1 })] },
  { name: "ProjectArtifact.Trash", schema: ProjectArtifact.Trash, samples: [JSON.stringify({ deletionID: "pad_a", scope: paScope, kind: "skill", id: "safe", priorStage: "active", priorVersionID: "pav_a", deletedAt: 0, purgeAfter: 2592000000 }), JSON.stringify({ deletionID: "pad_a", scope: paScope, kind: "skill", id: "safe", priorStage: "active", priorVersionID: "pav_a", deletedAt: 0, purgeAfter: 1 })] },
  { name: "ProjectArtifact.Activation", schema: ProjectArtifact.Activation, samples: [JSON.stringify({ id: "paa_a", artifact: paIdentity, source: "manual", boundarySeq: 0, activatedAt: 0 }), JSON.stringify({ id: "paa_a", artifact: paIdentity, projectID: null, source: "manual", boundarySeq: 0, activatedAt: 0 }), "{}"] },
  { name: "ProjectArtifact.Observation", schema: ProjectArtifact.Observation, samples: [JSON.stringify({ id: "pao_a", artifact: paIdentity, activationSetDigest: paDigest, activeArtifactCount: 0, externalConfounded: false, eligible: true, terminalOutcome: "succeeded", goalStatus: "none", repeatFix: false, observedAt: 0 }), "{}"] },
  { name: "ProjectArtifact.Feedback", schema: ProjectArtifact.Feedback, samples: [JSON.stringify({ artifact: paIdentity, action: "disable", actor: "user", timeCreated: 0 }), "{}"] },
  { name: "ProjectArtifact.AutomaticWrite", schema: ProjectArtifact.AutomaticWrite, samples: [JSON.stringify({ scopeID: "pas_a", sessionID: "ses_1", insightDigest: paDigest, operation: "create", result: "created", versionID: "pav_a", contentDigest: paDigest, timeCreated: 0 }), "{}"] },
  { name: "ProjectArtifact.CreateRequest", schema: ProjectArtifact.CreateRequest, samples: [JSON.stringify({ key: { scope: { type: "global" }, kind: "skill", id: "safe" }, definition: paDefinition }), JSON.stringify({ key: { scope: { type: "global" }, kind: "command", id: "safe" }, definition: paDefinition })] },
  { name: "ProjectArtifact.UpdateRequest", schema: ProjectArtifact.UpdateRequest, samples: [JSON.stringify({ key: { scope: { type: "global" }, kind: "skill", id: "safe" }, definition: paDefinition, ...paExpectation }), JSON.stringify({ key: { scope: { type: "global" }, kind: "command", id: "safe" }, definition: paDefinition, ...paExpectation })] },
  { name: "ProjectArtifact.DeleteRequest", schema: ProjectArtifact.DeleteRequest, samples: [JSON.stringify({ key: { scope: { type: "global" }, kind: "skill", id: "safe" }, ...paExpectation }), "{}"] },
  { name: "ProjectArtifact.RestoreRequest", schema: ProjectArtifact.RestoreRequest, samples: ['{"deletionID":"pad_a"}', '{"deletionID":"bad"}'] },
  { name: "ProjectArtifact.ListRequest", schema: ProjectArtifact.ListRequest, samples: ['{"scope":{"type":"project"}}', '{"scope":{"type":"project"},"kind":null}', '{"scope":{"type":"bad"}}'] },
  { name: "ProjectArtifact.PromotionPreviewRequest", schema: ProjectArtifact.PromotionPreviewRequest, samples: [JSON.stringify({ key: { scope: { type: "project" }, kind: "skill", id: "safe" }, ...paExpectation }), "{}"] },
  { name: "ProjectArtifact.PromotionConfirmRequest", schema: ProjectArtifact.PromotionConfirmRequest, samples: ['{"token":"abc"}', '{"token":""}'] },
  { name: "ProjectArtifact.PromotionPreview", schema: ProjectArtifact.PromotionPreview, samples: [JSON.stringify({ artifact: paSummary, metrics: paMetrics, destination: { ...paScope, type: "global" }, risk: "declarative", renderedContent: "content", token: "abc", expiresAt: 1 }), "{}"] },
  { name: "ProjectArtifact.ValidationError", schema: ProjectArtifact.ValidationError, samples: ['{"code":"InvalidArtifact","message":"Description"}', '{"code":"invalid","message":"Description"}'] },
  { name: "ProjectArtifact.UnsupportedKindError", schema: ProjectArtifact.UnsupportedKindError, samples: ['{"code":"UnsupportedKind","kind":"skill","message":"Description"}', '{"code":"InvalidArtifact","kind":"skill","message":"Description"}'] },
  { name: "Event.IntegrationUpdated", schema: Integration.Event.Updated, samples: ['{"id":"evt_1","created":0,"type":"integration.updated","data":{}}', '{"id":"evt_1","created":0,"type":"integration.updated","data":null}'] },
  { name: "Event.IntegrationConnectionUpdated", schema: Integration.Event.ConnectionUpdated, samples: ['{"id":"evt_1","created":0,"type":"integration.connection.updated","data":{"integrationID":"int"}}', '{"id":"evt_1","created":0,"type":"integration.connection.updated","data":{}}'] },
  { name: "Event.PermissionAsked", schema: Permission.Event.Asked, samples: ['{"id":"evt_1","created":0,"type":"permission.asked","data":{"id":"per_1","sessionID":"ses_1","action":"read","resources":[]}}', '{"id":"evt_1","created":0,"type":"permission.asked","data":{"id":"bad","sessionID":"ses_1","action":"read","resources":[]}}'] },
  { name: "Event.PermissionReplied", schema: Permission.Event.Replied, samples: ['{"id":"evt_1","created":0,"type":"permission.replied","data":{"sessionID":"ses_1","requestID":"per_1","reply":"once"}}', '{"id":"evt_1","created":0,"type":"permission.replied","data":{"sessionID":"ses_1","requestID":"per_1","reply":"bad"}}'] },
  { name: "Event.ModelsDevRefreshed", schema: ModelsDev.Event.Refreshed, samples: ['{"id":"evt_1","created":0,"type":"models-dev.refreshed","data":{}}', '{"id":"evt_1","created":0,"type":"wrong","data":{}}'] },
  { name: "Event.CatalogUpdated", schema: Catalog.Event.Updated, samples: ['{"id":"evt_1","created":0,"type":"catalog.updated","data":{}}', '{"id":"evt_1","created":0,"type":"catalog.updated","data":null}'] },
  { name: "Event.ConfigUpdated", schema: Config.Event.Updated, samples: ['{"id":"evt_1","created":0,"type":"config.updated","data":{}}', '{"id":"evt_1","created":0,"type":"config.updated","data":null}'] },
  { name: "Event.AgentUpdated", schema: Agent.Event.Updated, samples: ['{"id":"evt_1","created":0,"type":"agent.updated","data":{}}', '{"id":"evt_1","created":0,"type":"agent.updated","data":null}'] },
  { name: "Event.CommandUpdated", schema: Command.Event.Updated, samples: ['{"id":"evt_1","created":0,"type":"command.updated","data":{}}', '{"id":"evt_1","created":0,"type":"command.updated","data":null}'] },
  { name: "Integration.AttemptID", schema: Integration.AttemptID, samples: ['"con_1"', '"\\ud800"', "null"] },
  { name: "Session.ProviderCache", schema: SessionCacheDiagnostics.ProviderCache, samples: ['{"mechanism":"none","readReported":false,"writeReported":false}', '{"mechanism":"invalid","readReported":false,"writeReported":false}'] },
  { name: "Model.ProfileName", schema: Model.ProfileName, samples: ['"fast"', '""'] },
  { name: "Model.Daybreak", schema: Model.Daybreak, samples: ['"daybreak_blue"', '"daybreak_red"', '"blue"'] },
  { name: "Model.API", schema: Model.API, samples: ['"chat"', '"responses"', '"completion"'] },
  { name: "Permission.ID", schema: Permission.ID, samples: ['"per"', '"per_1"', '"x"'] },
  { name: "Permission.Reply", schema: Permission.Reply, samples: ['"once"', '"always"', '"reject"', '"yes"'] },
  { name: "Permission.Effect", schema: Permission.Effect, samples: ['"allow"', '"deny"', '"ask"', '"prompt"'] },
  { name: "Permission.Source", schema: Permission.Source, samples: ['{"type":"tool","messageID":"msg_1","callID":"call"}', '{"type":"tool","messageID":"msg_1"}'] },
  { name: "PermissionSaved.ID", schema: PermissionSaved.ID, samples: ['"saved"', '"\\ud800"', "null"] },
  { name: "Agent.ID", schema: Agent.ID, samples: ['""', '"\\ud800"'] },
  { name: "Agent.Name", schema: Agent.Name, samples: ['""', '"\\ud800"'] },
  { name: "Agent.Color", schema: Agent.Color, samples: ['"#aAfF09"', '"primary"', '"#gg0000"', '"#1234567"'] },
  { name: "ProviderRequest.ID", schema: ProviderRequest.ID, samples: ['"prq_"', '"prq_a"', '"req_a"'] },
  { name: "ProviderRequest.Source", schema: ProviderRequest.Source, samples: ['"step"', '"prediction"', '"prompt"', '"other"'] },
  { name: "ProviderRequest.Record", schema: ProviderRequest.Record, samples: samples([providerRequestRecord, { ...providerRequestRecord, request: 0 }, { ...providerRequestRecord, connectionIdentityDigest: "A".repeat(64) }, { ...providerRequestRecord, connectionIdentityDigest: "a".repeat(64) }]) },
  { name: "ProviderRequest.ModelSpend", schema: ProviderRequest.ModelSpend, samples: [JSON.stringify({ model: providerRequestModel, requests: 0, tokens: providerRequestTokens }), JSON.stringify({ model: providerRequestModel, requests: 1, tokens: providerRequestTokens, cost: 1 }), JSON.stringify({ model: providerRequestModel, requests: 1, tokens: providerRequestTokens, cost: 1, costProvenance: "recorded" })] },
  ...Object.entries({
    "ProviderRequest.Continuation": ProviderRequest.Continuation,
    "ProviderRequest.Invalidation": ProviderRequest.Invalidation,
    "ProviderRequest.CostProvenance": ProviderRequest.CostProvenance,
    "ProviderRequest.ReportGroup": ProviderRequest.ReportGroup,
    "ProviderRequest.ReportSort": ProviderRequest.ReportSort,
    "ProviderRequest.ReportOrder": ProviderRequest.ReportOrder,
  }).map(([name,schema])=>({name,schema,samples:['"step"','"key"','"model"','"desc"','"not-valid"']})),
  { name: "ProviderRequest.ReportInput", schema: ProviderRequest.ReportInput, samples: ['{"group":"model","from":0,"to":1,"limit":200,"sort":"cost","order":"desc"}', '{"group":"session","from":1,"to":1}', '{"group":"session","limit":201}', '{"group":"session","limit":0}', JSON.stringify({ group: "session", timeZone: "x".repeat(128) }), JSON.stringify({ group: "session", timeZone: "x".repeat(129) }), '{"group":"bad"}'] },
  { name: "ProviderRequest.Timing", schema: ProviderRequest.Timing, samples: ['{"firstOutputMs":0,"generatedTokens":1}', '{"observedGenerationDurationNs":0}', '{"retryWaitMs":-1}'] },
  { name: "ProviderRequest.Speed", schema: ProviderRequest.Speed, samples: ['{"samples":0,"outputTokensPerSecond":0}', '{"samples":0,"outputTokensPerSecond":-1}'] },
  { name: "ProviderRequest.ReportMetrics", schema: ProviderRequest.ReportMetrics, samples: ['{"logical":0,"physical":0,"helpers":0,"continued":0,"fallback":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}}', '{"logical":0,"physical":0,"helpers":0,"continued":0,"fallback":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},"cost":1}'] },
  { name: "ProviderRequest.Summary", schema: ProviderRequest.Summary, samples: [JSON.stringify({ logical: 0, physical: 0, helpers: 0, continued: 0, fallback: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, latestNamespace: "12345678" }), JSON.stringify({ logical: 0, physical: 0, helpers: 0, continued: 0, fallback: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, latestNamespace: "1234567" }), JSON.stringify({ logical: 0, physical: 0, helpers: 0, continued: 0, fallback: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, latestNamespace: "123456789" })] },
  { name: "ProviderRequest.ReportRow", schema: ProviderRequest.ReportRow, samples: [JSON.stringify({ key: "model", label: "Model", logical: 0, physical: 0, helpers: 0, continued: 0, fallback: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, speed: { samples: 0 } }), JSON.stringify({ key: "model", label: "Model", logical: 0, physical: 0, helpers: 0, continued: 0, fallback: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 1 })] },
  { name: "ProviderRequest.Report", schema: ProviderRequest.Report, samples: [JSON.stringify({ group: "model", rows: [], total: { logical: 0, physical: 0, helpers: 0, continued: 0, fallback: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, rowCount: 0 })] },
  { name: "Session.CacheDiagnostics", schema: SessionCacheDiagnostics.Info, samples: ['{"model":{"id":"m","providerID":"openai"},"context":{"total":10,"percent":0},"tokens":{"uncachedInput":0,"output":0,"reasoning":0,"cacheRead":0,"cacheWrite":0},"cache":{"eligible":0,"mechanism":"none","readReported":false,"writeReported":false}}', '{"model":{"id":"m","providerID":"openai"},"context":{"total":-1},"tokens":{"uncachedInput":0,"output":0,"reasoning":0,"cacheRead":0,"cacheWrite":0},"cache":{"eligible":0,"mechanism":"none","readReported":false,"writeReported":false}}'] },
  { name: "Session.GenerationSpeed", schema: SessionCacheDiagnostics.GenerationSpeed, samples: ['{"model":{"id":"m","providerID":"openai"},"tokens":1,"durationNs":1,"tokensPerSecond":1}', '{"model":{"id":"m","providerID":"openai"},"tokens":1,"durationNs":1,"tokensPerSecond":0}'] },
  { name: "Session.GenerationSpeedHistory", schema: SessionCacheDiagnostics.GenerationSpeedHistory, samples: samples([{ recent: [] }, { recent: Array.from({ length: 8 }, () => ({ model: { id: "m", providerID: "openai" }, tokens: 1, durationNs: 1, tokensPerSecond: 1 })) }, { recent: Array.from({ length: 9 }, () => ({ model: { id: "m", providerID: "openai" }, tokens: 1, durationNs: 1, tokensPerSecond: 1 })) }]) },
  { name: "Model.Ref", schema: Model.Ref, samples: ['{"id":"gpt-5","providerID":"openai"}', '{"id":"","providerID":"openai","profile":""}', '{"id":"x","providerID":"openai","variant":null}'] },
  { name: "Model.Capabilities", schema: Model.Capabilities, samples: ['{"tools":true,"input":["text"],"output":[]}', '{"tools":1,"input":[],"output":[]}'] },
  { name: "Model.Cost", schema: Model.Cost, samples: ['{"input":1,"output":2,"cache":{"read":0,"write":0}}', '{"tier":{"type":"context","size":-1},"input":1,"output":2,"cache":{"read":0,"write":0}}'] },
  { name: "Model.Variant", schema: Model.Variant, samples: ['{"id":"reasoning","settings":{"x":null}}', '{"id":"x","headers":{"h":1}}'] },
  { name: "Model.Profile", schema: Model.Profile, samples: ['{"name":"fast","active":true,"variants":["reasoning"],"daybreak":["daybreak_blue"]}', '{"name":"","active":true}', '{"name":"x","active":true,"daybreak":["bad"]}'] },
  { name: "Model.Info", schema: Model.Info, samples: ['{"id":"m","modelID":"m","providerID":"openai","name":"Model","capabilities":{"tools":true,"input":[],"output":[]},"variants":[],"time":{"released":0},"cost":[],"status":"active","enabled":true,"limit":{"context":10,"output":5}}', '{"id":"m","modelID":"m","providerID":"openai","name":"Model","capabilities":{"tools":false,"input":[],"output":[]},"variants":[],"time":{"released":0},"cost":[],"status":"active","enabled":true,"limit":{"context":10,"output":5},"api":"bad"}'] },
  { name: "Model.Default", schema: Model.Default, samples: ['{"id":"m","modelID":"m","providerID":"openai","name":"Model","capabilities":{"tools":false,"input":[],"output":[]},"variants":[],"time":{"released":0},"cost":[],"status":"active","enabled":true,"limit":{"context":10,"output":5},"selection":{"id":"m","providerID":"openai"}}'] },
  { name: "Permission.Request", schema: Permission.Request, samples: ['{"id":"per_1","sessionID":"ses_1","action":"read","resources":["x"],"source":{"type":"tool","messageID":"msg_1","callID":"call"}}', '{"id":"bad","sessionID":"ses_1","action":"read","resources":[]}', '{"id":"per","sessionID":"ses_1","action":"x","resources":[]}'] },
  { name: "Permission.Rule", schema: Permission.Rule, samples: ['{"action":"read","resource":"*","effect":"allow"}', '{"action":"read","resource":"*","effect":"prompt"}'] },
  { name: "PermissionSaved.Info", schema: PermissionSaved.Info, samples: ['{"id":"saved","projectID":"global","action":"read","resource":"*"}', '{"id":"saved","projectID":"bad","action":"read","resource":"*"}'] },
  { name: "Agent.Info", schema: Agent.Info, samples: ['{"id":"build","name":"Build","request":{"settings":{},"headers":{},"body":{}},"mode":"all","hidden":false,"permissions":[]}', JSON.stringify({ id: "rule", name: "Rule", request: { settings: {}, headers: {}, body: {} }, mode: "primary", hidden: false, permissions: [{ action: "read", resource: "*", effect: "allow" }] }), '{"id":"x","name":"x","request":{"settings":{},"headers":{},"body":{}},"mode":"invalid","hidden":false,"permissions":[]}'] },
  { name: "Command.Info", schema: Command.Info, samples: ['{"name":"review","template":"Review this"}', '{"name":"x","template":"x","subtask":null}'] },
  { name: "Provider.ID", schema: Provider.ID, samples: ['"openai"', '"other"', '"\\ud800"', "null"] },
  { name: "Provider.IntegrationRef", schema: Provider.IntegrationRef, samples: ['{"providerID":"openai","integrationID":"integration"}', '{"providerID":"openai"}'] },
  { name: "Provider.Request", schema: Provider.Request, samples: ['{"settings":{"x":1},"headers":{"a":"b"},"body":{}}', '{"headers":{"a":1},"body":{}}', '{"headers":{},"body":{"x":1e400}}'] },
  { name: "Provider.Settings", schema: Provider.Settings, samples: ['{"x":1,"nested":{"y":null}}', '{"x":1e400}', '[]'] },
  { name: "Provider.Info", schema: Provider.Info, samples: ['{"id":"openai","name":"OpenAI","package":"@sdk","disabled":false,"integrationID":"int","settings":{"x":1},"headers":{"h":"v"},"body":{}}', '{"id":"invalid","name":"x","package":"","headers":{"h":1}}', '{}'] },
  { name: "Connection.Info", schema: Connection.Info, samples: ['{"type":"credential","id":"cred","label":"Primary","active":true}', '{"type":"env","name":"OPENAI_API_KEY"}', '{"type":"credential","id":"cred","label":"x"}', '{"type":"bad"}'] },
  { name: "Connection.CredentialInfo", schema: Connection.CredentialInfo, samples: ['{"type":"credential","id":"cred","label":"Primary","active":true}', '{"type":"credential","id":"cred","label":"Primary"}'] },
  { name: "Connection.EnvInfo", schema: Connection.EnvInfo, samples: ['{"type":"env","name":"TOKEN"}', '{"type":"env","name":1}'] },
  { name: "Credential.ID", schema: Credential.ID, samples: ['"cred"', '"\\ud800"', "null"] },
  { name: "Credential.OAuth", schema: Credential.OAuth, samples: ['{"type":"oauth","methodID":"oauth-main","refresh":"r","access":"a","expires":0}', '{"type":"oauth","methodID":"x","refresh":"r","access":"a","expires":-1}'] },
  { name: "Credential.Key", schema: Credential.Key, samples: ['{"type":"key","key":"x"}', '{"type":"key","key":1}'] },
  { name: "Credential.Value", schema: Credential.Value, samples: ['{"type":"key","key":"secret","metadata":{"x":null}}', '{"type":"oauth","methodID":"oauth-main","refresh":"r","access":"a","expires":0}', '{"type":"oauth","methodID":"","refresh":"r","access":"a","expires":-1}', '{"type":"key","key":1}'] },
  { name: "Integration.Method", schema: Integration.Method, samples: ['{"id":"oauth","type":"oauth","label":"Sign in","prompts":[{"type":"text","key":"account","message":"Account?"}]}', '{"id":"cmd","type":"command","label":"Login","command":["tool"]}', '{"type":"key","label":"API key"}', '{"type":"env","names":["TOKEN"]}', '{"type":"bad"}'] },
  { name: "Integration.Info", schema: Integration.Info, samples: ['{"id":"int","name":"Provider","methods":[{"type":"key"}],"connections":[]}', '{"id":"int","name":"Provider","methods":[{"type":"env","names":[]}],"connections":[{"type":"env","name":"TOKEN"}]}', '{"id":"int","name":"x","methods":[{"type":"bad"}],"connections":[]}'] },
  { name: "Integration.When", schema: Integration.When, samples: ['{"key":"account","op":"eq","value":"x"}', '{"key":"x","op":"bad","value":"x"}'] },
  { name: "Integration.Inputs", schema: Integration.Inputs, samples: ['{"account":"x","region":"west"}', '{"account":1}', '[]'] },
  { name: "Integration.TextPrompt", schema: Integration.TextPrompt, samples: ['{"type":"text","key":"email","message":"Email?","placeholder":"x","when":{"key":"x","op":"neq","value":""}}', '{"type":"text","key":"x","message":"x","placeholder":null}', '{"type":"select","key":"x","message":"x"}'] },
  { name: "Integration.SelectPrompt", schema: Integration.SelectPrompt, samples: ['{"type":"select","key":"region","message":"Choose","options":[{"label":"East","value":"east"}]}', '{"type":"select","key":"x","message":"x","options":[{"label":"x","value":"x","hint":null}]}'] },
  { name: "Integration.Prompt", schema: Integration.Prompt, samples: ['{"type":"text","key":"email","message":"Email?"}', '{"type":"select","key":"region","message":"Choose","options":[]}', '{"type":"other"}'] },
  { name: "Integration.OAuthMethod", schema: Integration.OAuthMethod, samples: ['{"id":"oauth","type":"oauth","label":"Login","remote":true}', '{"id":"oauth","type":"oauth","label":"x","remote":null}'] },
  { name: "Integration.CommandMethod", schema: Integration.CommandMethod, samples: ['{"id":"cmd","type":"command","label":"Login","command":["cmd"]}', '{"id":"cmd","type":"command","label":"x","command":"cmd"}'] },
  { name: "Integration.KeyMethod", schema: Integration.KeyMethod, samples: ['{"type":"key"}', '{"type":"key","label":""}'] },
  { name: "Integration.EnvMethod", schema: Integration.EnvMethod, samples: ['{"type":"env","names":["TOKEN"]}', '{"type":"env","names":"TOKEN"}'] },
  { name: "Integration.Ref", schema: Integration.Ref, samples: ['{"id":"integration","name":"Provider"}', '{"id":"integration"}'] },
  { name: "Integration.Attempt", schema: Integration.Attempt, samples: ['{"attemptID":"attempt","url":"https://example.com","instructions":"Continue","mode":"auto","time":{"created":1,"expires":2}}', '{"attemptID":"x","url":"x","instructions":"x","mode":"bad","time":{"created":1,"expires":2}}'] },
  { name: "Integration.AttemptStatus", schema: Integration.AttemptStatus, samples: ['{"status":"pending","time":{"created":1,"expires":2}}', '{"status":"failed","message":"bad","time":{"created":1,"expires":2}}', '{"status":"pending","time":{}}'] },
  { name: "Integration.CommandAttempt", schema: Integration.CommandAttempt, samples: ['{"attemptID":"a","time":{"created":1,"expires":2}}', '{"attemptID":"a","time":{}}'] },
  { name: "Integration.CommandAttemptStatus", schema: Integration.CommandAttemptStatus, samples: ['{"status":"pending","time":{"created":1,"expires":2}}', '{"status":"pending","message":null,"time":{"created":1,"expires":2}}'] },
  { name: "ProviderUsage.Window", schema: ProviderUsage.Window, samples: ['{"id":"daily","label":"Today","unit":"percent","used":0,"limit":100}', '{"id":"","label":"x","unit":"usd"}', '{"id":"daily","label":"Today","unit":"percent","used":-1}', '{"id":"daily","label":"Today","unit":"percent","used":1e400}', '{"id":"daily","label":"Today","unit":"widgets"}'] },
  { name: "ProviderUsage.Status", schema: ProviderUsage.Status, samples: ['"available"', '"unknown"'] },
  { name: "ProviderUsage.Source", schema: ProviderUsage.Source, samples: ['"provider_api"', '"unknown"'] },
  { name: "ProviderUsage.Stability", schema: ProviderUsage.Stability, samples: ['"stable"', '"unknown"'] },
  { name: "ProviderUsage.Unit", schema: ProviderUsage.Unit, samples: ['"percent"', '"unknown"'] },
  { name: "ProviderUsage.Snapshot", schema: ProviderUsage.Snapshot, samples: ['{"providerID":"openai","label":"Account","status":"available","source":"provider_api","stability":"stable","updatedAt":0,"windows":[]}', '{"providerID":"openai","label":"","status":"available","source":"provider_api","stability":"stable","updatedAt":0,"windows":[]}'] },
  { name: "ProviderUsage.Observation", schema: ProviderUsage.Observation, samples: ['{"providerID":"openai","label":"Account","source":"response_headers","stability":"observed","observedAt":1,"windows":[]}', '{"providerID":"openai","label":"Account","source":"none","stability":"observed","observedAt":1,"windows":[]}'] },
  { name: "Config.Diagnostic", schema: Config.Diagnostic, samples: ['{"path":"ycoding.json","reason":"invalid-values","message":"bad field"}', '{"path":"x","reason":"unknown","message":"bad"}'] },
  { name: "Config.DiagnosticReason", schema: Config.DiagnosticReason, samples: ['"invalid-json"', '"removed-keys"', '"other"'] },
  { name: "LLM.ToolContent", schema: LLM.ToolContent, samples: ['{"type":"text","text":"\\ud800"}', '{"type":"file","uri":"file:///x","mime":"text/plain"}', '{"type":"file","uri":"x","mime":"x","name":null}'] },
  { name: "LLM.FinishReason", schema: LLM.FinishReason, samples: ['"stop"', '"tool-calls"', '"other"', "null"] },
  { name: "LLM.ProviderMetadata", schema: LLM.ProviderMetadata, samples: ['{"openai":{"reasoning":"high"}}', '{"openai":1}', '[]'] },
  { name: "LLM.ToolTextContent", schema: LLM.ToolTextContent, samples: ['{"type":"text","text":"x"}', '{"type":"text","text":1}'] },
  { name: "LLM.ToolFileContent", schema: LLM.ToolFileContent, samples: ['{"type":"file","uri":"x","mime":"text/plain"}', '{"type":"file","uri":"x","mime":"text/plain","name":null}'] },
  { name: "Prompt.Prompt", schema: Prompt, samples: ['{"text":"hello"}', '{"text":"x","files":[{"content":{"type":"managed","digest":"' + "a".repeat(64) + '","bytes":0,"path":"attachments/sha256/aa/' + "a".repeat(64) + '"},"mime":"text/plain"}]}', '{"text":"x","files":null}'] },
  { name: "PromptInput.Prompt", schema: PromptInput.Prompt, samples: ['{"text":"hello","files":[{"uri":"file:///x"}]}', '{"text":"x","agents":[{"name":"agent"}]}', '{"text":"x","files":[{"uri":1}]}'] },
  { name: "PromptInput.FileAttachment", schema: PromptInput.FileAttachment, samples: ['{"uri":"file:///x","name":"x"}', '{"uri":"x","mention":null}'] },
  { name: "Prompt.Base64", schema: Base64, samples: ['""', '"YQ=="', '"YWI="', '"YQ"', '"A==="', '"\\ud800"'] },
  { name: "Prompt.AttachmentDigest", schema: AttachmentDigest, samples: ['"' + "a".repeat(64) + '"', '"' + "a".repeat(63) + '"', '"' + "a".repeat(65) + '"', '"' + "A".repeat(64) + '"', '"abc"'] },
  { name: "Prompt.Mention", schema: PromptMention, samples: ['{"start":0,"end":1,"text":"x"}', '{"start":1e400,"end":1,"text":"x"}'] },
  { name: "Prompt.ManagedAttachmentContent", schema: ManagedAttachmentContent, samples: ['{"type":"managed","digest":"' + "a".repeat(64) + '","bytes":0,"path":"attachments/sha256/aa/' + "a".repeat(64) + '"}', '{"type":"managed","digest":"' + "a".repeat(64) + '","bytes":-1,"path":"attachments/sha256/aa/' + "a".repeat(64) + '"}', '{"type":"managed","digest":"' + "a".repeat(64) + '","bytes":0,"path":"attachments/sha256/a/' + "a".repeat(64) + '"}', '{"type":"other","digest":"' + "a".repeat(64) + '","bytes":0,"path":"attachments/sha256/aa/' + "a".repeat(64) + '"}'] },
  { name: "Prompt.FileAttachment", schema: FileAttachment, samples: ['{"content":{"type":"managed","digest":"' + "a".repeat(64) + '","bytes":0,"path":"attachments/sha256/aa/' + "a".repeat(64) + '"},"mime":"text/plain"}', '{"content":{"type":"managed","digest":"x","bytes":0,"path":"attachments/sha256/aa/' + "a".repeat(64) + '"},"mime":"text/plain"}'] },
  { name: "Prompt.AgentAttachment", schema: AgentAttachment, samples: ['{"name":"agent"}', '{"name":"x","mention":null}'] },
  ...Object.entries({
    "Schema.PositiveInt": PositiveInt,
    "Schema.NonNegativeInt": NonNegativeInt,
    "Money.USD": USD,
    "Money.USDPerMillionTokens": USDPerMillionTokens,
    "Event.Seq": Event.Seq,
    "Event.Version": Event.Version,
    "Contract.Finite": Schema.Finite,
  }).map(([name, schema]) => ({ name, schema, samples: numbers })),
  ...Object.entries({
    "Schema.RelativePath": RelativePath,
    "Schema.AbsolutePath": AbsolutePath,
    SessionID: SessionID,
    ProjectID: ProjectID,
    WorkspaceID: WorkspaceID,
    "SessionMessageID.ID": ID,
    IntegrationID: IntegrationID,
    IntegrationMethodID: IntegrationMethodID,
    "Snapshot.ID": Snapshot.ID,
    "Event.ID": Event.ID,
    SourceEpoch: SourceEpoch,
  }).map(([name, schema]) => ({
    name,
    schema,
    samples: [...strings, '"ses\\ud800"', '"wrk\\udc00"', '"msg_\\ud800"', '"evt_\\udc00"'],
  })),
  {
    name: "Schema.DateTimeUtcFromMillis",
    schema: DateTimeUtcFromMillis,
    samples: [
      ...numbers,
      "8640000000000000",
      "8640000000000001",
      "-8640000000000000",
      "-8640000000000001",
      "1700000000000.9",
    ],
  },
  {
    name: "TokenUsage.Info",
    schema: TokenUsage.Info,
    samples: [
      '{"cache":{"write":-1.5,"read":0,"ignored":true},"reasoning":-0,"output":2.5,"input":-3,"ignored":true}',
      '{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}',
      "{}",
      '{"input":0,"output":0,"reasoning":0,"cache":{"read":0}}',
      '{"input":1e400,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}',
      "null",
    ],
  },
  {
    name: "Location.Ref",
    schema: Location.Ref,
    samples: [
      '{"directory":""}',
      '{"workspaceID":"wrk","directory":"\\ud800","extra":true}',
      '{"directory":"x","workspaceID":null}',
      '{"directory":"x","workspaceID":"bad"}',
      "{}",
      "null",
    ],
  },
  {
    name: "Location.Info",
    schema: Location.Info,
    samples: [
      '{"project":{"directory":"","id":""},"directory":"relative"}',
      '{"project":{"id":"global","directory":"\\udc00","extra":0},"workspaceID":"wrk","directory":"x","extra":0}',
      '{"directory":"x","project":{}}',
      '{"directory":"x","workspaceID":null,"project":{"id":"global","directory":"x"}}',
      "{}",
      "null",
    ],
  },
  {
    name: "Location.Response",
    schema: Location.response(Schema.Unknown),
    samples: [
      '{"data":{"\\ud800":[null,false,0]},"location":{"directory":"","project":{"id":"global","directory":""}}}',
      '{"location":{"directory":"","project":{"id":"global","directory":""}}}',
      "null",
    ],
  },
  {
    name: "Event.Durable",
    schema: durable,
    samples: samples([
      envelope,
      { ...envelope, metadata: undefined, sourceEpoch: undefined, location: undefined, data: { text: "" } },
      { ...envelope, durable: { ...envelope.durable, version: 1 } },
      { ...envelope, durable: undefined },
      { ...envelope, sourceEpoch: "" },
      { ...envelope, location: null },
      { ...envelope, metadata: null },
      { ...envelope, type: "wrong" },
      { ...envelope, data: { text: 1 } },
    ]),
  },
  {
    name: "Event.Ephemeral",
    schema: ephemeral,
    samples: samples([
      { ...envelope, type: "fixture.ping" },
      {
        ...envelope,
        type: "fixture.ping",
        data: { text: "" },
        metadata: undefined,
        sourceEpoch: undefined,
        location: undefined,
      },
      { ...envelope, type: "fixture.ping", created: 8640000000000001 },
      { ...envelope, type: "fixture.ping", metadata: [] },
    ]),
  },
  {
    name: "Contract.Presence",
    schema: Schema.Struct({
      required: Schema.String,
      optional: optional(Schema.String),
      clear: optional(Schema.NullOr(Schema.String)),
      open: optional(Schema.Unknown),
    }),
    samples: [
      '{"required":""}',
      '{"open":null,"clear":null,"optional":"","required":"\\ud800"}',
      '{"required":"x","clear":"","open":{"\\udc00":[]}}',
      '{"required":"x","optional":null}',
      "{}",
    ],
  },
  {
    name: "Contract.BoundedString",
    schema: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2)),
    samples: ['""', '"a"', '"😀"', '"😀a"', '"\\ud800"', '"\\ud800\\udc00"', "1"],
  },
  {
    name: "Contract.IntegerRange",
    schema: Schema.Int.check(Schema.isBetween({ minimum: -2, maximum: 2 })),
    samples: [...numbers, "-2", "2", "3", "-3"],
  },
  {
    name: "Contract.Literal",
    schema: Schema.Literals(["normal", "goal"]),
    samples: ['"normal"', '"goal"', '"yolo"', "1", "null"],
  },
  {
    name: "Contract.Tagged",
    schema: Schema.Union([
      Schema.Struct({ type: Schema.tag("text"), text: Schema.String }),
      Schema.Struct({ type: Schema.tag("count"), count: NonNegativeInt }),
    ]).pipe(Schema.toTaggedUnion("type")),
    samples: [
      '{"text":"\\ud800","type":"text","extra":0}',
      '{"count":0,"type":"count"}',
      '{"type":"other"}',
      '{"type":"count","count":-1}',
      '{"type":"text","text":null}',
      "{}",
    ],
  },
  {
    name: "Contract.Open",
    schema: Schema.Unknown,
    samples: [
      "null",
      "false",
      "0",
      "1e400",
      "-1e400",
      '"\\ud800"',
      '[false,null,""]',
      '{"b":1,"2":0,"\\ud800":"\\udc00","a":[]}',
    ],
  },
  {
    name: "Contract.Json",
    schema: Schema.Json,
    samples: [
      "null",
      "false",
      "0",
      "1e400",
      '"\\ud800"',
      "[1e400]",
      '{"\\ud800":1e400}',
      '{"b":1,"2":0,"\\ud800":"\\udc00","a":[]}',
    ],
  },
  {
    name: "Contract.NumberRange",
    schema: Schema.Number.check(Schema.isBetween({ minimum: -1, maximum: 1 })),
    samples: [...numbers, "-0.25", "0.25", "1.0000000000000002"],
  },
  { name: "Contract.Nullable", schema: Schema.NullOr(Schema.String), samples: ["null", '""', '"\\ud800"', "0"] },
  {
    name: "Contract.Metadata",
    schema: Schema.Record(Schema.String, Schema.Unknown),
    samples: ['{"__proto__":1,"constructor":2,"\\ud800":[null,false],"2":0,"1":1}', "{}", "null", "[]", '"x"'],
  },
  {
    name: "Contract.NumericLiteral",
    schema: Schema.Literals([0, 1, 2]),
    samples: ["-0", "1", "2", "3", "1.5", '"1"', "null"],
  },
]


const accepted = (name: string, schema: Schema.Codec<unknown, unknown>, input: string, invalid: string) => ({
  name,
  schema,
  samples: [input, invalid],
})
corpus.push(
  accepted("SessionMessage.Info", SessionMessage.Info, '{"id":"msg_1","type":"system","text":"x","time":{"created":0}}', '{"id":"msg_1","type":"nope","time":{"created":0}}'),
  accepted("SessionMessage.AgentSelected", SessionMessage.AgentSelected, '{"id":"msg_1","type":"agent-switched","agent":"a","time":{"created":0}}', '{"id":"msg_1","type":"agent-switched","agent":"a","time":{"created":0},"artifact":null}'),
  accepted("SessionMessage.ModelSelected", SessionMessage.ModelSelected, '{"id":"msg_1","type":"model-switched","model":{"providerID":"p","id":"m"},"time":{"created":0}}', '{"id":"msg_1","type":"model-switched","model":{"providerID":"p","id":"m"},"time":{"created":0},"previous":null}'),
  accepted("SessionMessage.User", SessionMessage.User, '{"id":"msg_1","type":"user","text":"x","files":[],"agents":[],"time":{"created":0}}', '{"id":"msg_1","type":"user","text":"x","files":[],"agents":[],"time":{"created":0},"consumed":null}'),
  accepted("SessionMessage.Synthetic", SessionMessage.Synthetic, '{"id":"msg_1","type":"synthetic","text":"x","time":{"created":0}}', '{"id":"msg_1","type":"synthetic","text":"x","time":{"created":0},"description":null}'),
  accepted("SessionMessage.System", SessionMessage.System, '{"id":"msg_1","type":"system","text":"x","time":{"created":0}}', '{"id":"msg_1","type":"system","text":"x","time":{"created":0},"text":null}'),
  accepted("SessionMessage.Skill", SessionMessage.Skill, '{"id":"msg_1","type":"skill","skill":"a","name":"n","text":"x","time":{"created":0}}', '{"id":"msg_1","type":"skill","skill":"a","name":"n","text":"x","time":{"created":0},"conflicts":null}'),
  accepted("SessionMessage.Shell", SessionMessage.Shell, '{"id":"msg_1","type":"shell","shellID":"sh_x","command":"x","status":"running","time":{"created":0}}', '{"id":"msg_1","type":"shell","shellID":"sh_x","command":"x","status":"running","time":{"created":0},"exit":null}'),
  accepted("SessionMessage.Assistant", SessionMessage.Assistant, '{"id":"msg_1","type":"assistant","agent":"a","model":{"providerID":"p","id":"m"},"content":[],"time":{"created":0}}', '{"id":"msg_1","type":"assistant","agent":"a","model":{"providerID":"p","id":"m"},"content":[],"time":{"created":0},"finish":null}'),
  accepted("SessionMessage.AssistantContent", SessionMessage.AssistantContent, '{"type":"text","text":"x"}', '{"type":"text","text":"x","phase":"other"}'),
  accepted("SessionMessage.ToolState", SessionMessage.ToolState, '{"status":"streaming","input":"x"}', '{"status":"streaming","input":null}'),
  accepted("SessionMessage.Compaction", SessionMessage.Compaction, '{"id":"msg_1","type":"compaction","status":"pending","jobID":"cmp_x","trigger":"manual","time":{"created":0}}', '{"id":"msg_1","type":"compaction","status":"pending","jobID":"cmp_x","trigger":"unknown","time":{"created":0}}'),
  accepted("SessionMessage.ArtifactProvenance", SessionMessage.ArtifactProvenance, '{"scopeID":"pas_x","versionID":"pav_x","kind":"skill","id":"a","sourceScope":"project"}', '{"scopeID":"bad","versionID":"pav_x","kind":"skill","id":"a","sourceScope":"project"}'),
  accepted("SessionMessage.ProviderState", SessionMessage.ProviderState, JSON.stringify({ ["\ud800"]: null }), '[]'),
  accepted("SessionMessage.AssistantRetry", SessionMessage.AssistantRetry, '{"attempt":1,"at":0,"error":{"type":"e","message":"m"}}', '{"attempt":0,"at":0,"error":{"type":"e","message":"m"}}'),
  accepted("SessionOrchestration.State", SessionOrchestration.State, '"starting"', '"invalid"'),
  accepted("SessionOrchestration.TerminalState", SessionOrchestration.TerminalState, '"completed"', '"running"'),
  accepted("SessionOrchestration.QuestionID", SessionOrchestration.QuestionID, '"qst_x"', '"bad"'),
  accepted("SessionOrchestration.Progress", SessionOrchestration.Progress, '{"text":"x","time":0}', '{"text":"x","time":-1}'),
  accepted("SessionOrchestration.Question", SessionOrchestration.Question, '{"id":"qst_x","text":"x","time":0}', '{"id":"bad","text":"x","time":0}'),
  accepted("SessionOrchestration.Answer", SessionOrchestration.Answer, '{"questionID":"qst_x"}', '{"questionID":"bad"}'),
  accepted("SessionOrchestration.ListAnchor", SessionOrchestration.ListAnchor, '{"rank":0,"updated":0,"sessionID":"ses","direction":"previous"}', '{"rank":6,"updated":0,"sessionID":"ses","direction":"previous"}'),
  accepted("SessionOrchestration.Notification", SessionOrchestration.Notification, '{"id":"n","parentID":"ses","childID":"ses","type":"question","revision":0}', '{"id":"n","parentID":"ses","childID":"ses","type":"other","revision":0}'),
  accepted("SessionRevert.Revert", SessionRevertSchema, '{"messageID":"msg_x"}', '{"messageID":"bad"}'),
  accepted("SessionPending.UserData", SessionPending.UserData, '{"text":"x","files":[],"agents":[]}', '{"text":"x","files":[],"agents":[],"metadata":null}'),
  accepted("SessionPending.SyntheticData", SessionPending.SyntheticData, '{"text":"x"}', '{"text":"x","description":null}'),
  accepted("SessionPending.Message", SessionPending.Message, '{"type":"synthetic","data":{"text":"x"},"delivery":"steer"}', '{"type":"synthetic","data":{"text":"x"},"delivery":"bad"}'),
  accepted("SessionPending.User", SessionPending.User, '{"admittedSeq":0,"id":"msg_x","sessionID":"ses","timeCreated":0,"type":"user","data":{"text":"x"},"delivery":"steer"}', '{"admittedSeq":-1,"id":"msg_x","sessionID":"ses","timeCreated":0,"type":"user","data":{"text":"x"},"delivery":"steer"}'),
  accepted("SessionPending.Synthetic", SessionPending.Synthetic, '{"admittedSeq":0,"id":"msg_x","sessionID":"ses","timeCreated":0,"type":"synthetic","data":{"text":"x"},"delivery":"steer"}', '{"admittedSeq":-1,"id":"msg_x","sessionID":"ses","timeCreated":0,"type":"synthetic","data":{"text":"x"},"delivery":"steer"}'),
  accepted("SessionPending.Info", SessionPending.Info, '{"admittedSeq":0,"id":"msg_x","sessionID":"ses","timeCreated":0,"type":"user","data":{"text":"x","files":[],"agents":[]},"delivery":"steer"}', '{"admittedSeq":-1,"id":"msg_x","sessionID":"ses","timeCreated":0,"type":"user","data":{"text":"x","files":[],"agents":[]},"delivery":"steer"}'),
  accepted("SessionPending.LegacyInfo", SessionPending.LegacyInfo, '{"admittedSeq":0,"id":"msg_x","sessionID":"ses","timeCreated":0,"type":"compaction"}', '{"admittedSeq":-1,"id":"msg_x","sessionID":"ses","timeCreated":0,"type":"compaction"}'),
  accepted("SessionOrchestration.Task", SessionOrchestration.Task, '{"sessionID":"ses","parentID":"ses","description":"x","agent":"a","model":{"providerID":"p","id":"m"},"background":true,"state":"running","revision":0,"time":{"created":0,"updated":0}}', '{"sessionID":"ses","parentID":"ses","description":"x","agent":"a","model":{"providerID":"p","id":"m"},"background":true,"state":"unknown","revision":0,"time":{"created":0,"updated":0}}'),
  accepted("SessionOrchestration.Control", SessionOrchestration.Control, '{"action":"list"}', '{"action":"unknown"}'),
  accepted("SessionOrchestration.Report", SessionOrchestration.Report, '{"action":"progress","text":"x"}', '{"action":"progress","text":"x","data":null}'),
  accepted("SessionOrchestration.Change", SessionOrchestration.Change, '{"type":"started"}', '{"type":"unknown"}'),
  accepted("SessionOrchestration.Page", SessionOrchestration.Page, '{"data":[],"summary":{"total":0,"active":0,"running":0,"waiting":0},"cursor":{}}', '{"data":[],"summary":{"total":0,"active":0,"running":0,"waiting":0},"cursor":{"next":null}}'),
  accepted("SessionOrchestration.TeamView", SessionOrchestration.TeamView, '{"children":[],"omitted":0}', '{"children":[],"omitted":-1}'),
  accepted("SessionSkillStatus.State", SessionSkillStatus.State, '{"state":"inactive","inactiveReason":"compacted"}', '{"state":"inactive","inactiveReason":"invalid"}'),
  accepted("SessionSkillStatus.Conflict", SessionSkillStatus.Conflict, '{"type":"skill","id":"x","name":"n"}', '{"type":"other","id":"x","name":"n"}'),
  accepted("SessionSkillStatus.Info", SessionSkillStatus.Info, '{"id":"x","name":"n","activatedBy":"tool","activationMessageID":"msg_x","content":"c","conflicts":[],"declarations":[],"state":"active"}', '{"id":"x","name":"n","activatedBy":"tool","activationMessageID":"msg_x","content":"c","conflicts":[],"declarations":[],"state":"active","inactiveReason":"compacted"}'),
  accepted("SessionWorkCompletion.Receipt", SessionWorkCompletion.Receipt, '{"id":"evt_x","seq":0,"created":0,"sessionID":"ses","inputID":"msg_x","assistantMessageID":"msg_y"}', '{"id":"evt_x","seq":0,"created":0,"sessionID":"ses","inputID":"msg_x","assistantMessageID":"bad"}'),
  accepted("SessionWorkCompletion.Page", SessionWorkCompletion.Page, '{"data":[]}', '{"data":[],"next":null}'),
)
corpus.push(
  accepted("SessionDelivery.Delivery", SessionDelivery.Delivery, '"steer"', '"deliver"'),
  accepted("SessionError.Error", SessionError.Error, '{"type":"error","message":"\\ud800"}', '{"type":"error"}'),
  accepted("Remote.State", Remote.State, '"connecting"', '"connected"'),
  accepted("Remote.Status", Remote.Status, '{"state":"on","message":null}', '{"state":"bad"}'),
  accepted("KeepAwake.State", KeepAwake.State, '"unsupported"', '"sleep"'),
  accepted("KeepAwake.Status", KeepAwake.Status, '{"state":"on","message":"\\ud800"}', `{"state":"on","message":"${"x".repeat(201)}"}`),
  accepted("FileDiff.Info", FileDiff.Info, '{"file":"f","patch":"p","additions":0,"deletions":1,"status":"modified"}', '{"file":"f","patch":"p","additions":-1,"deletions":1,"status":"modified"}'),
  accepted("FileDiff.LegacyInfo", FileDiff.LegacyInfo, '{"additions":-1.5,"deletions":1e400}', '{"additions":"1","deletions":0}'),
  accepted("Vcs.Mode", Vcs.Mode, '"branch"', '"worktree"'),
  accepted("Vcs.FileStatus", Vcs.FileStatus, '{"file":"f","additions":0,"deletions":0,"status":"added"}', '{"file":"f","additions":1.5,"deletions":0,"status":"added"}'),
  accepted("Vcs.Branch", Vcs.Branch, '{"current":null}', '{"current":1}'),
  accepted("Instruction.Key", Instruction.Key, '"api/foo/bar"', '"API/foo"'),
  accepted("Instruction.Hash", Instruction.Hash, `"${"a".repeat(64)}"`, `"${"g".repeat(64)}"`),
  accepted("Instruction.Values", Instruction.Values, `{"api/foo":"${"a".repeat(64)}"}`, `{"API/foo":"${"a".repeat(64)}"}`),
  accepted("Instruction.Removed", Instruction.Removed, '"removed"', '"delete"'),
  accepted("Instruction.Delta", Instruction.Delta, `{"api/foo":"${"a".repeat(64)}","other":"removed"}`, `{"other":"${"g".repeat(64)}"}`),
  accepted("InstructionEntry.Key", InstructionEntry.Key, '"entry.key-1"', '"Entry"'),
  accepted("InstructionEntry.Info", InstructionEntry.Info, '{"key":"entry","value":{"k":"v"}}', '{"key":"bad/key","value":null}'),
  accepted("InstructionEntry.ValueTooLargeError", InstructionEntry.ValueTooLargeError, '{"_tag":"InstructionEntryValueTooLargeError","actualBytes":8193,"maxBytes":8192,"message":"large"}', '{"_tag":"wrong","actualBytes":1,"maxBytes":2,"message":"x"}'),
  accepted("EventLog.Synced", EventLog.Synced, '{"type":"log.synced","aggregateID":"a","seq":0}', '{"type":"log.synced","aggregateID":"a","seq":-1}'),
  accepted("Workspace.ID", Workspace.ID, '"wrk"', '"bad"'),
  accepted("WorkspaceEvent.ConnectionStatus", WorkspaceEvent.ConnectionStatus, '{"workspaceID":"wrk","status":"connected"}', '{"workspaceID":"wrk","status":"bad"}'),
  accepted("WorkspaceEvent.Ready", WorkspaceEvent.Ready, '{"id":"evt_","created":0,"type":"workspace.ready","data":{"name":"ok"}}', '{"id":"evt_","created":0,"type":"workspace.ready","data":{}}'),
  accepted("WorkspaceEvent.Failed", WorkspaceEvent.Failed, '{"id":"evt_","created":0,"type":"workspace.failed","data":{"message":"bad"}}', '{"id":"evt_","created":0,"type":"workspace.failed","data":{}}'),
  accepted("WorkspaceEvent.Status", WorkspaceEvent.Status, '{"id":"evt_","created":0,"type":"workspace.status","data":{"workspaceID":"wrk","status":"error"}}', '{"id":"evt_","created":0,"type":"workspace.status","data":{"workspaceID":"bad","status":"error"}}'),
  accepted("WorktreeEvent.Ready", WorktreeEvent.Ready, '{"id":"evt_","created":0,"type":"worktree.ready","data":{"name":"n","branch":"b"}}', '{"id":"evt_","created":0,"type":"worktree.ready","data":{"name":1}}'),
  accepted("WorktreeEvent.Failed", WorktreeEvent.Failed, '{"id":"evt_","created":0,"type":"worktree.failed","data":{"message":"bad"}}', '{"id":"evt_","created":0,"type":"worktree.failed","data":{}}'),
  accepted("ServerEvent.Connected", ServerEvent.Connected, '{"id":"evt_","created":0,"type":"server.connected","data":{}}', '{"id":"evt_","created":0,"type":"wrong","data":{}}'),
  accepted("ServerEvent.Disposed", ServerEvent.Disposed, '{"id":"evt_","created":0,"type":"global.disposed","data":{}}', '{"id":"evt_","created":0,"type":"global.disposed","data":null}'),
  accepted("LspEvent.Updated", LspEvent.Updated, '{"id":"evt_","created":0,"type":"lsp.updated","data":{}}', '{"id":"evt_","created":0,"type":"lsp.updated","data":null}'),
  accepted("InstallationEvent.Updated", InstallationEvent.Updated, '{"id":"evt_","created":0,"type":"installation.updated","data":{"version":"1"}}', '{"id":"evt_","created":0,"type":"installation.updated","data":{"version":1}}'),
  accepted("InstallationEvent.UpdateAvailable", InstallationEvent.UpdateAvailable, '{"id":"evt_","created":0,"type":"installation.update-available","data":{"version":"1"}}', '{"id":"evt_","created":0,"type":"installation.update-available","data":{}}'),
  accepted("VcsEvent.BranchUpdated", VcsEvent.BranchUpdated, '{"id":"evt_","created":0,"type":"vcs.branch.updated","data":{"branch":null}}', '{"id":"evt_","created":0,"type":"vcs.branch.updated","data":{"branch":1}}'),
  accepted("SessionTodo.Status", SessionTodo.Status, '"in_progress"', '"started"'),
  accepted("SessionTodo.Priority", SessionTodo.Priority, '"high"', '"urgent"'),
  accepted("SessionTodo.Info", SessionTodo.Info, '{"content":"task","status":"pending","priority":"high"}', '{"content":"task","status":"started","priority":"high"}'),
  accepted("SessionTodo.Event.Updated", SessionTodo.Event.Updated, '{"id":"evt_","created":0,"type":"todo.updated","data":{"sessionID":"ses","todos":[]}}', '{"id":"evt_","created":0,"type":"todo.updated","data":{"sessionID":"bad","todos":[]}}'),
  accepted("SessionStatusEvent.Info", SessionStatusEvent.Info, '{"type":"retry","attempt":0,"message":"m","next":1}', '{"type":"retry","attempt":-1,"message":"m","next":1}'),
  accepted("SessionStatusEvent.Status", SessionStatusEvent.Status, '{"id":"evt_","created":0,"type":"session.status","data":{"sessionID":"ses","status":{"type":"idle"}}}', '{"id":"evt_","created":0,"type":"session.status","data":{"sessionID":"bad","status":{"type":"idle"}}}'),
  accepted("SessionStatusEvent.Idle", SessionStatusEvent.Idle, '{"id":"evt_","created":0,"type":"session.idle","data":{"sessionID":"ses"}}', '{"id":"evt_","created":0,"type":"session.idle","data":{}}'),
  accepted("SessionCompactionEvent.Compacted", SessionCompactionEvent.Compacted, '{"id":"evt_","created":0,"type":"session.compacted","data":{"sessionID":"ses"}}', '{"id":"evt_","created":0,"type":"session.compacted","data":{"sessionID":"wrk"}}'),
  accepted("TuiEvent.PromptAppend", TuiEvent.PromptAppend, '{"id":"evt_","created":0,"type":"tui.prompt.append","data":{"text":"\\ud800"}}', '{"id":"evt_","created":0,"type":"tui.prompt.append","data":{"text":null}}'),
  accepted("TuiEvent.CommandExecute", TuiEvent.CommandExecute, '{"id":"evt_","created":0,"type":"tui.command.execute","data":{"command":"anything"}}', '{"id":"evt_","created":0,"type":"tui.command.execute","data":{"command":1}}'),
  accepted("TuiEvent.ToastShow", TuiEvent.ToastShow, '{"id":"evt_","created":0,"type":"tui.toast.show","data":{"message":"m","variant":"info"}}', '{"id":"evt_","created":0,"type":"tui.toast.show","data":{"message":"m","variant":"bad"}}'),
  accepted("TuiEvent.SessionSelect", TuiEvent.SessionSelect, '{"id":"evt_","created":0,"type":"tui.session.select","data":{"sessionID":"ses"}}', '{"id":"evt_","created":0,"type":"tui.session.select","data":{"sessionID":"bad"}}'),
)


corpus.push(
  accepted("Skill.ID", Skill.ID, '"\\ud800"', '1'),
  accepted("Skill.Name", Skill.Name, '"name"', 'false'),
  accepted("Skill.Conflicts", Skill.Conflicts, '{"skills":["\\ud800"],"instructions":["api/x/y"]}', '{"skills":[],"instructions":["BAD"]}'),
  accepted("Skill.DirectorySource", Skill.DirectorySource, '{"type":"directory","path":"\\ud800"}', '{"type":"directory","path":1}'),
  accepted("Skill.UrlSource", Skill.UrlSource, '{"type":"url","url":""}', '{"type":"wrong","url":""}'),
  accepted("Skill.Info", Skill.Info, '{"id":"x","name":"n","location":"","content":"\\ud800"}', '{"id":"x","name":"n","location":""}'),
  accepted("Skill.EmbeddedSource", Skill.EmbeddedSource, '{"type":"embedded","skill":{"id":"x","name":"n","location":"","content":""}}', '{"type":"embedded","skill":{}}'),
  accepted("Skill.Source", Skill.Source, '{"type":"url","url":"x"}', '{"type":"other"}'),
  accepted("Reference.LocalSource", Reference.LocalSource, '{"type":"local","path":"","hidden":false}', '{"type":"local","path":null}'),
  accepted("Reference.GitSource", Reference.GitSource, '{"type":"git","repository":"r","branch":null}', '{"type":"git","repository":1}'),
  accepted("Reference.Source", Reference.Source, '{"type":"git","repository":"r"}', '{"type":"bad","repository":"r"}'),
  accepted("Reference.Info", Reference.Info, '{"name":"n","path":"","source":{"type":"local","path":""}}', '{"name":"n","path":"","source":{}}'),
  accepted("Plugin.ID", Plugin.ID, '"\\ud800"', '1'),
  accepted("Plugin.Info", Plugin.Info, '{"id":"x"}', '{}'),
  accepted("Plugin.Event.Added", Plugin.Event.Added, '{"id":"evt_","created":0,"type":"plugin.added","data":{"id":"x"}}', '{"id":"evt_","created":0,"type":"plugin.added","data":{}}'),
  accepted("Plugin.Event.Updated", Plugin.Event.Updated, '{"id":"evt_","created":0,"type":"plugin.updated","data":{}}', '{"id":"evt_","created":0,"type":"bad","data":{}}'),
  accepted("Project.ID", Project.ID, '"global"', '1'),
  accepted("Project.Vcs", Project.Vcs, '"git"', '"svn"'),
  accepted("Project.Current", Project.Current, '{"id":"global","directory":""}', '{"id":"bad","directory":""}'),
  accepted("Project.Directory", Project.Directory, '{"directory":"","strategy":null}', '{"directory":1}'),
  accepted("Project.DirectoriesInput", Project.DirectoriesInput, '{"projectID":"global"}', '{"projectID":"bad"}'),
  accepted("Project.Directories", Project.Directories, '[{"directory":""}]', '[{"directory":1}]'),
  accepted("Project.InventoryEntry", Project.InventoryEntry, '{"projectID":"global","projectWorktree":"","directory":"","sessions":0,"timeActive":1,"available":true}', '{"projectID":"bad"}'),
  accepted("Project.InventoryAnchor", Project.InventoryAnchor, '{"projectWorktree":"","projectID":"global","directory":""}', '{"projectWorktree":"","projectID":"bad","directory":""}'),
  accepted("Project.Icon", Project.Icon, '{"url":null,"override":"","color":"red"}', '{"url":1}'),
  accepted("Project.Commands", Project.Commands, '{"start":""}', '{"start":false}'),
  accepted("Project.Time", Project.Time, '{"created":0,"updated":1,"initialized":null}', '{"created":-1,"updated":1}'),
  accepted("Project.Info", Project.Info, '{"id":"global","worktree":"w","time":{"created":0,"updated":0},"sandboxes":[]}', '{"id":"bad","worktree":"w","time":{"created":0,"updated":0},"sandboxes":[]}'),
  accepted("Project.Event.Updated", Project.Event.Updated, '{"id":"evt_","created":0,"type":"project.updated","data":{"id":"global","worktree":"w","time":{"created":0,"updated":0},"sandboxes":[]}}', '{"id":"evt_","created":0,"type":"project.updated","data":{}}'),
  accepted("ProjectDirectories.Event.Updated", ProjectDirectories.Event.Updated, '{"id":"evt_","created":0,"type":"project.directories.updated","data":{"projectID":"global"}}', '{"id":"evt_","created":0,"type":"project.directories.updated","data":{"projectID":"bad"}}'),
  accepted("ProjectCopy.StrategyID", ProjectCopy.StrategyID, '"\\t strategy \\n"', '"\\t\\n"'),
  accepted("ProjectCopy.CreateInput", ProjectCopy.CreateInput, '{"projectID":"global","strategy":" x ","sourceDirectory":"","directory":"","name":null}', '{"projectID":"bad","strategy":"x","sourceDirectory":"","directory":""}'),
  accepted("ProjectCopy.RemoveInput", ProjectCopy.RemoveInput, '{"projectID":"global","directory":"","force":false}', '{"projectID":"global","directory":"","force":0}'),
  accepted("ProjectCopy.Copy", ProjectCopy.Copy, '{"directory":""}', '{"directory":null}'),
  accepted("SessionCompaction.ID", SessionCompaction.ID, '"cmp_"', '"cmp"'),
  accepted("SessionCompaction.Trigger", SessionCompaction.Trigger, '"manual"', '"automatic"'),
  accepted("SessionCompaction.FailureCode", SessionCompaction.FailureCode, '"provider_failed"', '"unknown"'),
  accepted("SessionCompaction.Boundary", SessionCompaction.Boundary, '{"messageID":"msg_","seq":0}', '{"messageID":"bad","seq":0}'),
  accepted("SessionCompaction.Metrics", SessionCompaction.Metrics, '{"excludedMessages":0,"excludedParts":1,"inputTokens":2,"retainedTokens":3}', '{"excludedMessages":-1,"excludedParts":1,"inputTokens":2,"retainedTokens":3}'),
  accepted("SessionCompaction.Pressure", SessionCompaction.Pressure, '{"estimatedInputTokens":0,"safeInputTokens":1}', '{"estimatedInputTokens":0,"safeInputTokens":-1}'),
  accepted("SessionCompaction.Admission", SessionCompaction.Admission, '{"id":"cmp_1","sessionID":"ses","trigger":"manual","status":"pending","requestedThrough":{"messageID":"msg_","seq":0},"timeCreated":1.5}', '{"id":"bad","sessionID":"ses","trigger":"manual","status":"pending","requestedThrough":{"messageID":"msg_","seq":0},"timeCreated":1}'),
  accepted("SessionCompaction.HistoryJob", SessionCompaction.HistoryJob, '{"jobID":"cmp_1","trigger":"manual","status":"completed","created":0,"metrics":{"excludedMessages":0,"excludedParts":1,"inputTokens":2,"retainedTokens":3}}', '{"jobID":"cmp_1","trigger":"manual","status":"running","created":-1}'),
  accepted("SessionCompaction.History", SessionCompaction.History, '{"data":[{"jobID":"cmp_1","trigger":"manual","status":"failed","created":1,"code":"provider_failed"}],"truncated":true,"completedBefore":2,"completedCount":3,"totalSavedTokens":-4}', '{"data":[],"truncated":"no","completedBefore":0,"completedCount":0,"totalSavedTokens":0}'),
  accepted("SessionCapturedChanges.Input", SessionCapturedChanges.Input, '{"id":"msg_1","type":"assistant","metadata":{"kind":"k","questionID":"q"},"content":[{"type":"tool","id":"call","name":"edit","state":{"status":"completed","input":{"questionID":"q"},"structured":{"files":[{"file":"a.ts","patch":"@@ p","status":"modified"}],"sessionID":"ses","action":"launch","task":{"sessionID":"ses"}}}}]}', '{"id":"bad","type":"assistant"}'),
  accepted("SessionCapturedChanges.Page", SessionCapturedChanges.Page, '{"data":[{"id":"msg_1","type":"user"},{"id":"msg_2","type":"synthetic"}],"next":2}', '{"data":[],"next":-1}'),
  accepted("SessionCompaction.Result", SessionCompaction.Result, '{"id":"cmp_1","sessionID":"ses","trigger":"manual","status":"failed","requestedThrough":{"messageID":"msg_","seq":0},"timeCreated":1,"failure":"provider_failed"}', '{"id":"cmp_1","sessionID":"ses","trigger":"manual","status":"failed","requestedThrough":{"messageID":"msg_","seq":0},"timeCreated":1,"failure":"oops"}'),
  accepted("Telemetry.NoticeVersion", Telemetry.NoticeVersion, '1', '2'),
  accepted("Telemetry.Consent", Telemetry.Consent, '{"enabled":true,"noticeVersion":1,"decidedAt":0}', '{"enabled":true,"noticeVersion":1,"decidedAt":-1}'),
  accepted("Telemetry.ConsentState", Telemetry.ConsentState, '{"noticeVersion":1}', '{"noticeVersion":2}'),
  accepted("Telemetry.ConsentInput", Telemetry.ConsentInput, '{"enabled":false,"noticeVersion":1}', '{"enabled":false,"noticeVersion":1,"other":0}'),
  accepted("Telemetry.TelemetryDisabled", Telemetry.TelemetryDisabled, '{"_tag":"TelemetryDisabled"}', '{"_tag":"Other"}'),
  accepted("Telemetry.Operation", Telemetry.Operation, '"session.list"', '"session.remove"'),
  accepted("Telemetry.RequestSample", Telemetry.RequestSample, '{"kind":"request","at":"2024-03-01T12:34:56.789Z","operation":"session.list","outcome":"ok","queueMs":0,"totalMs":600000}', '{"kind":"request","at":"2024-03-01","operation":"session.list","outcome":"ok","queueMs":0,"totalMs":1}'),
  accepted("Telemetry.LongTaskSample", Telemetry.LongTaskSample, '{"kind":"long-task","at":"2024-03-01T12:34:56.789Z","durationMs":50}', '{"kind":"long-task","at":"2024-03-01T12:34:56.789Z","durationMs":49}'),
  accepted("Telemetry.ClientSample", Telemetry.ClientSample, '{"kind":"client","at":"2024-03-01T12:34:56.789Z","surface":"web","metric":"stream.delay","durationMs":0}', '{"kind":"client","at":"2024-03-01T12:34:56.789Z","surface":"other","metric":"stream.delay","durationMs":0}'),
  accepted("Telemetry.Sample", Telemetry.Sample, '{"kind":"client","at":"2024-03-01T12:34:56.789Z","surface":"tui","metric":"prompt.admit","durationMs":1}', '{"kind":"unknown"}'),
  accepted("Telemetry.Batch", Telemetry.Batch, '{"samples":[{"kind":"long-task","at":"2024-03-01T12:34:56.789Z","durationMs":50}]}', '{"samples":[]}'),
  accepted("Telemetry.Page", Telemetry.Page, '{"data":[{"receivedAt":0,"sample":{"kind":"client","at":"2024-03-01T12:34:56.789Z","surface":"web","metric":"stream.delay","durationMs":1}}],"cursor":{}}', '{"data":[],"cursor":[]}'),
  accepted("FileSystem.Entry", FileSystem.Entry, '{"path":"\\ud800","type":"file"}', '{"path":"x","type":"symlink"}'),
  accepted("FileSystem.Submatch", FileSystem.Submatch, '{"text":"\\ud800","start":0,"end":1}', '{"text":"x","start":-1,"end":1}'),
  accepted("FileSystem.Match", FileSystem.Match, '{"entry":{"path":"x","type":"file"},"line":1,"offset":0,"text":"x","submatches":[]}', '{"entry":{"path":"x","type":"file"},"line":0,"offset":0,"text":"x","submatches":[]}'),
  accepted("FileSystem.FindInput", FileSystem.FindInput, '{"query":"x","type":"directory","limit":1}', '{"query":"x","limit":0}'),
  accepted("FileSystem.Event.Changed", FileSystem.Event.Changed, '{"id":"evt_","created":0,"type":"filesystem.changed","data":{"file":"x","event":"unlink"}}', '{"id":"evt_","created":0,"type":"filesystem.changed","data":{"file":"x","event":"remove"}}'),
)


corpus.push(
  accepted("Form.ID", Form.ID, '"frm_x"', '"frm"'),
  accepted("Form.Metadata", Form.Metadata, '{"\\ud800":[null,false]}', '[]'),
  accepted("Form.Option", Form.Option, '{"value":"v","label":"l","description":"\\ud800"}', '{"value":"v"}'),
  accepted("Form.When", Form.When, '{"key":"k","op":"neq","value":false}', '{"key":"k","op":"other","value":"x"}'),
  accepted("Form.StringField", Form.StringField, '{"key":"k","type":"string","minLength":0,"format":"date-time"}', '{"key":"k","type":"string","minLength":-1}'),
  accepted("Form.NumberField", Form.NumberField, '{"key":"k","type":"number","minimum":-1.5,"default":1e400}', '{"key":"k","type":"number","default":"1"}'),
  accepted("Form.IntegerField", Form.IntegerField, '{"key":"k","type":"integer","minimum":1.5}', '{"key":"k","type":"number"}'),
  accepted("Form.BooleanField", Form.BooleanField, '{"key":"k","type":"boolean","default":false}', '{"key":"k","type":"boolean","default":0}'),
  accepted("Form.MultiselectField", Form.MultiselectField, '{"key":"k","type":"multiselect","options":[],"minItems":0,"default":[]}', '{"key":"k","type":"multiselect"}'),
  accepted("Form.ExternalField", Form.ExternalField, '{"key":"k","type":"external","url":""}', '{"key":"k","type":"external","url":1}'),
  accepted("Form.Field", Form.Field, '{"key":"k","type":"string","custom":true}', '{"key":"k","type":"missing"}'),
  accepted("Form.Fields", Form.Fields, '[{"key":"k","type":"boolean"}]', '[]'),
  accepted("Form.Info", Form.Info, '{"id":"frm_x","sessionID":"global","title":"t","fields":[{"key":"k","type":"external","url":""}]}', '{"id":"bad","sessionID":"global","title":"t","fields":[{"key":"k","type":"boolean"}]}'),
  accepted("Form.Value", Form.Value, '["a","\\ud800"]', '{"nested":true}'),
  accepted("Form.Answer", Form.Answer, '{"x":["a"],"y":true}', '{"x":{"bad":1}}'),
  accepted("Form.State", Form.State, '{"status":"answered","answer":{"x":1}}', '{"status":"unknown"}'),
  accepted("Form.Reply", Form.Reply, '{"answer":{"x":"y"}}', '{"answer":[]}'),
  accepted("Form.Event.Created", Form.Event.Created, '{"id":"evt_","created":0,"type":"form.created","data":{"form":{"id":"frm_x","sessionID":"global","title":"t","fields":[{"key":"k","type":"boolean"}]}}}', '{"id":"evt_","created":0,"type":"form.created","data":{"form":{}}}'),
  accepted("Form.Event.Replied", Form.Event.Replied, '{"id":"evt_","created":0,"type":"form.replied","data":{"id":"frm_x","sessionID":"global","answer":{}}}', '{"id":"evt_","created":0,"type":"form.replied","data":{"id":"bad","sessionID":"global","answer":{}}}'),
  accepted("Form.Event.Cancelled", Form.Event.Cancelled, '{"id":"evt_","created":0,"type":"form.cancelled","data":{"id":"frm_x","sessionID":"global"}}', '{"id":"evt_","created":0,"type":"form.cancelled","data":{"id":"bad","sessionID":"global"}}'),
  accepted("Question.ID", Question.ID, '"query"', '1'),
  accepted("Question.Option", Question.Option, '{"label":"x","description":"d"}', '{"label":"x"}'),
  accepted("Question.Info", Question.Info, '{"question":"q","header":"h","options":[],"custom":false}', '{"question":"q","header":"h"}'),
  accepted("Question.Prompt", Question.Prompt, '{"question":"q","header":"h","options":[]}', '{"question":"q","header":"h","options":null}'),
  accepted("Question.Tool", Question.Tool, '{"messageID":"m","callID":"c"}', '{"messageID":"m"}'),
  accepted("Question.Request", Question.Request, '{"id":"que","sessionID":"ses","questions":[],"tool":{"messageID":"m","callID":"c"}}', '{"id":"q","sessionID":"ses","questions":[]}'),
  accepted("Question.Answer", Question.Answer, '["x","\\ud800"]', '[1]'),
  accepted("Question.Reply", Question.Reply, '{"answers":[["x"],[]]}', '{"answers":[[false]]}'),
  accepted("Question.Event.Asked", Question.Event.Asked, '{"id":"evt_","created":0,"type":"question.asked","data":{"id":"que","sessionID":"ses","questions":[]}}', '{"id":"evt_","created":0,"type":"question.asked","data":{"id":"bad","sessionID":"ses","questions":[]}}'),
  accepted("Question.Event.Replied", Question.Event.Replied, '{"id":"evt_","created":0,"type":"question.replied","data":{"sessionID":"ses","requestID":"que","answers":[]}}', '{"id":"evt_","created":0,"type":"question.replied","data":{"sessionID":"bad","requestID":"que","answers":[]}}'),
  accepted("Question.Event.Rejected", Question.Event.Rejected, '{"id":"evt_","created":0,"type":"question.rejected","data":{"sessionID":"ses","requestID":"que"}}', '{"id":"evt_","created":0,"type":"question.rejected","data":{"sessionID":"ses","requestID":"bad"}}'),
  accepted("Guardrail.RequestID", Guardrail.RequestID, '"grq_x"', '"grq"'),
  accepted("Guardrail.RuleSource", Guardrail.RuleSource, '"custom"', '"generated"'),
  accepted("Guardrail.RuleDecision", Guardrail.RuleDecision, '"hard_review"', '"review"'),
  accepted("Guardrail.Decision", Guardrail.Decision, '"cap_exceeded"', '"hard_review"'),
  accepted("Guardrail.Rule", Guardrail.Rule, '{"id":"x","source":"standard","decision":"ask","actions":["a"],"resources":["r"],"reason":"r","priority":-1}', '{"id":"x","source":"standard","decision":"ask","actions":[],"resources":["r"],"reason":"r","priority":0}'),
  accepted("Guardrail.Ruleset", Guardrail.Ruleset, '[{"id":"x","source":"custom","decision":"allow","actions":["a"],"resources":["r"],"reason":"r","priority":0}]', '[null]'),
  accepted("Guardrail.Risk", Guardrail.Risk, '{"level":4,"label":"x","score":1e400,"metric":"probability"}', '{"level":5,"label":"x","score":0,"metric":"confidence"}'),
  accepted("Guardrail.Request", Guardrail.Request, '{"id":"grq_x","rootSessionID":"ses","sessionID":"ses","action":"a","resources":[],"ruleIDs":[],"reason":"r","standard":false,"metadata":{"x":1}}', '{"id":"bad","rootSessionID":"ses","sessionID":"ses","action":"a","resources":[],"ruleIDs":[],"reason":"r","standard":false}'),
  accepted("Guardrail.Reply", Guardrail.Reply, '"once"', '"session"'),
  accepted("Guardrail.Counter", Guardrail.Counter, '{"id":"x","current":0,"limit":1,"scope":"family"}', '{"id":"x","current":-1,"limit":1,"scope":"family"}'),
  accepted("Guardrail.Status", Guardrail.Status, '{"rootSessionID":"ses","profile":"p","customRules":0,"approvals":1,"blocked":0,"counters":[],"invalidFiles":[]}', '{"rootSessionID":"bad","profile":"p","customRules":0,"approvals":1,"blocked":0,"counters":[],"invalidFiles":[]}'),
  accepted("Guardrail.Event.Asked", Guardrail.Event.Asked, '{"id":"evt_","created":0,"type":"guardrail.asked","data":{"id":"grq_x","rootSessionID":"ses","sessionID":"ses","action":"a","resources":[],"ruleIDs":[],"reason":"r","standard":false}}', '{"id":"evt_","created":0,"type":"guardrail.asked","data":{}}'),
  accepted("Guardrail.Event.Replied", Guardrail.Event.Replied, '{"id":"evt_","created":0,"type":"guardrail.replied","data":{"rootSessionID":"ses","sessionID":"ses","requestID":"grq_x","reply":"always"}}', '{"id":"evt_","created":0,"type":"guardrail.replied","data":{"rootSessionID":"bad","sessionID":"ses","requestID":"grq_x","reply":"always"}}'),
  accepted("Guardrail.Event.Decided", Guardrail.Event.Decided, '{"id":"evt_","created":0,"type":"guardrail.decided","data":{"rootSessionID":"ses","sessionID":"ses","action":"a","ruleIDs":[],"decision":"deny"}}', '{"id":"evt_","created":0,"type":"guardrail.decided","data":{"rootSessionID":"bad","sessionID":"ses","action":"a","ruleIDs":[],"decision":"deny"}}'),
  accepted("Shell.ID", Shell.ID, '"sh_x"', '"sh"'),
  accepted("Shell.Status", Shell.Status, '"memory-limit"', '"paused"'),
  accepted("Shell.MemoryLimitMb", Shell.MemoryLimitMb, '1048576', '1048577'),
  accepted("Shell.Time", Shell.Time, '{"started":-1.5,"completed":1e400}', '{"started":"1"}'),
  accepted("Shell.Metadata", Shell.Metadata, '{"\\ud800":[null,false]}', '[]'),
  accepted("Shell.Info", Shell.Info, '{"id":"sh_x","status":"running","command":"c","cwd":"","shell":"sh","file":"f","metadata":{},"time":{"started":0}}', '{"id":"sh","status":"running","command":"c","cwd":"","shell":"sh","file":"f","metadata":{},"time":{"started":0}}'),
  accepted("Shell.Event.Created", Shell.Event.Created, '{"id":"evt_","created":0,"type":"shell.created","data":{"info":{"id":"sh_x","status":"running","command":"c","cwd":"","shell":"sh","file":"f","metadata":{},"time":{"started":0}}}}', '{"id":"evt_","created":0,"type":"shell.created","data":{}}'),
  accepted("Shell.Event.Exited", Shell.Event.Exited, '{"id":"evt_","created":0,"type":"shell.exited","data":{"id":"sh_x","exit":null,"status":"timeout"}}', '{"id":"evt_","created":0,"type":"shell.exited","data":{"id":"sh_x","status":"bad"}}'),
  accepted("Shell.Event.Deleted", Shell.Event.Deleted, '{"id":"evt_","created":0,"type":"shell.deleted","data":{"id":"sh_x"}}', '{"id":"evt_","created":0,"type":"shell.deleted","data":{"id":"bad"}}'),
  accepted("Shell.CreateInput", Shell.CreateInput, '{"command":"x","timeout":0,"memoryLimitMb":1048576}', '{"command":"x","timeout":0,"memoryLimitMb":1048577}'),
  accepted("Shell.OutputInput", Shell.OutputInput, '{"cursor":0,"limit":0}', '{"cursor":-1}'),
  accepted("Shell.Output", Shell.Output, '{"output":"\\ud800","cursor":0,"size":0,"truncated":false}', '{"output":"x","cursor":0,"size":0,"truncated":0}'),
  accepted("Pty.ID", Pty.ID, '"ptyx"', '1'),
  accepted("Pty.Generation", Pty.Generation, '1', '0'),
  accepted("Pty.Offset", Pty.Offset, '0', '-1'),
  accepted("Pty.Size", Pty.Size, '{"rows":200,"cols":500}', '{"rows":201,"cols":500}'),
  accepted("Pty.Actor", Pty.Actor, '"agent"', '"system"'),
  accepted("Pty.ControlOwner", Pty.ControlOwner, '"paused"', '"system"'),
  accepted("Pty.Access", Pty.Access, '"control"', '"read"'),
  accepted("Pty.Info", Pty.Info, '{"id":"ptyx","title":"t","command":"c","args":[],"cwd":"","sessionID":"ses","status":"running","pid":0,"generation":1,"size":{"rows":1,"cols":1},"control":{"owner":"agent","fence":1},"output":{"startOffset":0,"endOffset":0,"truncated":false},"limits":{"maxRuntimeSeconds":7200,"maxRetainedBytes":2097152,"maxInputBytes":65536}}', '{"id":"bad","title":"t","command":"c","args":[],"cwd":"","sessionID":"ses","status":"running","pid":0,"generation":1,"size":{"rows":1,"cols":1},"control":{"owner":"agent","fence":1},"output":{"startOffset":0,"endOffset":0,"truncated":false},"limits":{"maxRuntimeSeconds":7200,"maxRetainedBytes":2097152,"maxInputBytes":65536}}'),
  accepted("Pty.Event.Created", Pty.Event.Created, '{"id":"evt_","created":0,"type":"pty.created","data":{"info":{"id":"ptyx","title":"t","command":"c","args":[],"cwd":"","sessionID":"ses","status":"running","pid":0,"generation":1,"size":{"rows":1,"cols":1},"control":{"owner":"agent","fence":1},"output":{"startOffset":0,"endOffset":0,"truncated":false},"limits":{"maxRuntimeSeconds":7200,"maxRetainedBytes":2097152,"maxInputBytes":65536}}}}', '{"id":"evt_","created":0,"type":"pty.created","data":{}}'),
  accepted("Pty.Event.Updated", Pty.Event.Updated, '{"id":"evt_","created":0,"type":"pty.updated","data":{"info":{"id":"ptyx","title":"t","command":"c","args":[],"cwd":"","sessionID":"ses","status":"running","pid":0,"generation":1,"size":{"rows":1,"cols":1},"control":{"owner":"agent","fence":1},"output":{"startOffset":0,"endOffset":0,"truncated":false},"limits":{"maxRuntimeSeconds":7200,"maxRetainedBytes":2097152,"maxInputBytes":65536}}}}', '{"id":"evt_","created":0,"type":"pty.updated","data":{}}'),
  accepted("Pty.Event.Exited", Pty.Event.Exited, '{"id":"evt_","created":0,"type":"pty.exited","data":{"id":"ptyx","exitCode":0,"reason":"timeout"}}', '{"id":"evt_","created":0,"type":"pty.exited","data":{"id":"ptyx","exitCode":0,"reason":"terminated"}}'),
  accepted("Pty.Event.Deleted", Pty.Event.Deleted, '{"id":"evt_","created":0,"type":"pty.deleted","data":{"id":"ptyx"}}', '{"id":"evt_","created":0,"type":"pty.deleted","data":{"id":"bad"}}'),
  accepted("Pty.CreateInput", Pty.CreateInput, '{"sessionID":"ses","size":{"rows":1,"cols":1},"maxRuntimeSeconds":7200}', '{"sessionID":"bad","size":{"rows":1,"cols":1}}'),
  accepted("Pty.UpdateInput", Pty.UpdateInput, '{"sessionID":"ses","generation":1,"expectedFence":1,"actor":"user","title":"t"}', '{"sessionID":"ses","generation":0,"expectedFence":1,"actor":"user"}'),
  accepted("Pty.OwnerInput", Pty.OwnerInput, '{"sessionID":"ses"}', '{"sessionID":"bad"}'),
  accepted("Pty.ControlInput", Pty.ControlInput, '{"sessionID":"ses","generation":1,"expectedFence":1,"action":"take"}', '{"sessionID":"ses","generation":1,"expectedFence":1,"action":"stop"}'),
  accepted("Pty.ConnectInput", Pty.ConnectInput, '{"sessionID":"ses","access":"inspect","generation":1,"expectedFence":null}', '{"sessionID":"ses","access":"bad","generation":1}'),
  accepted("PtyTicket.ConnectToken", PtyTicket.ConnectToken, '{"ticket":"t","expires_in":1,"access":"control","generation":1,"fence":null}', '{"ticket":"t","expires_in":0,"access":"control","generation":1}'),
)


const tab='{"id":"btab_x","sessionID":"ses","title":"t","page":{"origin":"https://example.com","path":"/"},"status":"shared","generation":1,"documentGeneration":1,"observationRevision":0}'
const eventBase='"id":"evt_","created":0'
corpus.push(
  accepted("Mcp.TimeoutConfig", Mcp.TimeoutConfig, '{"startup":1,"catalog":2,"execution":3}', '{"startup":0}'),
  accepted("Mcp.LocalConfig", Mcp.LocalConfig, '{"type":"local","command":["x"],"environment":{"A":"B"},"timeout":{"startup":1}}', '{"type":"local","command":"x"}'),
  accepted("Mcp.OAuthConfig", Mcp.OAuthConfig, '{"client_id":"x","callback_port":65535}', '{"callback_port":65536}'),
  accepted("Mcp.RemoteConfig", Mcp.RemoteConfig, '{"type":"remote","url":"x","oauth":false,"codemode":true}', '{"type":"remote"}'),
  accepted("Mcp.ServerConfig", Mcp.ServerConfig, '{"type":"remote","url":"x","headers":{"A":"B"}}', '{"type":"other","url":"x"}'),
  accepted("Mcp.Status", Mcp.Status, '{"status":"needs_client_registration","error":"e"}', '{"status":"failed"}'),
  accepted("Mcp.Server", Mcp.Server, '{"name":"n","status":{"status":"connected"},"integrationID":"int_"}', '{"name":"n","status":{"status":"connected"},"integrationID":"bad"}'),
  accepted("Mcp.Resource", Mcp.Resource, '{"server":"s","name":"n","uri":"u","mimeType":"m"}', '{"server":"s","name":"n","uri":1}'),
  accepted("Mcp.ResourceTemplate", Mcp.ResourceTemplate, '{"server":"s","name":"n","uriTemplate":"u"}', '{"server":"s","name":"n"}'),
  accepted("Mcp.ResourceCatalog", Mcp.ResourceCatalog, '{"resources":[],"templates":[]}', '{"resources":[]}'),
  accepted("Mcp.ResourceContentPart", Mcp.ResourceContentPart, '{"type":"text","uri":"u","text":"x","blob":"ignored"}', '{"type":"other","uri":"u"}'),
  accepted("Mcp.ResourceContent", Mcp.ResourceContent, '{"server":"s","uri":"u","contents":[{"type":"blob","uri":"u","blob":"AA=="}]}', '{"server":"s","uri":"u","contents":[{"type":"text","uri":"u"}]}'),
  accepted("McpSkill.Digest", McpSkill.Digest, `"sha256:${"a".repeat(64)}"`, `"sha256:${"g".repeat(64)}"`),
  accepted("McpSkill.ResourceEntry", McpSkill.ResourceEntry, `{"uri":"u","digest":"sha256:${"a".repeat(64)}","size":0}`, '{"uri":"u","digest":"bad","size":0}'),
  accepted("McpSkill.Entry", McpSkill.Entry, '{"server":"s","uri":"u","frontmatter":{"description":"d","extra":0,"name":"n"},"resources":"dynamic"}', '{"server":"s","uri":"u","frontmatter":{"name":"n"},"resources":"dynamic"}'),
  accepted("McpSkill.Capability", McpSkill.Capability, '{"directoryRead":false}', '{"directoryRead":0}'),
  accepted("McpSkill.File", McpSkill.File, '{"server":"s","uri":"u","size":0,"text":"t","blob":"ignored"}', '{"server":"s","uri":"u","size":0}'),
  accepted("McpSkill.Reason", McpSkill.Reason, '"frontmatter-missing"', '"other"'),
  accepted("McpEvent.ToolsChanged", McpEvent.ToolsChanged, `{${eventBase},"type":"mcp.tools.changed","data":{"server":"s"}}`, `{${eventBase},"type":"mcp.tools.changed","data":{}}`),
  accepted("McpEvent.ResourcesChanged", McpEvent.ResourcesChanged, `{${eventBase},"type":"mcp.resources.changed","data":{"server":"s"}}`, `{${eventBase},"type":"mcp.resources.changed","data":{}}`),
  accepted("McpEvent.BrowserOpenFailed", McpEvent.BrowserOpenFailed, `{${eventBase},"type":"mcp.browser.open.failed","data":{"mcpName":"s","url":"u"}}`, `{${eventBase},"type":"mcp.browser.open.failed","data":{"mcpName":"s"}}`),
  accepted("McpEvent.StatusChanged", McpEvent.StatusChanged, `{${eventBase},"type":"mcp.status.changed","data":{"server":"s"}}`, `{${eventBase},"type":"mcp.status.changed","data":{}}`),
  accepted("Browser.TabID", Browser.TabID, '"btab_x"', '"bad"'),
  accepted("Browser.Generation", Browser.Generation, '1', '0'),
  accepted("Browser.DocumentGeneration", Browser.DocumentGeneration, '1', '0'),
  accepted("Browser.ObservationRevision", Browser.ObservationRevision, '0', '-1'),
  accepted("Browser.CallID", Browser.CallID, '"x"', '""'),
  accepted("Browser.Page", Browser.Page, '{"origin":"https://[::1]:443","path":"/a\\ud800"}', '{"origin":"ftp://x","path":"/"}'),
  accepted("Browser.TabStatus", Browser.TabStatus, '"unavailable"', '"shared-now"'),
  accepted("Browser.PauseReason", Browser.PauseReason, '"user_active"', '"idle"'),
  accepted("Browser.Tab", Browser.Tab, `${tab.slice(0,-1)},"mode":"profile","lease":"other"}`, `${tab.replace('"shared"','"invalid"')}`),
  accepted("Browser.BridgeState", Browser.BridgeState, '"pairing"', '"ready"'),
  accepted("Browser.Status", Browser.Status, '{"state":"connected","extensionID":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","paired":false}', '{"state":"connected","extensionID":"z1234567890123456789012345678901"}'),
  accepted("Browser.Pairing", Browser.Pairing, `{"secret":"${"x".repeat(32)}","expiresAt":0}`, '{"secret":"short","expiresAt":0}'),
  accepted("Browser.Element", Browser.Element, '{"ref":"b1","role":"button","name":"n","disabled":false}', '{"ref":"b0","role":"button","name":"n"}'),
  accepted("Browser.Observation", Browser.Observation, `{"tabID":"btab_x","generation":1,"documentGeneration":1,"revision":0,"title":"t","page":{"origin":"https://x","path":"/"},"elements":[],"truncated":false}`, '{"tabID":"bad","generation":1,"documentGeneration":1,"revision":0,"title":"t","page":{"origin":"https://x","path":"/"},"elements":[],"truncated":false}'),
  accepted("Browser.Navigate", Browser.Navigate, '{"type":"navigate","url":"x"}', '{"type":"navigate","url":1}'),
  accepted("Browser.Click", Browser.Click, '{"type":"click","ref":"b1"}', '{"type":"click","ref":"b0"}'),
  accepted("Browser.Type", Browser.Type, '{"type":"type","ref":"b1","text":"\\ud800"}', '{"type":"type","ref":"b1"}'),
  accepted("Browser.Scroll", Browser.Scroll, '{"type":"scroll","deltaY":-10000}', '{"type":"scroll","deltaY":10001}'),
  accepted("Browser.Capture", Browser.Capture, '{"type":"capture"}', '{"type":"capture","extra":1}'),
  accepted("Browser.Group", Browser.Group, '{"type":"group","tabIDs":["btab_x"],"title":"x"}', '{"type":"group","tabIDs":[],"title":"x"}'),
  accepted("Browser.Ungroup", Browser.Ungroup, '{"type":"ungroup","tabIDs":["btab_x"],"groupID":0}', '{"type":"ungroup","tabIDs":["bad"],"groupID":0}'),
  accepted("Browser.Action", Browser.Action, '{"type":"capture"}', '{"type":"bad"}'),
  accepted("Browser.ActionInput", Browser.ActionInput, '{"sessionID":"ses","tabID":"btab_x","generation":1,"documentGeneration":1,"observationRevision":0,"callID":"c","action":{"type":"capture"}}', '{"sessionID":"bad","tabID":"btab_x","generation":1,"documentGeneration":1,"observationRevision":0,"callID":"c","action":{"type":"capture"}}'),
  accepted("Browser.ObserveInput", Browser.ObserveInput, '{"sessionID":"ses","tabID":"btab_x","generation":1,"callID":"c"}', '{"sessionID":"ses","tabID":"btab_x","generation":0,"callID":"c"}'),
  accepted("Browser.OpenInput", Browser.OpenInput, '{"sessionID":"ses","generation":1,"url":"x","callID":"c"}', '{"sessionID":"ses","generation":1,"url":"x"}'),
  accepted("Browser.CloseInput", Browser.CloseInput, '{"sessionID":"ses","tabID":"btab_x","generation":1,"callID":"c"}', '{"sessionID":"ses","tabID":"bad","generation":1,"callID":"c"}'),
  accepted("Browser.ReleaseInput", Browser.ReleaseInput, '{"sessionID":"ses","tabID":"btab_x","generation":1,"callID":"c"}', '{"sessionID":"bad","tabID":"btab_x","generation":1,"callID":"c"}'),
  accepted("Browser.CaptureOutput", Browser.CaptureOutput, '{"mediaType":"image/png","data":"AA==","bytes":0}', '{"mediaType":"image/jpeg","data":"AA==","bytes":0}'),
  accepted("Browser.ActionResult", Browser.ActionResult, `{"callID":"c","tab":${tab},"status":"completed"}`, `{"callID":"","tab":${tab},"status":"completed"}`),
  accepted("Browser.ControlInput", Browser.ControlInput, '{"action":"pause"}', '{"action":"stop"}'),
)


const safeURLSamples = [
  "https://example.com",
  "http:example.com",
  "https:\\\\example.com\\path",
  "  https://example.com ",
  "https://münich.example/ä",
  "http://[2001:db8::1]:80/x",
  "https://user:pass@example.com",
  "https://user%40name%3Apass@example.com",
  "ftp://example.com",
  "mailto:user@example.com",
  "http://",
  "http://:80",
  "https://@example.com",
  "https://example.com/\ud800",
  "https://example.com/\n",
  `https://x/${"a".repeat(8182)}`,
  `https://x/${"a".repeat(8183)}`,
  `https://x/${"é".repeat(4092)}`,
  `https://x/${"é".repeat(4093)}`,
].map((value) => JSON.stringify(value))
corpus.push(
  { name: "IsolatedBrowser.InstanceID", schema: IsolatedBrowser.InstanceID, samples: ['"ibrowser_"', '"ibrowser"', '1'] },
  { name: "IsolatedBrowser.State", schema: IsolatedBrowser.State, samples: ['"starting"', '"connected"'] },
  { name: "IsolatedBrowser.Status", schema: IsolatedBrowser.Status, samples: ['{"mode":"isolated","state":"ready","reason":"r","instanceID":"ibrowser_x"}', '{"mode":"shared","state":"ready"}'] },
  { name: "IsolatedBrowser.StartInput", schema: IsolatedBrowser.StartInput, samples: safeURLSamples.map((sample) => JSON.stringify({ url: JSON.parse(sample) })) },
  { name: "IsolatedBrowser.StartPayload", schema: IsolatedBrowser.StartPayload, samples: safeURLSamples.map((sample) => JSON.stringify({ url: JSON.parse(sample) })) },
  { name: "IsolatedBrowser.ObserveInput", schema: IsolatedBrowser.ObserveInput, samples: ['{"sessionID":"ses","tabID":"btab_x","generation":1,"callID":"c","instanceID":"ibrowser_x"}', '{"sessionID":"ses","tabID":"btab_x","generation":1,"callID":"c","instanceID":"bad"}'] },
  { name: "IsolatedBrowser.ActionInput", schema: IsolatedBrowser.ActionInput, samples: ['{"sessionID":"ses","tabID":"btab_x","generation":1,"documentGeneration":1,"observationRevision":0,"callID":"c","action":{"type":"capture"},"instanceID":"ibrowser_x"}', '{"sessionID":"bad","tabID":"btab_x","generation":1,"documentGeneration":1,"observationRevision":0,"callID":"c","action":{"type":"capture"},"instanceID":"ibrowser_x"}'] },
  { name: "IsolatedBrowser.Observation", schema: IsolatedBrowser.Observation, samples: ['{"tabID":"btab_x","generation":1,"documentGeneration":1,"revision":0,"title":"t","page":{"origin":"https://example.com","path":"/"},"elements":[],"truncated":false,"mode":"isolated","instanceID":"ibrowser_x"}', '{"tabID":"btab_x","generation":1,"documentGeneration":1,"revision":0,"title":"t","page":{"origin":"https://example.com","path":"/"},"elements":[],"truncated":false,"mode":"shared","instanceID":"ibrowser_x"}'] },
  { name: "IsolatedBrowser.ActionResult", schema: IsolatedBrowser.ActionResult, samples: [`{"mode":"isolated","instanceID":"ibrowser_x","callID":"c","tab":${tab},"status":"uncertain","message":"m"}`, `{"mode":"isolated","instanceID":"bad","callID":"c","tab":${tab},"status":"uncertain"}`] },
  { name: "IsolatedBrowser.ControlInput", schema: IsolatedBrowser.ControlInput, samples: ['{"action":"resume"}', '{"action":"stop"}'] },
)


function appendSamples(name: string, ...values: readonly unknown[]) {
  const entry = corpus.find((value) => value.name === name)
  if (!entry) throw new Error(`Missing corpus type: ${name}`)
  entry.samples = [...entry.samples, ...values.map((value) => JSON.stringify(value))]
}
function appendRawSamples(name: string, ...values: readonly string[]) {
  const entry = corpus.find((value) => value.name === name)
  if (!entry) throw new Error(`Missing corpus type: ${name}`)
  entry.samples = [...entry.samples, ...values]
}

const evt = (type: string, data: unknown) => ({ id: "evt_", created: 0, type, data })
const browserTab = { id: "btab_x", sessionID: "ses", title: "t", page: { origin: "https://example.com", path: "/" }, status: "shared", generation: 1, documentGeneration: 1, observationRevision: 0 }
const clientSample = { kind: "client", at: "2024-01-01T00:00:00.000Z", surface: "tui", metric: "stream.delay", durationMs: 0 }
const requestSample = { kind: "request", at: "2024-01-01T00:00:00.000Z", operation: "session.list", outcome: "ok", queueMs: 0, totalMs: 0 }
const hash64 = "a".repeat(64)

appendSamples("Vcs.Mode", "working", "branch", "unknown")
appendSamples("IsolatedBrowser.StartInput", { url: "https://user@example.com" }, { url: "https://:pass@example.com" })
appendSamples("IsolatedBrowser.StartPayload", { url: "https://user@example.com" }, { url: "https://:pass@example.com" })
appendSamples("KeepAwake.Status", { state: "off", message: "x".repeat(200) }, { state: "off", message: "x".repeat(201) })
appendSamples("KeepAwake.Status", { state: "on", manual: false, lid: "held", sleepHold: true }, { state: "on", lid: "sleep" })
appendSamples("KeepAwake.Status", { state: "off", lid: "off", sleepHold: false }, { state: "off", manual: null })
appendSamples("KeepAwake.Status", { state: "on", lid: "error" }, { state: "off", sleepHold: "false" })
appendSamples("FileDiff.Info", { file: "", patch: "", additions: 0, deletions: 0, status: "added" }, { file: "", patch: "", additions: -1, deletions: 0, status: "added" })
appendSamples("FileDiff.LegacyInfo", { additions: -1.5, deletions: 0 }, { additions: 0, deletions: Number.POSITIVE_INFINITY })
appendRawSamples("FileDiff.LegacyInfo", '{"additions":0,"deletions":1e400}')
appendSamples("Vcs.FileStatus", { file: "", additions: 0, deletions: 0, status: "deleted" }, { file: "", additions: 0, deletions: -1, status: "deleted" })
appendSamples("Instruction.Key", "a/b", "a/b/", "/b", "a/B")
appendSamples("Instruction.Hash", "a".repeat(63), hash64, "a".repeat(65), "a".repeat(63) + "g")
appendSamples("Instruction.Values", { "api/x": hash64 }, { "api/x": "a".repeat(63) }, { "API/x": hash64 })
appendSamples("Instruction.Delta", { x: "removed" }, { x: hash64 }, { x: "a".repeat(63) })
appendSamples("InstructionEntry.Key", "a", "a".repeat(8), "a/b", "A", ".leading", "_leading", "-leading", "0.valid_key-1")
appendSamples("InstructionEntry.Info", { key: "a", value: null }, { key: "a", value: { nested: Number.POSITIVE_INFINITY } })
appendSamples("EventLog.Synced", { type: "log.synced", aggregateID: "x" }, { type: "log.synced", aggregateID: "x", seq: 0 }, { type: "log.synced", aggregateID: "x", seq: -1 }, { type: "log.synced", aggregateID: "x", seq: null })
appendSamples("Workspace.ID", "wrk", "wrk\\ud800", "wr", "ses")
appendSamples("WorkspaceEvent.ConnectionStatus", { workspaceID: "wrk", status: "connected" }, { workspaceID: "wrk", status: "error" }, { workspaceID: "wrk", status: "connectedx" })
appendSamples("WorktreeEvent.Ready", evt("worktree.ready", { name: "n" }), evt("worktree.ready", { name: "n", branch: null }))
appendSamples("SessionTodo.Status", "pending", "in_progress", "completed", "cancelled", "in-progress")
appendSamples("SessionTodo.Priority", "high", "medium", "low", "urgent")
appendSamples("SessionStatusEvent.Info", { type: "idle" }, { type: "busy" }, { type: "retry", attempt: 0, message: "m", next: 0 }, { type: "retry", attempt: -1, message: "m", next: 0 }, { type: "retry", attempt: 0, message: "m", next: 0, action: null })
appendSamples("TuiEvent.ToastShow", evt("tui.toast.show", { message: "m", variant: "info" }), evt("tui.toast.show", { message: "m", variant: "info", duration: 1 }), evt("tui.toast.show", { message: "m", variant: "info", duration: 0 }))
appendSamples("Project.Vcs", "git", "hg", "svn")
appendSamples("Project.Time", { created: 0, updated: 0 }, { created: 0, updated: 0, initialized: 0 }, { created: -1, updated: 0 })
appendSamples("Project.InventoryEntry", { projectID: "global", projectWorktree: "", directory: "", sessions: 0, timeActive: 0, available: true }, { projectID: "global", projectWorktree: "", directory: "", sessions: -1, timeActive: 0, available: true })
appendSamples("ProjectCopy.StrategyID", "x", "\\t x \\n", "\\t\\n", "\\ufeffx\\ufeff")
appendSamples("Telemetry.Operation", "session.prediction", "session.promptGenerate", "session.promptGenerate ", "session.generate")
appendSamples("SessionCompaction.Boundary", { messageID: "msg_x", seq: 0 }, { messageID: "msg_x", seq: -1 })
appendSamples("SessionCompaction.Admission", { id: "cmp_x", sessionID: "ses", trigger: "manual", status: "pending", requestedThrough: { messageID: "msg_x", seq: 0 }, timeCreated: -8640000000000000 }, { id: "cmp_x", sessionID: "ses", trigger: "manual", status: "pending", requestedThrough: { messageID: "msg_x", seq: 0 }, timeCreated: 8640000000000001 })
appendSamples("SessionCompaction.Result", { id: "cmp_x", sessionID: "ses", trigger: "manual", status: "ended", requestedThrough: { messageID: "msg_x", seq: 0 }, timeCreated: 0 }, { id: "cmp_x", sessionID: "ses", trigger: "manual", status: "failed", requestedThrough: { messageID: "msg_x", seq: 0 }, timeCreated: 0, failure: null })
appendSamples("Telemetry.Consent", { enabled: true, noticeVersion: 1, decidedAt: 0 }, { enabled: true, noticeVersion: 1, decidedAt: -1 }, { enabled: true, noticeVersion: 2, decidedAt: 0 })
appendSamples("Telemetry.ConsentState", { noticeVersion: 1 }, { noticeVersion: 1, consent: null })
appendSamples("Telemetry.ConsentInput", { enabled: false, noticeVersion: 1 }, { enabled: false, noticeVersion: 2 }, { enabled: false, noticeVersion: 1, other: 0 })
appendSamples("Telemetry.RequestSample", requestSample, { ...requestSample, queueMs: -1 }, { ...requestSample, totalMs: 600000 }, { ...requestSample, totalMs: 600001 })
appendSamples("Telemetry.LongTaskSample", { kind: "long-task", at: requestSample.at, durationMs: 50 }, { kind: "long-task", at: requestSample.at, durationMs: 49 }, { kind: "long-task", at: requestSample.at, durationMs: 600001 })
appendSamples("Telemetry.Batch", { samples: [clientSample] }, { samples: [] }, { samples: Array.from({ length: 20 }, () => clientSample) }, { samples: Array.from({ length: 21 }, () => clientSample) })
appendSamples("FileSystem.Submatch", { text: "", start: 0, end: 0 }, { text: "", start: -1, end: 0 })
appendSamples("Form.Fields", [{ key: "x", type: "boolean" }], [], [{ key: "x", type: "invalid" }])
appendSamples("Form.When", { key: "x", op: "eq", value: "" }, { key: "x", op: "eq", value: Number.POSITIVE_INFINITY }, { key: "x", op: "eq", value: null })
appendSamples("Form.StringField", { key: "x", type: "string", minLength: 0, maxLength: 0 }, { key: "x", type: "string", minLength: -1 }, { key: "x", type: "string", minLength: null })
appendSamples("Form.Field", { key: "x", type: "number", minimum: Number.NEGATIVE_INFINITY }, { key: "x", type: "integer", minimum: 1.5 }, { key: "x", type: "external", url: "" })
appendSamples("Form.State", { status: "pending" }, { status: "cancelled" }, { status: "answered", answer: {} }, { status: "answered" })
appendSamples("Question.ID", "que", "query", "q", "\\ud800")
appendSamples("Question.Request", { id: "que", sessionID: "ses", questions: [] }, { id: "que", sessionID: "ses", questions: [], tool: null })
appendSamples("Guardrail.Rule", { id: "x", source: "standard", decision: "allow", actions: [""], resources: [""], reason: "", priority: 0 }, { id: "x", source: "standard", decision: "allow", actions: [""], resources: [], reason: "", priority: 0 })
appendSamples("Guardrail.Risk", { level: 0, label: "", score: 0, metric: "confidence" }, { level: 4, label: "", score: 0, metric: "probability" }, { level: -1, label: "", score: 0, metric: "confidence" }, { level: 0, label: "", score: Number.POSITIVE_INFINITY, metric: "confidence" })
appendSamples("Guardrail.Request", { id: "grq_x", rootSessionID: "ses", sessionID: "ses", action: "", resources: [], ruleIDs: [], reason: "", standard: false }, { id: "grq_x", rootSessionID: "ses", sessionID: "ses", action: "", resources: [], ruleIDs: [], reason: "", standard: false, hardReview: null })
appendSamples("Shell.MemoryLimitMb", 0, 1048576, -1, 1048577)
appendSamples("Shell.Time", { started: 0 }, { started: -1.5, completed: 0 }, { started: Number.POSITIVE_INFINITY })
appendRawSamples("Shell.Time", '{"started":1e400}', '{"started":0,"completed":1e400}')
appendSamples("Shell.Info", { id: "sh_x", status: "running", command: "", cwd: "", shell: "", file: "", metadata: {}, toolCallID: "x", time: { started: 0 } }, { id: "sh_x", status: "running", command: "", cwd: "", shell: "", file: "", metadata: {}, toolCallID: "", time: { started: 0 } }, { id: "sh_x", status: "running", command: "", cwd: "", shell: "", file: "", metadata: {}, pid: null, time: { started: 0 } })
appendSamples("Shell.CreateInput", { command: "", timeout: 0 }, { command: "", timeout: -1 })
appendSamples("Pty.ID", "pty", "ptyx", "pt", "\\ud800")
appendSamples("Pty.Size", { rows: 1, cols: 1 }, { rows: 200, cols: 500 }, { rows: 0, cols: 1 }, { rows: 1, cols: 501 })
appendSamples("Pty.Info", { id: "ptyx", title: "", command: "", args: [], cwd: "", sessionID: "ses", status: "running", pid: 0, generation: 1, size: { rows: 1, cols: 1 }, control: { owner: "agent", fence: 1 }, output: { startOffset: 0, endOffset: 0, truncated: false }, limits: { maxRuntimeSeconds: 7200, maxRetainedBytes: 2097152, maxInputBytes: 65536 } }, { id: "ptyx", title: "", command: "", args: [], cwd: "", sessionID: "ses", status: "running", pid: 0, generation: 1, size: { rows: 1, cols: 1 }, control: { owner: "agent", fence: 1 }, output: { startOffset: 0, endOffset: 0, truncated: false }, limits: { maxRuntimeSeconds: 7201, maxRetainedBytes: 2097152, maxInputBytes: 65536 } })
appendSamples("Pty.CreateInput", { sessionID: "ses", maxRuntimeSeconds: 1 }, { sessionID: "ses", maxRuntimeSeconds: 7200 }, { sessionID: "ses", maxRuntimeSeconds: 0 }, { sessionID: "ses", maxRuntimeSeconds: 7201 }, { sessionID: "ses", maxRetainedBytes: 2097152 }, { sessionID: "ses", maxRetainedBytes: 2097153 })
appendSamples("Pty.ConnectInput", { sessionID: "ses", access: "inspect", generation: 1 }, { sessionID: "ses", access: "inspect", generation: 1, expectedFence: null }, { sessionID: "ses", access: "inspect", generation: 1, expectedFence: 1 })
appendSamples("PtyTicket.ConnectToken", { ticket: "", expires_in: 1, access: "inspect", generation: 1 }, { ticket: "", expires_in: 0, access: "inspect", generation: 1 }, { ticket: "", expires_in: 1, access: "inspect", generation: 1, fence: null })
appendSamples("Mcp.OAuthConfig", { callback_port: 1 }, { callback_port: 65535 }, { callback_port: 0 }, { callback_port: 65536 }, { callback_port: null })
appendSamples("Mcp.Status", { status: "connected" }, { status: "pending" }, { status: "disabled" }, { status: "failed", error: "" }, { status: "needs_auth" }, { status: "needs_client_registration", error: "" }, { status: "failed" })
appendSamples("Mcp.ResourceContentPart", { type: "text", uri: "", text: "", mimeType: null }, { type: "blob", uri: "", blob: "" }, { type: "text", uri: "", text: "" }, { type: "blob", uri: "" })
appendSamples("McpSkill.Digest", `sha256:${"a".repeat(64)}`, `sha256:${"a".repeat(63)}`, `sha256:${"a".repeat(65)}`, `sha256:${"a".repeat(63)}q`)
appendSamples("McpSkill.ResourceEntry", { uri: "", digest: `sha256:${"a".repeat(64)}`, size: 0 }, { uri: "", digest: `sha256:${"a".repeat(64)}`, size: -1 })
appendSamples("McpSkill.File", { server: "", uri: "", size: 0, text: "" }, { server: "", uri: "", size: 0, blob: "" }, { server: "", uri: "", size: 0, text: "", blob: "" }, { server: "", uri: "", size: -1, text: "" })
appendSamples("Browser.Status", { state: "connected", extensionID: "p".repeat(32) }, { state: "connected", extensionID: "a".repeat(31) + "q" }, { state: "connected", extensionID: "a".repeat(31) }, { state: "connected", extensionID: "a".repeat(33) }, { state: "connected", extensionID: null })
appendSamples("Browser.CallID", "x", "x".repeat(512), "", "x".repeat(513))
appendSamples("Browser.Page", { origin: "https://x", path: "/" }, { origin: "https://x:", path: "/" }, { origin: "https://x", path: "/?" }, { origin: "https://user@x", path: "/" })
appendSamples("Browser.Pairing", { secret: "x".repeat(32), expiresAt: 0 }, { secret: "x".repeat(128), expiresAt: 0 }, { secret: "x".repeat(31), expiresAt: 0 }, { secret: "x".repeat(129), expiresAt: 0 })
appendSamples("Browser.Tab", { ...browserTab, title: "x".repeat(512) }, { ...browserTab, title: "x".repeat(513) }, { ...browserTab, title: "" })
appendSamples("Browser.Element", { ref: "b9999", role: "r".repeat(64), name: "n".repeat(1024), description: "d".repeat(1024) }, { ref: "b10000", role: "r", name: "n" }, { ref: "b1", role: "r".repeat(65), name: "n" }, { ref: "b1", role: "r", name: "n".repeat(1025) })
appendSamples("Browser.Observation", { tabID: "btab_x", generation: 1, documentGeneration: 1, revision: 0, title: "t".repeat(512), page: { origin: "https://x", path: "/" }, elements: [], truncated: false }, { tabID: "btab_x", generation: 1, documentGeneration: 1, revision: 0, title: "t".repeat(513), page: { origin: "https://x", path: "/" }, elements: [], truncated: false }, { tabID: "btab_x", generation: 1, documentGeneration: 1, revision: 0, title: "t", page: { origin: "https://x", path: "/" }, elements: Array.from({ length: 200 }, () => ({ ref: "b1", role: "r", name: "n" })), truncated: false }, { tabID: "btab_x", generation: 1, documentGeneration: 1, revision: 0, title: "t", page: { origin: "https://x", path: "/" }, elements: Array.from({ length: 201 }, () => ({ ref: "b1", role: "r", name: "n" })), truncated: false })
appendSamples("Browser.Navigate", { type: "navigate", url: "x".repeat(8192) }, { type: "navigate", url: "x".repeat(8193) })
appendSamples("Browser.Type", { type: "type", ref: "b1", text: "x".repeat(8192) }, { type: "type", ref: "b1", text: "x".repeat(8193) })
appendSamples("Browser.Group", { type: "group", tabIDs: ["btab_x"], title: "x" }, { type: "group", tabIDs: Array.from({ length: 8 }, () => "btab_x"), title: "x".repeat(64) }, { type: "group", tabIDs: [], title: "x" }, { type: "group", tabIDs: Array.from({ length: 9 }, () => "btab_x"), title: "x" }, { type: "group", tabIDs: ["btab_x"], title: "x".repeat(65) })
appendSamples("Browser.Ungroup", { type: "ungroup", tabIDs: ["btab_x"], groupID: 0 }, { type: "ungroup", tabIDs: Array.from({ length: 8 }, () => "btab_x"), groupID: 0 }, { type: "ungroup", tabIDs: Array.from({ length: 9 }, () => "btab_x"), groupID: 0 })
appendSamples("Browser.CaptureOutput", { mediaType: "image/png", data: "A".repeat(1398110), bytes: 0 }, { mediaType: "image/png", data: "A".repeat(1398111), bytes: 0 }, { mediaType: "image/png", data: "==", bytes: 0 }, { mediaType: "image/png", data: "A=AA", bytes: 0 }, { mediaType: "image/png", data: "AA==", bytes: 1048576 }, { mediaType: "image/png", data: "AA==", bytes: 1048577 })
appendSamples("Browser.ActionResult", { callID: "x", tab: browserTab, status: "completed", message: "m".repeat(1024) }, { callID: "x", tab: browserTab, status: "completed", message: "m".repeat(1025) }, { callID: "x", tab: browserTab, status: "completed", message: null })
appendSamples("IsolatedBrowser.StartInput", ...safeURLSamples.map((sample) => ({ url: JSON.parse(sample) })), { url: "https://x/" + "x".repeat(8182) }, { url: "https://x/" + "x".repeat(8183) })
appendSamples("IsolatedBrowser.StartPayload", ...safeURLSamples.map((sample) => ({ url: JSON.parse(sample) })))


appendSamples("SessionError.Error", { type: "", message: "" }, { type: null, message: "" }, { type: "", message: null })
appendSamples("Remote.Status", { state: "on" }, { state: "on", message: null })
appendSamples("KeepAwake.Status", { state: "off" }, { state: "off", message: null })
appendSamples("FileDiff.Info", { file: "", patch: "", additions: 0, deletions: 0, status: "added" }, { patch: "", additions: 0, deletions: 0, status: "added" })
appendSamples("FileDiff.LegacyInfo", { additions: 0, deletions: 0 }, { file: null, additions: 0, deletions: 0 })
appendSamples("Vcs.Branch", {}, { current: null }, { default: "main" })
appendSamples("Instruction.Values", {}, { x: hash64 }, { x: "removed" })
appendSamples("EventLog.Synced", { type: "log.synced", aggregateID: "x" }, { type: "log.synced", aggregateID: "x", seq: null })
appendSamples("WorkspaceEvent.Ready", evt("workspace.ready", { name: "" }), evt("workspace.ready", {}))
appendSamples("WorktreeEvent.Ready", evt("worktree.ready", { name: "" }), evt("worktree.ready", {}), evt("worktree.ready", { name: "n", branch: null }))
appendSamples("ServerEvent.Connected", evt("server.connected", {}), evt("server.connected", null))
appendSamples("LspEvent.Updated", evt("lsp.updated", {}), evt("lsp.updated", null))
appendSamples("InstallationEvent.Updated", evt("installation.updated", { version: "" }), evt("installation.updated", {}))
appendSamples("VcsEvent.BranchUpdated", evt("vcs.branch.updated", {}), evt("vcs.branch.updated", { branch: null }))
appendSamples("SessionStatusEvent.Info", { type: "retry", attempt: 0, message: "", next: 0 }, { type: "retry", attempt: 0, message: "", next: 0, action: null })
appendSamples("TuiEvent.ToastShow", evt("tui.toast.show", { message: "", variant: "info" }), evt("tui.toast.show", { title: null, message: "", variant: "info" }))
appendSamples("Skill.Info", { id: "", name: "", location: "", content: "" }, { id: "", name: "", location: "", content: "", description: null })
appendSamples("Reference.LocalSource", { type: "local", path: "" }, { type: "local", path: "", description: null })
appendSamples("Project.Info", { id: "global", worktree: "", time: { created: 0, updated: 0 }, sandboxes: [] }, { id: "global", worktree: "", vcs: null, time: { created: 0, updated: 0 }, sandboxes: [] })
appendSamples("ProjectCopy.CreateInput", { projectID: "global", strategy: "x", sourceDirectory: "", directory: "" }, { projectID: "global", strategy: "x", sourceDirectory: "", directory: "", name: null })
appendSamples("SessionCompaction.Result", { id: "cmp_x", sessionID: "ses", trigger: "manual", status: "failed", requestedThrough: { messageID: "msg_x", seq: 0 }, timeCreated: 0 }, { id: "cmp_x", sessionID: "ses", trigger: "manual", status: "failed", requestedThrough: { messageID: "msg_x", seq: 0 }, timeCreated: 0, failure: null })
appendSamples("Telemetry.ConsentState", { noticeVersion: 1 }, { noticeVersion: 1, consent: null })
appendSamples("FileSystem.FindInput", { query: "" }, { query: "", type: null })
appendSamples("Form.StringField", { key: "x", type: "string" }, { key: "x", type: "string", default: null })
appendSamples("Question.Request", { id: "que", sessionID: "ses", questions: [] }, { id: "que", sessionID: "ses", questions: [], tool: null })
appendSamples("Guardrail.Request", { id: "grq_x", rootSessionID: "ses", sessionID: "ses", action: "", resources: [], ruleIDs: [], reason: "", standard: false }, { id: "grq_x", rootSessionID: "ses", sessionID: "ses", action: "", resources: [], ruleIDs: [], reason: "", standard: false, hardReview: null })
appendSamples("Shell.Info", { id: "sh_x", status: "running", command: "", cwd: "", shell: "", file: "", metadata: {}, time: { started: 0 } }, { id: "sh_x", status: "running", command: "", cwd: "", shell: "", file: "", metadata: {}, pid: null, time: { started: 0 } })
appendSamples("Pty.Info", { id: "ptyx", title: "", command: "", args: [], cwd: "", sessionID: "ses", status: "running", pid: 0, generation: 1, size: { rows: 1, cols: 1 }, control: { owner: "agent", fence: 1 }, output: { startOffset: 0, endOffset: 0, truncated: false }, limits: { maxRuntimeSeconds: 1, maxRetainedBytes: 1, maxInputBytes: 1 } }, { id: "ptyx", title: "", command: "", args: [], cwd: "", sessionID: "ses", status: "running", pid: 0, exitCode: null, generation: 1, size: { rows: 1, cols: 1 }, control: { owner: "agent", fence: 1 }, output: { startOffset: 0, endOffset: 0, truncated: false }, limits: { maxRuntimeSeconds: 1, maxRetainedBytes: 1, maxInputBytes: 1 } })
appendSamples("PtyTicket.ConnectToken", { ticket: "", expires_in: 1, access: "inspect", generation: 1 }, { ticket: "", expires_in: 1, access: "inspect", generation: 1, fence: null })
appendSamples("Mcp.RemoteConfig", { type: "remote", url: "" }, { type: "remote", url: "", disabled: null })
appendSamples("Mcp.Resource", { server: "", name: "", uri: "" }, { server: "", name: "", uri: "", description: null })
appendSamples("McpSkill.Capability", {}, { directoryRead: null })
appendSamples("Browser.Tab", { ...browserTab }, { ...browserTab, mode: null })
appendSamples("Browser.Status", { state: "connected" }, { state: "connected", paired: null })
appendSamples("Browser.ActionResult", { callID: "x", tab: browserTab, status: "completed" }, { callID: "x", tab: browserTab, status: "completed", capture: null })
appendSamples("IsolatedBrowser.Status", { mode: "isolated", state: "ready" }, { mode: "isolated", state: "ready", reason: null })


appendSamples("FileDiff.Info", { file: "", patch: "", additions: 0, deletions: 0, status: "unknown" })
appendSamples("Vcs.FileStatus", { file: "", additions: 0, deletions: 0, status: "added" }, { file: "", additions: -1, deletions: 0, status: "added" }, { file: "", additions: 0, deletions: -1, status: "added" }, { file: "", additions: 0, deletions: 0, status: "unknown" })
appendSamples("Telemetry.RequestSample", { ...requestSample, at: "2024-01-01" })
appendSamples("Telemetry.RequestSample", { ...requestSample, at: "2024-01-01T00:00:00.000X" })
appendSamples("FileSystem.Submatch", { text: "", start: 0, end: 0 }, { text: "", start: 0, end: 0, line: 1 }, { text: "", start: 0, end: 0, line: 0 })
appendSamples("Mcp.TimeoutConfig", { startup: 1 }, { startup: 0 }, { startup: 2 })
appendSamples("IsolatedBrowser.Status", { mode: "isolated", state: "ready", reason: "r".repeat(1024) }, { mode: "isolated", state: "ready", reason: "r".repeat(1025) })
appendSamples("IsolatedBrowser.ActionResult", { mode: "isolated", instanceID: "ibrowser_x", callID: "c", tab: JSON.parse(tab), status: "uncertain", message: "m".repeat(1024) }, { mode: "isolated", instanceID: "ibrowser_x", callID: "c", tab: JSON.parse(tab), status: "uncertain", message: "m".repeat(1025) })
appendSamples("Browser.Scroll", { type: "scroll", deltaY: -10000 }, { type: "scroll", deltaY: 10000 }, { type: "scroll", deltaY: -10001 }, { type: "scroll", deltaY: 10001 })
appendSamples("Browser.TabID", "btab_x", "btab_", "btabx")


appendSamples("SessionStatusEvent.Info", { type: "idle" }, { type: "busy" }, { type: "other" })
appendSamples("FileSystem.Match", { entry: { path: "x", type: "file" }, line: 1, offset: 0, text: "", submatches: [] }, { entry: { path: "x", type: "file" }, line: 0, offset: 0, text: "", submatches: [] })
appendSamples("Pty.Size", { rows: 1, cols: 500 }, { rows: 1, cols: 501 })


appendSamples("Guardrail.RequestID", "grq_x", "grq", "g_bad")
appendSamples("Browser.CaptureOutput", { mediaType: "image/png", data: "AA===", bytes: 0 })

appendSamples("SessionMessage.Info",
  { id: "msg_1", type: "agent-switched", agent: "a", time: { created: 0 } },
  { id: "msg_1", type: "model-switched", model: { providerID: "p", id: "m" }, time: { created: 0 } },
  { id: "msg_1", type: "synthetic", text: "x", time: { created: 0 } },
  { id: "msg_1", type: "skill", skill: "s", name: "n", text: "x", time: { created: 0 } },
  { id: "msg_1", type: "shell", shellID: "sh_x", command: "x", status: "running", time: { created: 0 } },
  { id: "msg_1", type: "assistant", agent: "a", model: { providerID: "p", id: "m" }, content: [], time: { created: 0 } },
  { id: "msg_1", type: "compaction", status: "running", reason: "auto", summary: "s", recent: "r", time: { created: 0 } },
  { id: "msg_1", type: "compaction", status: "running", jobID: "cmp_x", trigger: "manual", time: { created: 0 } },
  { id: "msg_1", type: "compaction", status: "running", reason: "auto", summary: "s", recent: "r", jobID: "cmp_x", trigger: "manual", time: { created: 0 } },
  { id: "msg_1", type: "compaction", status: "completed", reason: "manual", summary: "s", recent: "r", time: { created: 0 } },
  { id: "msg_1", type: "compaction", status: "completed", jobID: "cmp_x", trigger: "manual", revision: 0, boundary: { messageID: "msg_x", seq: 0 }, metrics: { excludedMessages: 0, excludedParts: 0, inputTokens: 0, retainedTokens: 0 }, time: { created: 0 } },
  { id: "msg_1", type: "compaction", status: "completed", reason: "manual", summary: "s", recent: "r", jobID: "cmp_x", trigger: "manual", revision: 0, boundary: { messageID: "msg_x", seq: 0 }, metrics: { excludedMessages: 0, excludedParts: 0, inputTokens: 0, retainedTokens: 0 }, time: { created: 0 } },
  { id: "msg_1", type: "compaction", status: "failed", reason: "auto", error: { type: "error", message: "x" }, time: { created: 0 } },
  { id: "msg_1", type: "compaction", status: "failed", jobID: "cmp_x", trigger: "manual", code: "provider_failed", error: { type: "error", message: "x" }, time: { created: 0 } },
  { id: "msg_1", type: "compaction", status: "failed", reason: "auto", jobID: "cmp_x", trigger: "manual", code: "provider_failed", error: { type: "error", message: "x" }, time: { created: 0 } },
  { id: "msg_1", type: "not-a-message", time: { created: 0 } },
)
appendSamples("SessionMessage.AssistantContent",
  { type: "reasoning", text: "r", time: { created: 0, completed: 1 }, state: { "\ud800": null } },
  { type: "tool", id: "call", name: "read", state: { status: "running", input: {}, structured: {}, content: [{ type: "text", text: "x" }] }, time: { created: 0, ran: 1, completed: 2 }, providerState: { key: [null] } },
  { type: "text", text: "f", phase: "final_answer" },
  { type: "text", text: "c", phase: "commentary" },
  { type: "tool", id: "call", name: "read", state: { status: "completed", input: {}, content: [], structured: {}, result: null }, time: { created: 0 } },
  { type: "tool", id: "call", name: "read", state: { status: "error", input: {}, content: [], structured: {}, error: { type: "error", message: "x" } }, time: { created: 0 } },
  { type: "other", text: "x" },
)
appendSamples("SessionMessage.ToolState",
  { status: "running", input: {}, structured: {}, content: [{ type: "file", uri: "u", mime: "m" }] },
  { status: "completed", input: {}, content: [], structured: {}, result: { "\ud800": 1 } },
  { status: "error", input: {}, content: [], structured: {}, error: { type: "e", message: "m" }, result: null },
  { status: "other", input: "x" },
)
appendSamples("SessionMessage.Assistant", { id: "msg_x", type: "assistant", agent: "a", model: { providerID: "p", id: "m", variant: "v", profile: "fast" }, content: [{ type: "reasoning", text: "x" }, { type: "text", text: "y" }], skillDeactivations: [{ skill: "s", reason: "conflict_resolved" }], snapshot: { start: "snapshot", end: "snapshot", files: ["relative"] }, finish: "tool-calls", cost: 0, tokens: { input: 0, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, diagnostics: { contextLimit: 1, contextBreakdown: { system: 0, tools: 0, user: 0, assistant: 0, reasoning: 0, toolCalls: 0, other: 0 }, providerCache: { mechanism: "none", readReported: false, writeReported: false } }, error: { type: "e", message: "m" }, retry: { attempt: 1, at: 0, error: { type: "e", message: "m" } }, time: { created: 0, completed: 1 } })
appendSamples("SessionMessage.AssistantRetry", { attempt: 1, at: 0, error: { type: "e", message: "m" } }, { attempt: 0, at: 0, error: { type: "e", message: "m" } })
appendSamples("SessionMessage.Info", { id: "msg_", type: "user", text: "x", files: [], agents: [], time: { created: 8640000000000000, consumed: 1 } }, { id: "msg_", type: "user", text: "x", files: [], agents: [], time: { created: 8640000000000001 } }, { id: "bad", type: "user", text: "x", files: [], agents: [], time: { created: 0 } })
appendSamples("SessionMessage.System", { id: "msg_x", type: "system", time: { created: 0 } })
appendSamples("SessionMessage.ToolState", { status: "streaming" })
appendSamples("SessionMessage.AssistantContent", { type: "text", text: "x", phase: "commentary" }, { type: "text", text: "x", phase: "final_answer" }, { type: "reasoning", text: "x", time: { created: 0, completed: 1 } }, { type: "text", text: "x", phase: "final" })
appendSamples("SessionMessage.Assistant", { id: "msg_x", type: "assistant", agent: "a", model: { providerID: "p", id: "m" }, content: [], finish: "stop", time: { created: 0 } }, { id: "msg_x", type: "assistant", agent: "a", model: { providerID: "p", id: "m" }, content: [], finish: "bogus", time: { created: 0 } })
appendSamples("SessionMessage.Compaction", { id: "msg_x", type: "compaction", status: "pending", jobID: "cmp_x", trigger: "consider", pressure: { estimatedInputTokens: 1, safeInputTokens: 2 }, summary: "s", recent: "r", time: { created: 0 } }, { id: "msg_x", type: "compaction", status: "pending", jobID: "cmp_x", trigger: "unknown", time: { created: 0 } }, { id: "msg_x", type: "compaction", status: "failed", jobID: "cmp_x", trigger: "manual", code: "invalid_manifest", error: { type: "e", message: "m" }, time: { created: 0 } })
appendSamples("SessionMessage.ArtifactProvenance", { scopeID: "pas_1", versionID: "pav_1", kind: "agent", id: "1", sourceScope: "project" }, { scopeID: "pas_", versionID: "pav_x", kind: "agent", id: "a", sourceScope: "project" }, { scopeID: "pas_a-", versionID: "pav_x", kind: "agent", id: "a", sourceScope: "project" }, { scopeID: "pas_x", versionID: "pav_x", kind: "agent", id: "com10", sourceScope: "project" }, { scopeID: "pas_x", versionID: "pav_x", kind: "command", id: `a${"b".repeat(61)}z`, sourceScope: "project" }, { scopeID: "pas_x", versionID: "pav_x", kind: "agent", id: `a${"b".repeat(62)}z`, sourceScope: "project" }, { scopeID: "pas_x", versionID: "pav_x", kind: "agent", id: `a${"b".repeat(62)}zz`, sourceScope: "project" })
appendSamples("SessionPending.User", { admittedSeq: 0, id: "msg_x", sessionID: "ses", timeCreated: 0, type: "user", data: { text: "x" }, delivery: "steer" }, { admittedSeq: 0, id: "msg_x", sessionID: "ses", timeCreated: 0, type: "user", data: { text: "x" }, delivery: "queue" })
appendSamples("SessionPending.Synthetic", { admittedSeq: 0, id: "msg_x", sessionID: "ses", timeCreated: 0, type: "synthetic", data: { text: "x" }, delivery: "steer" }, { admittedSeq: 0, id: "msg_x", sessionID: "ses", timeCreated: 0, type: "synthetic", data: { text: "x" }, delivery: "queue" })
appendSamples("SessionPending.Info", { admittedSeq: 9007199254740991, id: "msg_", sessionID: "ses", timeCreated: 0, type: "user", data: { text: "x" }, delivery: "steer" }, { admittedSeq: 9007199254740992, id: "msg_x", sessionID: "ses", timeCreated: 0, type: "user", data: { text: "x" }, delivery: "steer" }, { admittedSeq: 0, id: "msg_x", sessionID: "ses", timeCreated: 0, type: "user", data: { text: "x" }, delivery: "send" })
appendSamples("SessionOrchestration.Task", { sessionID: "ses", parentID: "ses", description: "é".repeat(2047) + "x", agent: "a", model: { providerID: "p", id: "m" }, background: true, state: "running", revision: 0, time: { created: 0, updated: 0 } }, { sessionID: "ses", parentID: "ses", description: "é".repeat(2048), agent: "a", model: { providerID: "p", id: "m" }, background: true, state: "running", revision: 0, time: { created: 0, updated: 0 } }, { sessionID: "ses", parentID: "ses", description: "é".repeat(2048) + "x", agent: "a", model: { providerID: "p", id: "m" }, background: true, state: "running", revision: 0, time: { created: 0, updated: 0 } })
appendSamples("SessionOrchestration.Answer", { questionID: "qst_x", data: "x".repeat(8189) }, { questionID: "qst_x", data: "x".repeat(8190) }, { questionID: "qst_x", data: "x".repeat(8191) }, { questionID: "qst_x", data: Number.POSITIVE_INFINITY })
appendSamples("SessionOrchestration.Control", { action: "send", sessionID: "ses", text: "é".repeat(32767) + "x", delivery: "queue" }, { action: "send", sessionID: "ses", text: "é".repeat(32768), delivery: "queue" }, { action: "send", sessionID: "ses", text: "é".repeat(32768) + "x", delivery: "queue" })
appendRawSamples("SessionOrchestration.Answer", '{"questionID":"qst_x","data":1e400}')
appendSamples("SessionWorkCompletion.Receipt", { id: "evt_", seq: 0, created: 9007199254740991, sessionID: "ses", inputID: "msg_", assistantMessageID: "msg_y" }, { id: "evt_", seq: 0, created: 9007199254740992, sessionID: "ses", inputID: "msg_", assistantMessageID: "msg_y" }, { id: "bad", seq: 0, created: 0, sessionID: "ses", inputID: "msg_x", assistantMessageID: "msg_y" })
appendSamples("SessionMessage.ArtifactProvenance",
  { scopeID: `pas_${"a".repeat(60)}`, versionID: "pav_x", kind: "plugin", id: `a${"b".repeat(61)}z`, sourceScope: "global" },
  { scopeID: `pas_${"a".repeat(61)}`, versionID: "pav_x", kind: "plugin", id: "a", sourceScope: "project" },
  { scopeID: "pas_x", versionID: `pav_${"a".repeat(60)}`, kind: "skill", id: "aux", sourceScope: "project" },
  { scopeID: "pas_x", versionID: `pav_${"a".repeat(61)}`, kind: "skill", id: "a", sourceScope: "project" },
  { scopeID: "pas_x", versionID: "pav_x", kind: "other", id: "a", sourceScope: "project" },
  { scopeID: "pas_x", versionID: "pav_x", kind: "skill", id: "com9", sourceScope: "project" },
  { scopeID: "pas_x", versionID: "pav_x", kind: "skill", id: "a_", sourceScope: "project" },
  { scopeID: "pas_x", versionID: "pav_x", kind: "skill", id: "a", sourceScope: "local" },
)
appendSamples("SessionRevert.Revert", { messageID: "msg_x", snapshot: "\ud800", files: [{ file: "f", patch: "p", additions: 0, deletions: 1, status: "deleted" }] }, { messageID: "msg_x", files: [{ file: "f", patch: "p", additions: -1, deletions: 1, status: "deleted" }] })
appendSamples("SessionRevert.Revert", { messageID: "msg_x", snapshot: null }, { snapshot: "snapshot" })
appendSamples("SessionPending.Message", { type: "user", data: { text: "x", files: [], agents: [], metadata: { "\ud800": null } }, delivery: "queue" }, { type: "user", data: { text: "x" }, delivery: "queue" }, { type: "other", data: {}, delivery: "steer" })
appendSamples("SessionPending.UserData", { text: "\ud800", files: [], agents: [], metadata: { "\ud800": [1] } }, { text: "x", metadata: null })
appendSamples("SessionPending.SyntheticData", { text: "x", description: "d", metadata: {} }, { text: "x", metadata: null })
appendSamples("SessionPending.Info", { admittedSeq: 0, id: "msg_x", sessionID: "ses", timeCreated: 0, type: "synthetic", data: { text: "x", description: "d", metadata: {} }, delivery: "queue" }, { admittedSeq: 0, id: "msg_x", sessionID: "ses", timeCreated: 0, type: "compaction" })
appendSamples("SessionPending.LegacyInfo", { admittedSeq: 0, id: "msg_x", sessionID: "ses", timeCreated: 0, type: "compaction" }, { admittedSeq: 0, id: "msg_x", sessionID: "ses", timeCreated: 0, type: "unknown" })
appendSamples("SessionOrchestration.State", "starting", "running", "waiting", "cancelling", "cancelled", "completed", "failed", "lost", "unknown")
appendSamples("SessionOrchestration.TerminalState", "cancelled", "completed", "failed", "lost", "starting")
appendSamples("SessionOrchestration.QuestionID", "qst_", "qst_\ud800", "qst", "QST_x")
appendSamples("SessionOrchestration.Progress", { text: "x".repeat(4095), time: 0 }, { text: "x".repeat(4096), time: 0 }, { text: "x".repeat(4097), time: 0 }, { text: "x", time: -1 })
appendSamples("SessionOrchestration.Question", { id: "qst_x", text: "x".repeat(8191), time: 0 }, { id: "qst_x", text: "x".repeat(8192), time: 0 }, { id: "qst_x", text: "x".repeat(8193), time: 0 }, { id: "qst_x", text: "x", data: null, time: 0 })
appendSamples("SessionOrchestration.Answer", { questionID: "qst_x", text: "x".repeat(65536) }, { questionID: "qst_x", text: "x".repeat(65537) }, { questionID: "qst_x", data: { nested: [true, null] } }, { questionID: "qst_x", data: null })
appendSamples("SessionOrchestration.Task", { sessionID: "ses", parentID: "ses", description: "x".repeat(4095), agent: "a", model: { providerID: "p", id: "m" }, background: false, state: "waiting", progress: { text: "p", time: 0 }, question: { id: "qst_x", text: "q", time: 0 }, revision: 0, time: { created: 0, updated: 0 }, pinnedAt: 0 }, { sessionID: "ses", parentID: "ses", description: "x".repeat(4097), agent: "a", model: { providerID: "p", id: "m" }, background: false, state: "waiting", revision: 0, time: { created: 0, updated: 0 }, pinnedAt: -1 })
appendSamples("SessionOrchestration.ListAnchor", { rank: 0, updated: 0, sessionID: "ses", direction: "previous" }, { rank: 5, updated: 0, sessionID: "ses", direction: "next" }, { rank: 6, updated: 0, sessionID: "ses", direction: "next" }, { rank: 1.5, updated: 0, sessionID: "ses", direction: "next" })
appendSamples("SessionOrchestration.Control", { action: "send", sessionID: "ses", text: "x".repeat(65536), delivery: "steer" }, { action: "send", sessionID: "ses", text: "x".repeat(65537), delivery: "steer" }, { action: "answer", sessionID: "ses", questionID: "qst_x", data: { a: 1 } }, { action: "cancel", sessionID: "ses" }, { action: "resume", sessionID: "ses" }, { action: "answer", sessionID: "ses", questionID: "qst_x", data: null })
appendSamples("SessionOrchestration.Report", { action: "question", text: "x".repeat(8192), data: { a: 1 } }, { action: "question", text: "x".repeat(8193) }, { action: "question", text: "x", data: null })
appendSamples("SessionOrchestration.Change", { type: "launched", parentID: "ses", parentAssistantMessageID: "msg_x", toolCallID: "x".repeat(512), inputID: "msg_y", description: "d", agent: "a", model: { providerID: "p", id: "m" }, promptDigest: "d", background: true, delivery: "queue" }, { type: "launched", parentID: "ses", parentAssistantMessageID: "msg_x", toolCallID: "x".repeat(513), inputID: "msg_y", description: "d", agent: "a", model: { providerID: "p", id: "m" }, promptDigest: "d", background: true, delivery: "queue" }, { type: "progressed", progress: { text: "p", time: 0 } }, { type: "question_asked", question: { id: "qst_x", text: "q", time: 0 } }, { type: "question_answered", answer: { questionID: "qst_x" } }, { type: "cancel_requested" }, { type: "cancelled" }, { type: "completed", excerpt: "e" }, { type: "failed", error: "e" }, { type: "lost" })
appendSamples("SessionOrchestration.Notification", { id: "n", parentID: "ses", childID: "ses", type: "question", excerpt: "x".repeat(16384), revision: 0 }, { id: "n", parentID: "ses", childID: "ses", type: "question", excerpt: "x".repeat(16385), revision: 0 }, { id: "n", parentID: "ses", childID: "ses", type: "unknown", revision: 0 })
appendSamples("SessionOrchestration.Page", { data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: { previous: "p", next: "n" } })
appendSamples("SessionOrchestration.TeamView", { children: [], omitted: 0 }, { children: [], omitted: 1 })
appendSamples("SessionSkillStatus.State", { state: "active" }, { state: "active", inactiveReason: "compacted" }, { state: "inactive", inactiveReason: "agent_switched" }, { state: "inactive", inactiveReason: "conflict_resolved" }, { state: "inactive" })
appendSamples("SessionSkillStatus.Conflict", { type: "instruction", id: "i", name: "n" }, { type: "other", id: "i", name: "n" })
appendSamples("SessionSkillStatus.Info", { id: "s", name: "n", activatedBy: "reference", activationMessageID: "msg_x", content: "c", conflicts: [{ type: "instruction", id: "i", name: "n" }], declarations: { skills: [], instructions: [] }, state: "inactive", inactiveReason: "agent_switched" }, { id: "s", name: "n", activatedBy: "other", activationMessageID: "msg_x", content: "c", conflicts: [], declarations: { skills: [], instructions: [] }, state: "active" }, { id: "s", name: "n", activatedBy: "tool", activationMessageID: "msg_x", content: "c", conflicts: [], declarations: { skills: [], instructions: [] }, state: "active", inactiveReason: null })
appendSamples("SessionWorkCompletion.Receipt", { id: "evt_x", seq: 0, created: 0, sessionID: "ses", inputID: "msg_x", assistantMessageID: "msg_y" }, { id: "evt_x", seq: -1, created: 0, sessionID: "ses", inputID: "msg_x", assistantMessageID: "msg_y" }, { id: "evt_x", seq: 0, created: -1, sessionID: "ses", inputID: "msg_x", assistantMessageID: "msg_y" })
appendSamples("SessionWorkCompletion.Page", { data: [{ id: "evt_x", seq: 0, created: 0, sessionID: "ses", inputID: "msg_x", assistantMessageID: "msg_y" }], next: "ses" })

function supportGoldens() {
  const outcome = (run: () => unknown) => {
    try {
      return JSON.stringify(run())
    } catch {
      return null
    }
  }
  const entropy = [0, 1, 61, 62, 255, 128, 254, 63, 31, 32, 60, 250, 16, 17]
  const descriptor = Object.getOwnPropertyDescriptor(crypto, "getRandomValues")
  Object.defineProperty(crypto, "getRandomValues", {
    configurable: true,
    value: (array: Uint8Array) => {
      array.set(entropy)
      return array
    },
  })
  const identifierCases = (() => {
    try {
      const identifiers = [
        { timestamp: 0, descending: false },
        { timestamp: 0, descending: true },
        { timestamp: 1, descending: false },
        { timestamp: 1, descending: true },
        { timestamp: -1, descending: false },
        { timestamp: 1700000000000, descending: true },
        { timestamp: 9007199254740992, descending: false },
        { timestamp: 1e30, descending: true },
        { timestamp: -1e30, descending: false },
      ].map((input) => ({
        timestamp: JSON.stringify(input.timestamp),
        descending: input.descending,
        entropy,
        output: create(input.descending, input.timestamp),
      }))
      const invalidIdentifiers = ["0", "1.5", "0", "1e400", "0", "-1e400", "0", "-1.5", "0"].map((timestamp) => ({
        timestamp,
        entropy,
        output: outcome(() => create(false, JSON.parse(timestamp))),
      }))
      return { identifiers, invalidIdentifiers }
    } finally {
      if (descriptor) Object.defineProperty(crypto, "getRandomValues", descriptor)
      if (!descriptor) Reflect.deleteProperty(crypto, "getRandomValues")
    }
  })()
  const definitions = [
    Event.durable({ type: "a", durable: { version: 1, aggregate: "a" }, schema: {} }),
    Event.ephemeral({ type: "b", schema: {} }),
    Event.durable({ type: "a", durable: { version: 2, aggregate: "a" }, schema: {} }),
  ]
  const inventories = [
    [0, 1, 2],
    [2, 1, 0],
    [0, 0],
    [2, 2],
    [1, 1],
    [0, 2, 0, 2],
  ].map((indices) => ({
    indices,
    latest: outcome(() =>
      Array.from(Event.latest(indices.map((index) => definitions[index])), ([key, definition]) => [
        key,
        definition.durable?.version ?? null,
      ]),
    ),
    durableMap: outcome(() => Array.from(Event.durableMap(indices.map((index) => definitions[index])), ([key]) => key)),
  }))
  const versions = ["-1", "-0", "1", "1.5", "1e21", "1e400", "-1e400"].map((input) => ({
    input,
    output: JSON.stringify(Event.versionedType("a\ud800", JSON.parse(input))),
  }))
  const undefinedOptional = Schema.encodeSync(
    Schema.Struct({
      a: optional(Schema.String),
      b: optional(Schema.NullOr(Schema.String)),
      c: optional(Schema.Unknown),
    }),
  )({ a: undefined, b: null, c: undefined })
  if (JSON.stringify(Object.keys(undefinedOptional)) !== '["b"]')
    throw new Error("optional helper did not omit undefined keys")
  return { ...identifierCases, inventories, versions, eventManifests: { all: EventManifest.Definitions.map((definition) => definition.type), server: EventManifest.ServerDefinitions.map((definition) => definition.type), durable: Array.from(DurableEventManifest.Durable.keys()) } }
}

if (import.meta.main) {
  const fixtures = goldens(corpus)
  await Bun.write(new URL("./fixtures/domain-types.json", import.meta.url), `${JSON.stringify(fixtures, null, 2)}\n`)
  await Bun.write(
    new URL("./fixtures/domain-support.json", import.meta.url),
    `${JSON.stringify(supportGoldens(), null, 2)}\n`,
  )
  console.log(
    JSON.stringify({
      bun: Bun.version,
      types: corpus.length,
      goldens: fixtures.length,
      accepted: fixtures.filter((entry) => entry.output !== null).length,
      rejected: fixtures.filter((entry) => entry.output === null).length,
    }),
  )
}
