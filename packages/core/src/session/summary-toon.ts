export * as SessionSummaryToon from "./summary-toon"

import { Result, Schema } from "effect"
import { decode, encodeLines, ToonDecodeError } from "@toon-format/toon"

export class InvalidToonError extends Schema.TaggedErrorClass<InvalidToonError>()("SessionSummary.InvalidToonError", {
  reason: Schema.String,
}) {
  override get message() {
    return this.reason
  }
}

export class WrongRootError extends Schema.TaggedErrorClass<WrongRootError>()("SessionSummary.WrongRootError", {
  got: Schema.String,
}) {
  override get message() {
    return `Expected a document rooted at conversation_memory, got ${this.got}`
  }
}

export class MissingFieldError extends Schema.TaggedErrorClass<MissingFieldError>()("SessionSummary.MissingFieldError", {
  fields: Schema.Array(Schema.String),
}) {
  override get message() {
    return `Missing required field(s): ${this.fields.join(", ")}`
  }
}

export class UnsupportedVersionError extends Schema.TaggedErrorClass<UnsupportedVersionError>()(
  "SessionSummary.UnsupportedVersionError",
  { version: Schema.String },
) {
  override get message() {
    return `Unsupported summary version: ${this.version}; supported: [1]`
  }
}

export class SequenceMismatchError extends Schema.TaggedErrorClass<SequenceMismatchError>()(
  "SessionSummary.SequenceMismatchError",
  { expected: Schema.String, actual: Schema.String },
) {
  override get message() {
    return `through_sequence mismatch: expected ${this.expected}, got ${this.actual}`
  }
}

export class InvalidElementError extends Schema.TaggedErrorClass<InvalidElementError>()(
  "SessionSummary.InvalidElementError",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason
  }
}

export class EmptySummaryError extends Schema.TaggedErrorClass<EmptySummaryError>()("SessionSummary.EmptySummaryError", {}) {
  override get message() {
    return "Summary contains no meaningful content"
  }
}

export class SummaryTooLargeError extends Schema.TaggedErrorClass<SummaryTooLargeError>()(
  "SessionSummary.SummaryTooLargeError",
  { bytes: Schema.Number, maxBytes: Schema.Number },
) {
  override get message() {
    return `Summary exceeds ${this.maxBytes} bytes (got ${this.bytes})`
  }
}

export class CodeFenceError extends Schema.TaggedErrorClass<CodeFenceError>()("SessionSummary.CodeFenceError", {}) {
  override get message() {
    return "Markdown code fences are not allowed in the summary"
  }
}

export class ProseError extends Schema.TaggedErrorClass<ProseError>()("SessionSummary.ProseError", {
  line: Schema.Number,
}) {
  override get message() {
    return `Found prose outside the TOON document at line ${this.line}`
  }
}

export type ParseError =
  | InvalidToonError
  | WrongRootError
  | MissingFieldError
  | UnsupportedVersionError
  | SequenceMismatchError
  | InvalidElementError
  | EmptySummaryError
  | SummaryTooLargeError
  | CodeFenceError
  | ProseError

const Confidence = Schema.Literals(["confirmed", "likely", "uncertain"])
const Fact = Schema.Struct({ text: Schema.String, confidence: Confidence })
const DecisionStatus = Schema.Literals(["accepted", "rejected", "superseded"])
const Decision = Schema.Struct({ text: Schema.String, status: DecisionStatus })
const TextList = Schema.Array(Schema.String)

const MemoryShape = Schema.Struct({
  version: Schema.Literal(1),
  through_sequence: Schema.Int,
  objective: Schema.String,
  current_state: Schema.String,
  facts: Schema.Array(Fact),
  decisions: Schema.Array(Decision),
  preferences: TextList,
  constraints: TextList,
  completed: TextList,
  pending: TextList,
  blockers: TextList,
  unresolved: TextList,
  important_identifiers: TextList,
  continuation: Schema.String,
})

export type Memory = Schema.Schema.Type<typeof MemoryShape>

export interface ParseOptions {
  /** Expected session boundary that the summary must claim via `through_sequence`. */
  readonly throughSequence: number
  /** Upper bound on the raw input's UTF-8 byte length. */
  readonly maxSummaryBytes: number
}

const REQUIRED_FIELDS = [
  "version",
  "through_sequence",
  "objective",
  "current_state",
  "facts",
  "decisions",
  "preferences",
  "constraints",
  "completed",
  "pending",
  "blockers",
  "unresolved",
  "important_identifiers",
  "continuation",
]

const KEY_LINE = /^\s*(?:"(?:\\.|[^"\\])*"|[^\s":]+)\s*:/
const TABLE_HEADER = /\[(\d+|\*)\]\s*\{[^}]*\}\s*:\s*$/
const ROW_LINE = /^\s+(?:"(?:\\.|[^"\\])*"|[^",]+)(?:\s*,\s*(?:"(?:\\.|[^"\\])*"|[^",]+))*\s*$/
const DASH_LINE = /^\s*-\s*/
const FENCE = /```/

/**
 * Encodes a conversation memory as a TOON document rooted at `conversation_memory`.
 */
export function encode(memory: Memory): string {
  // toon's `encode` is Array.from(encodeLines(x)).join("\n"); use encodeLines so the
  // library's export does not shadow the `encode` defined here.
  return Array.from(encodeLines({ conversation_memory: memory })).join("\n")
}

/**
 * Parses a TOON conversation_memory document, returning the validated memory or a
 * tagged error. `options.throughSequence` must match the document's `through_sequence`
 * and the raw input's byte length must stay within `options.maxSummaryBytes`.
 */
export function parse(input: string, options: ParseOptions): Memory | ParseError {
  const bytes = new TextEncoder().encode(input).byteLength
  if (bytes > options.maxSummaryBytes) return new SummaryTooLargeError({ bytes, maxBytes: options.maxSummaryBytes })
  if (FENCE.test(input)) return new CodeFenceError({})
  const proseLine = findProseLine(input)
  if (proseLine !== undefined) return new ProseError({ line: proseLine })
  const decoded = decodeToon(input)
  if (decoded instanceof InvalidToonError) return decoded
  const found = rootBody(decoded)
  if ("reason" in found) return new WrongRootError({ got: found.reason })
  const body = found.body
  if (!Object.hasOwn(body, "version")) return new MissingFieldError({ fields: ["version"] })
  if (body.version !== 1) return new UnsupportedVersionError({ version: String(body.version) })
  if (!Object.hasOwn(body, "through_sequence")) return new MissingFieldError({ fields: ["through_sequence"] })
  if (body.through_sequence !== options.throughSequence)
    return new SequenceMismatchError({ expected: String(options.throughSequence), actual: String(body.through_sequence) })
  const missing = REQUIRED_FIELDS.filter((field) => !Object.hasOwn(body, field))
  if (missing.length) return new MissingFieldError({ fields: missing })
  const result = Schema.decodeUnknownResult(MemoryShape)(body)
  if (Result.isFailure(result)) return new InvalidElementError({ reason: result.failure.message })
  if (isEmpty(result.success)) return new EmptySummaryError({})
  return result.success
}

function decodeToon(input: string): unknown | InvalidToonError {
  // @toon-format/toon throws ToonDecodeError on malformed input
  try {
    return decode(input)
  } catch (error) {
    if (error instanceof ToonDecodeError) return new InvalidToonError({ reason: error.message })
    throw error
  }
}

function rootBody(value: unknown): { body: Record<string, unknown> } | { reason: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { reason: "not an object document" }
  const rootKeys = Object.keys(value)
  if (rootKeys.length !== 1)
    return { reason: rootKeys.length === 0 ? "an empty document" : `a document with ${rootKeys.length} root keys` }
  const rootKey = rootKeys[0]
  if (rootKey !== "conversation_memory") return { reason: `a document rooted at "${rootKey}"` }
  return { body: (value as Record<string, unknown>)[rootKey] as Record<string, unknown> }
}

function isEmpty(memory: Memory): boolean {
  const text = [memory.objective, memory.current_state, memory.continuation]
  const lists = [
    memory.facts,
    memory.decisions,
    memory.preferences,
    memory.constraints,
    memory.completed,
    memory.pending,
    memory.blockers,
    memory.unresolved,
    memory.important_identifiers,
  ]
  return !text.some((value) => value.trim()) && lists.every((list) => list.length === 0)
}

/**
 * Returns the 1-based line of the first line that is not part of a single-root TOON
 * document: prose before the document, unindented lines after the root, or indented
 * lines that do not match key, dash-item, or tabular-row syntax.
 */
function findProseLine(input: string): number | undefined {
  let firstContent = true
  let inTable = false
  for (const [index, line] of input.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    if (firstContent) {
      firstContent = false
      if (!KEY_LINE.test(line)) return index + 1
      inTable = TABLE_HEADER.test(line)
      continue
    }
    if (!/^\s/.test(line)) return index + 1
    if (inTable && ROW_LINE.test(line)) continue
    inTable = TABLE_HEADER.test(line)
    if (KEY_LINE.test(line) || DASH_LINE.test(line)) continue
    return index + 1
  }
  return undefined
}
