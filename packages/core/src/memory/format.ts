export * as MemoryFormat from "./format"

import matter from "gray-matter"
import { Option, Schema } from "effect"
import { Hash } from "../util/hash"
import { MemoryError } from "./error"

export const ID = Schema.String.check(
  Schema.isPattern(/^(?!.*(?:^|\/)(?:index|log|_meta|trash)(?:\/|$))[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/),
)
const Metadata = Schema.Struct({
  type: Schema.String.check(Schema.isPattern(/\S/)),
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.Array(Schema.String)),
  sources: Schema.optional(Schema.Array(Schema.Struct({
    // OKF v0.2 requires only `resource`; `id` is optional and only needed when the body cites it.
    id: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/))),
    resource: Schema.String.check(Schema.isPattern(/\S/)),
  }))),
})

export interface Warning { readonly id: string; readonly code: string }
export interface Summary {
  readonly id: string
  readonly type: string
  readonly title?: string
  readonly description?: string
  readonly tags?: readonly string[]
  readonly digest: string
}
export interface Concept extends Summary {
  readonly content: string
  readonly body: string
  readonly links: readonly string[]
}

export function requireID(id: string) {
  if (!Schema.is(ID)(id)) throw new MemoryError({ code: "UnsafePath", message: "Use a non-reserved, slash-separated lowercase concept ID without an extension." })
  return id
}

export async function parse(id: string, content: string): Promise<Concept> {
  requireID(id)
  if (!content.isWellFormed()) throw new MemoryError({ code: "InvalidConcept", message: "Concept must be valid UTF-8 text without unpaired surrogates." })
  const parsed = frontmatter(content)
  const metadata = Schema.decodeUnknownOption(Metadata)(parsed.data)
  if (Option.isNone(metadata)) throw invalid()
  const sources = metadata.value.sources ?? []
  const declared = new Set(sources.flatMap((source) => (source.id === undefined ? [] : [source.id])))
  if (declared.size !== sources.filter((source) => source.id !== undefined).length) throw invalid()
  const { marked } = await import("marked")
  const links: string[] = []
  const unresolved: string[] = []
  // The callback is synchronous, so no promise is produced; walkTokens only types its result as maybe-promise.
  void marked.walkTokens(marked.lexer(parsed.content), (token) => {
    if (token.type === "link") links.push(token.href)
    // A footnote reference resolves to a link token when marked saw a real `def`; only an
    // unresolved reference stays in text. Scanning text therefore catches undefined citations
    // without letting an inline `[^id]: url` line impersonate a definition.
    if (token.type === "text") unresolved.push(token.text)
  })
  if ([...unresolved.join("\n").matchAll(/\[\^([A-Za-z0-9_-]+)\]/g)].some((match) => !declared.has(match[1]))) throw invalid()
  return {
    id, type: metadata.value.type,
    ...(metadata.value.title === undefined ? {} : { title: metadata.value.title }),
    ...(metadata.value.description === undefined ? {} : { description: metadata.value.description }),
    ...(metadata.value.tags === undefined ? {} : { tags: metadata.value.tags }),
    digest: Hash.sha256(content), content, body: parsed.content, links,
  }
}

export function summary(concept: Concept): Summary {
  return {
    id: concept.id, type: concept.type, digest: concept.digest,
    ...(concept.title === undefined ? {} : { title: concept.title }),
    ...(concept.description === undefined ? {} : { description: concept.description }),
    ...(concept.tags === undefined ? {} : { tags: concept.tags }),
  }
}

export function words(value: string) { return value.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [] }
export function compare(left: string, right: string) { return left < right ? -1 : left > right ? 1 : 0 }

function frontmatter(content: string) {
  const text = content.replace(/^\uFEFF/, "")
  if (!/^---\r?\n/.test(text)) throw invalid()
  try { return matter(text) } catch { throw invalid() }
}

function invalid() {
  return new MemoryError({ code: "InvalidConcept", message: "Invalid concept: require YAML type, valid optional metadata, and defined source footnotes." })
}
