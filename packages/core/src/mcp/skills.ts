export * as MCPSkills from "./skills"

import { createHash } from "node:crypto"
import { Buffer } from "node:buffer"
import { Option, Schema } from "effect"
import { McpSkill } from "@ycoding-ai/schema/mcp-skill"

/**
 * Pure helpers for the MCP Skills extension (`io.modelcontextprotocol/skills`).
 * Nothing here performs I/O: callers own transport reads, caching, and permissions.
 */

export const EXTENSION_ID = McpSkill.EXTENSION_ID
export const MAX_RESOURCES_PER_SKILL = McpSkill.MAX_RESOURCES_PER_SKILL
export const MAX_TOTAL_BYTES_PER_SKILL = McpSkill.MAX_TOTAL_BYTES_PER_SKILL

export const Entry = McpSkill.Entry
export type Entry = McpSkill.Entry
export const File = McpSkill.File
export type File = McpSkill.File
export const Reason = McpSkill.Reason
export type Reason = McpSkill.Reason
export const Capability = McpSkill.Capability
export type Capability = McpSkill.Capability

export const LIST_METHOD = McpSkill.LIST_METHOD
export const GET_METHOD = McpSkill.GET_METHOD
export const DIRECTORY_READ_METHOD = McpSkill.DIRECTORY_READ_METHOD
export const SKILL_MD = McpSkill.SKILL_MD

export const digest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`

/** Reads a declared server capability from a raw `server/discover` capabilities object. */
export function capability(raw: unknown): McpSkill.Capability | undefined {
  const decoded = Schema.decodeUnknownOption(Capabilities)(raw)
  if (Option.isNone(decoded)) return undefined
  if (decoded.value.resources === undefined) return undefined
  const value = decoded.value.extensions?.[EXTENSION_ID]
  if (value === undefined) return undefined
  return Schema.decodeUnknownOption(McpSkill.Capability)(value).valueOrUndefined
}

const Capabilities = Schema.Struct({
  resources: Schema.optionalKey(Schema.Unknown),
  extensions: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
})

export type EntryFailure = { readonly ok: false; readonly reason: McpSkill.Reason }
export type EntryResult = { readonly ok: true; readonly entry: McpSkill.Entry } | EntryFailure

/**
 * Validates one entry and its per-skill limits from the entry alone, before any file is retrieved.
 * `server` is the host-assigned label; it is stamped onto the entry so identity is never the URI alone.
 * A dynamic entry is structurally valid: it is declined when a caller tries to load it.
 *
 * The URI is schema-unvalidated text from a remote server, so it is parsed here once and its shape is
 * checked against the extension's resource mapping: a `SKILL.md` URI whose final path segment is the
 * declared name.
 */
export function entry(server: string, raw: unknown): EntryResult {
  const decoded = Schema.decodeUnknownOption(McpSkill.Entry)(
    typeof raw === "object" && raw !== null && !Array.isArray(raw) ? { ...raw, server } : raw,
  )
  if (Option.isNone(decoded)) return { ok: false, reason: "decode-error" }
  const value = decoded.value
  const location = skillLocation(value.uri)
  if (location === undefined) return { ok: false, reason: "malformed-uri" }
  if (location.name !== value.frontmatter.name) return { ok: false, reason: "name-mismatch" }
  if (value.resources === "dynamic") return { ok: true, entry: value }
  if (value.resources.length > MAX_RESOURCES_PER_SKILL) return { ok: false, reason: "limit-resources" }
  const total = value.resources.reduce((sum: number, resource) => sum + resource.size, 0)
  if (total > MAX_TOTAL_BYTES_PER_SKILL) return { ok: false, reason: "limit-bytes" }
  const seen = new Set<string>()
  for (const resource of value.resources) {
    // The manifest is addressed relative to the server's skill namespace, so containment is on the
    // path only: the same server may serve the skill under any scheme.
    if (!contained(location.root, resource.uri)) return { ok: false, reason: "resource-outside-skill" }
    if (seen.has(resource.uri)) return { ok: false, reason: "duplicate-resource" }
    seen.add(resource.uri)
  }
  if (!seen.has(value.uri)) return { ok: false, reason: "missing-skill-md" }
  return { ok: true, entry: value }
}

export type FileResult = { readonly ok: true; readonly file: McpSkill.File } | EntryFailure

/**
 * Verifies one retrieved file against the entry's manifest. Size and digest mismatches, and reads of
 * files the manifest does not list, are verification failures; the content must not be used.
 */
export function file(input: {
  readonly entry: McpSkill.Entry
  readonly uri: string
  readonly size: number
  readonly digest: string
  readonly mimeType?: string
  readonly text?: string
  readonly blob?: string
}): FileResult {
  if (input.entry.resources === "dynamic") return { ok: false, reason: "dynamic" }
  const listed = input.entry.resources.find((resource) => resource.uri === input.uri)
  if (!listed) return { ok: false, reason: "unlisted-resource" }
  if (input.size !== listed.size) return { ok: false, reason: "size-mismatch" }
  if (input.digest !== listed.digest) return { ok: false, reason: "digest-mismatch" }
  const content =
    input.text !== undefined && input.blob === undefined
      ? { text: input.text }
      : input.blob !== undefined && input.text === undefined
        ? { blob: input.blob }
        : undefined
  if (!content) return { ok: false, reason: "decode-error" }
  return {
    ok: true,
    file: {
      server: input.entry.server,
      uri: input.uri,
      size: listed.size,
      mimeType: input.mimeType,
      ...content,
    },
  }
}

/**
 * Compares the frontmatter parsed from the loaded `SKILL.md` against the held entry field by field.
 * A discrepancy is a verification failure equivalent to a digest mismatch. Comparison is by value, so
 * nested objects compare equal regardless of key order.
 */
export function frontmatter(entry: McpSkill.Entry, parsed: unknown): { readonly ok: true } | EntryFailure {
  const decoded = Schema.decodeUnknownOption(Record_)(parsed)
  if (Option.isNone(decoded)) return { ok: false, reason: "frontmatter-missing" }
  const actual = decoded.value
  const expected = entry.frontmatter
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)])
  for (const key of keys) {
    if (canonical(actual[key]) !== canonical(expected[key])) return { ok: false, reason: "frontmatter-mismatch" }
  }
  return { ok: true }
}

const Record_ = Schema.Record(Schema.String, Schema.Json)

/**
 * Content-bound approval identity derived from the entry's digest set. It reuses the existing
 * permission resource shape, so no permission-schema migration is required.
 */
export function identity(entry: McpSkill.Entry): string {
  const resources = entry.resources === "dynamic" ? [] : entry.resources
  const manifest = resources
    .map((resource) => ({ uri: resource.uri, digest: resource.digest, size: resource.size }))
    .toSorted((a, b) => a.uri.localeCompare(b.uri) || a.digest.localeCompare(b.digest) || a.size - b.size)
  return `mcp-skill:sha256:${createHash("sha256")
    .update(JSON.stringify({ server: entry.server, uri: entry.uri, resources: manifest }))
    .digest("hex")}`
}

/** Collision-safe, reversible model-facing ID for the pair that identifies an MCP-served skill. */
export const id = (server: string, uri: string) =>
  `mcp:${Buffer.from(JSON.stringify([server, uri]), "utf8").toString("base64url")}`

/** Recovers an origin pair only from the canonical ID emitted by `id`. */
export function origin(value: string): { readonly server: string; readonly uri: string } | undefined {
  if (!value.startsWith("mcp:")) return undefined
  const decoded = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(Buffer.from(value.slice(4), "base64url").toString("utf8")),
  )
  if (!Array.isArray(decoded) || decoded.length !== 2 || decoded.some((part) => typeof part !== "string"))
    return undefined
  const [server, uri] = decoded
  if (server === undefined || uri === undefined || id(server, uri) !== value) return undefined
  return { server, uri }
}

/**
 * Resolves a reference in a skill's body against the skill root, rejecting escapes. A malformed
 * reference or skill URI yields no resolution rather than throwing.
 */
export function resolve(entry: McpSkill.Entry, reference: string) {
  const location = skillLocation(entry.uri)
  if (location === undefined) return undefined
  if (reference === "") return undefined
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(reference)) return undefined
  if (reference.includes("\\") || reference.includes("\0") || reference.includes("?") || reference.includes("#")) {
    return undefined
  }
  const resolved = safely(() => new URL(reference, `${location.root}/`).href)
  if (resolved === undefined) return undefined
  return contained(location.root, resolved) ? resolved : undefined
}

/** Parses an absolute skill URI without imposing a preferred scheme. */
const skillLocation = (uri: string): { readonly root: string; readonly name: string } | undefined => {
  if (!URL.canParse(uri)) return undefined
  const parsed = safely(() => new URL(uri))
  if (!parsed || parsed.search !== "" || parsed.hash !== "" || uri.includes("\\") || uri.includes("\0"))
    return undefined
  if (!uri.endsWith(`/${SKILL_MD}`)) return undefined
  const root = uri.slice(0, -`/${SKILL_MD}`.length)
  if (root === "") return undefined
  const path = parsed.pathname.split("/").filter((segment) => segment !== "")
  if (path.at(-1) !== SKILL_MD) return undefined
  path.pop()
  const name = path.at(-1) ?? parsed.hostname
  if (!name || invalidSegment(name)) return undefined
  return { root, name }
}

const safely = <A>(compute: () => A): A | undefined => {
  try {
    return compute()
  } catch {
    return undefined
  }
}

/** Order-independent JSON encoding, so nested values compare by content rather than key insertion order. */
const canonical = (value: unknown): string => {
  if (value === undefined) return "undefined"
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`
  }
  return JSON.stringify(value) ?? "undefined"
}

const contained = (root: string, uri: string) => {
  if (!URL.canParse(uri)) return false
  const parsed = safely(() => new URL(uri))
  if (!parsed || parsed.search !== "" || parsed.hash !== "") return false
  if (!uri.startsWith(`${root}/`)) return false
  const rest = uri.slice(root.length + 1)
  if (rest === "") return false
  return rest.split("/").every((segment) => !invalidSegment(segment))
}

const invalidSegment = (segment: string) => {
  if (segment === "" || segment.includes("\\") || segment.includes("\0")) return true
  const decoded = safely(() => decodeURIComponent(segment))
  return (
    decoded === undefined ||
    decoded === "." ||
    decoded === ".." ||
    decoded.includes("/") ||
    decoded.includes("\\") ||
    decoded.includes("\0")
  )
}
