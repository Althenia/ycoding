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
  requirements: TextList,
  acceptance_criteria: TextList,
  progress: TextList,
  current_state: Schema.String,
  facts: Schema.Array(Fact),
  decisions: Schema.Array(Decision),
  preferences: TextList,
  constraints: TextList,
  completed: TextList,
  pending: TextList,
  blockers: TextList,
  skills: TextList,
  unresolved: TextList,
  important_identifiers: TextList,
  continuation: Schema.String,
})

export type Memory = Schema.Schema.Type<typeof MemoryShape>
type MemoryInput = Omit<Memory, "requirements" | "acceptance_criteria" | "progress" | "skills"> &
  Partial<Pick<Memory, "requirements" | "acceptance_criteria" | "progress" | "skills">>

export interface ParseOptions {
  /** Expected session boundary that the summary must claim via `through_sequence`. */
  readonly throughSequence: number
  /** Advisory UTF-8 byte target for the summary; parsing never rejects on size. */
  readonly maxSummaryBytes: number
}

const REQUIRED_FIELDS = [
  "version",
  "through_sequence",
  "objective",
  "requirements",
  "acceptance_criteria",
  "progress",
  "current_state",
  "facts",
  "decisions",
  "preferences",
  "constraints",
  "completed",
  "pending",
  "blockers",
  "skills",
  "unresolved",
  "important_identifiers",
  "continuation",
]

const KEY_LINE = /^\s*(?:"(?:\\.|[^"\\])*"|[^\s":]+)\s*:/
const TABLE_HEADER = /\[(\d+|\*)\]\s*\{[^}]*\}\s*:\s*$/
const ROW_LINE = /^\s+(?:"(?:\\.|[^"\\])*"|[^",]+)(?:\s*,\s*(?:"(?:\\.|[^"\\])*"|[^",]+))*\s*$/
const DASH_LINE = /^\s*-\s*/
const COMMENT_LINE = /^\s*#/
const FENCE_LINE = /^\s*```/

/**
 * Encodes a conversation memory as a TOON document rooted at `conversation_memory`.
 */
export function encode(memory: MemoryInput): string {
  // toon's `encode` is Array.from(encodeLines(x)).join("\n"); use encodeLines so the
  // library's export does not shadow the `encode` defined here.
  return Array.from(
    encodeLines({
      conversation_memory: {
        version: memory.version,
        through_sequence: memory.through_sequence,
        objective: memory.objective,
        requirements: memory.requirements ?? [],
        acceptance_criteria: memory.acceptance_criteria ?? [],
        progress: memory.progress ?? [],
        current_state: memory.current_state,
        facts: memory.facts,
        decisions: memory.decisions,
        preferences: memory.preferences,
        constraints: memory.constraints,
        completed: memory.completed,
        pending: memory.pending,
        blockers: memory.blockers,
        skills: memory.skills ?? [],
        unresolved: memory.unresolved,
        important_identifiers: memory.important_identifiers,
        continuation: memory.continuation,
      },
    }),
  ).join("\n")
}

/** Retains source-backed text verbatim in existing TOON v1 fields. */
export function retainRequiredTexts(memory: Memory, texts: ReadonlyArray<string>): Memory {
  return texts
    .filter((text, index) => text.trim() && texts.indexOf(text) === index)
    .reduce<Memory>(
      (result, text) => {
        if (memoryTexts(result).some((value) => value.includes(text))) return result
        if (/^objective\s*:/i.test(text)) return { ...result, objective: text }
        if (/\bactive skill\b/i.test(text)) return { ...result, skills: [...result.skills, text] }
        if (/\baccept(?:ance)?[ _-]?criteria\b/i.test(text))
          return { ...result, acceptance_criteria: [...result.acceptance_criteria, text] }
        if (/\brequirement\b/i.test(text)) return { ...result, requirements: [...result.requirements, text] }
        if (/\b(?:accepted|rejected|superseded) decision\b/i.test(text)) {
          const status = /\brejected decision\b/i.test(text)
            ? "rejected"
            : /\bsuperseded decision\b/i.test(text)
              ? "superseded"
              : "accepted"
          return { ...result, decisions: [...result.decisions, { text, status }] }
        }
        if (/\bblocker\b/i.test(text)) return { ...result, blockers: [...result.blockers, text] }
        if (/\b(?:pending|todo|next action)\b/i.test(text)) return { ...result, pending: [...result.pending, text] }
        if (/\b(?:progress|in[_ -]?progress|completed|validation)\b/i.test(text))
          return { ...result, progress: [...result.progress, text] }
        return { ...result, facts: [...result.facts, { text, confidence: "confirmed" }] }
      },
      memory,
    )
}

/**
 * Parses a TOON conversation_memory document, returning the validated memory or a
 * tagged error. `options.throughSequence` must match the document's `through_sequence`.
 * `options.maxSummaryBytes` is advisory: an oversized document still parses.
 */
export function parse(input: string, options: ParseOptions): Memory | ParseError {
  if (isFencedDocument(input)) return new CodeFenceError({})
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

function isFencedDocument(input: string) {
  const lines = input.split(/\r?\n/).filter((line) => line.trim())
  return lines.length >= 2 && FENCE_LINE.test(lines[0]) && FENCE_LINE.test(lines[lines.length - 1])
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
    memory.requirements,
    memory.acceptance_criteria,
    memory.progress,
    memory.facts,
    memory.decisions,
    memory.preferences,
    memory.constraints,
    memory.completed,
    memory.pending,
    memory.blockers,
    memory.skills,
    memory.unresolved,
    memory.important_identifiers,
  ]
  return !text.some((value) => value.trim()) && lists.every((list) => list.length === 0)
}

function memoryTexts(memory: Memory) {
  return [
    memory.objective,
    ...memory.requirements,
    ...memory.acceptance_criteria,
    ...memory.progress,
    memory.current_state,
    memory.continuation,
    ...memory.facts.map((fact) => fact.text),
    ...memory.decisions.map((decision) => decision.text),
    ...memory.preferences,
    ...memory.constraints,
    ...memory.completed,
    ...memory.pending,
    ...memory.blockers,
    ...memory.skills,
    ...memory.unresolved,
    ...memory.important_identifiers,
  ]
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
    if (!line.trim() || COMMENT_LINE.test(line)) continue
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
