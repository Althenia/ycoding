export * as McpSkill from "./mcp-skill.js"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "./schema.js"

/**
 * Browser-safe wire contract for the MCP Skills extension (`io.modelcontextprotocol/skills`).
 * The skill format and the extension semantics are defined outside MCP; this module carries only
 * the transport binding shapes that Clients and Protocol must decode.
 */
export const EXTENSION_ID = "io.modelcontextprotocol/skills"
export const LIST_METHOD = "skills/list"
export const GET_METHOD = "skills/get"
export const DIRECTORY_READ_METHOD = "resources/directory/read"
export const SKILL_MD = "SKILL.md"

/** The extension's fixed per-skill limits, counted over the entry's `resources` set. */
export const MAX_RESOURCES_PER_SKILL = 512
export const MAX_TOTAL_BYTES_PER_SKILL = 16 * 1024 * 1024

export const Digest = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))
export type Digest = typeof Digest.Type

export interface ResourceEntry extends Schema.Schema.Type<typeof ResourceEntry> {}
export const ResourceEntry = Schema.Struct({
  uri: Schema.String,
  digest: Digest,
  size: NonNegativeInt,
}).annotate({ identifier: "McpSkill.ResourceEntry" })

/**
 * A skill as served by one MCP server. `server` is the host-assigned label from MCP configuration,
 * never the server's self-reported name: a skill's identity is the pair of server and `uri`.
 */
export interface Entry extends Schema.Schema.Type<typeof Entry> {}
export const Entry = Schema.Struct({
  server: Schema.String,
  uri: Schema.String,
  frontmatter: Schema.StructWithRest(Schema.Struct({ name: Schema.String, description: Schema.String }), [
    Schema.Record(Schema.String, Schema.Json),
  ]),
  resources: Schema.Union([Schema.Array(ResourceEntry), Schema.Literal("dynamic")]),
}).annotate({ identifier: "McpSkill.Entry" })

export interface Capability extends Schema.Schema.Type<typeof Capability> {}
export const Capability = Schema.Struct({
  directoryRead: optional(Schema.Boolean),
}).annotate({ identifier: "McpSkill.Capability" })

const FileFields = {
  server: Schema.String,
  uri: Schema.String,
  size: NonNegativeInt,
  mimeType: optional(Schema.String),
}

/** One digest-verified skill file. Exactly one of `text` or `blob` is present. */
export const File = Schema.Union([
  Schema.Struct({ ...FileFields, text: Schema.String }),
  Schema.Struct({ ...FileFields, blob: Schema.String }),
]).annotate({ identifier: "McpSkill.File" })
export type File = typeof File.Type

/**
 * Why a skill entry or file was rejected. These are host-side verification outcomes, not protocol
 * errors: the extension defines no error code for them.
 */
export const Reason = Schema.Literals([
  "decode-error",
  "dynamic",
  "extension-unsupported",
  "malformed-uri",
  "not-found",
  "origin-mismatch",
  "uri-mismatch",
  "name-mismatch",
  "missing-skill-md",
  "duplicate-resource",
  "resource-outside-skill",
  "limit-resources",
  "limit-bytes",
  "unlisted-resource",
  "size-mismatch",
  "digest-mismatch",
  "frontmatter-mismatch",
  "frontmatter-missing",
])
export type Reason = typeof Reason.Type
