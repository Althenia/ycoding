export * as MemorySearch from "./search"

import { MemoryFormat } from "./format"

const k1 = 1.2
const b = 0.75
const weights = [4, 2, 1]
const snippetLength = 320
const snippetLead = 60

interface Span {
  readonly start: number
  readonly end: number
}

export function rank(
  concepts: readonly MemoryFormat.Concept[],
  options: { readonly query: string; readonly limit: number; readonly type?: string; readonly tag?: string },
) {
  const matching = new Set(MemoryFormat.words(options.query))
  const terms = [...matching].sort(MemoryFormat.compare)
  const documents = concepts.map((concept) => ({
    concept,
    fields: [
      `${concept.title ?? ""} ${concept.id}`,
      `${concept.type} ${(concept.tags ?? []).join(" ")} ${concept.description ?? ""}`,
      concept.body,
    ].map(frequencies),
  }))
  const averages = weights.map(
    (_, index) =>
      documents.reduce((total, document) => total + document.fields[index]!.length, 0) / Math.max(documents.length, 1),
  )
  const idf = new Map(
    terms.map((term) => {
      const frequency = documents.filter((document) => document.fields.some((field) => field.counts.has(term))).length
      return [term, Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5))]
    }),
  )
  return documents
    .filter(
      (document) =>
        (!options.type || document.concept.type === options.type) &&
        (!options.tag || document.concept.tags?.includes(options.tag)),
    )
    .map((document) => ({
      document,
      score: terms.reduce(
        (total, term) =>
          total +
          idf.get(term)! *
            document.fields.reduce(
              (sum, field, index) =>
                sum + weights[index]! * saturation(field.counts.get(term) ?? 0, field.length, averages[index]!),
              0,
            ),
        0,
      ),
    }))
    .filter((hit) => hit.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || MemoryFormat.compare(left.document.concept.id, right.document.concept.id),
    )
    .slice(0, options.limit)
    .map((hit) => ({
      ...MemoryFormat.summary(hit.document.concept),
      score: hit.score,
      snippet: snippet(hit.document.concept.body, matching),
    }))
}

function frequencies(text: string) {
  const tokens = MemoryFormat.words(text)
  const counts = new Map<string, number>()
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
  return { length: tokens.length, counts }
}

function saturation(frequency: number, length: number, average: number) {
  if (frequency === 0) return 0
  return (frequency * (k1 + 1)) / (frequency + k1 * (1 - b + (b * length) / average))
}

function snippet(body: string, terms: ReadonlySet<string>) {
  const tokens = MemoryFormat.words(body)
  const inBody = tokens.some((token) => terms.has(token))
  const spans: Span[] = []
  let match: Span | undefined
  for (const span of tokenSpans(body)) {
    if (inBody && !match && terms.has(tokens[spans.length])) match = span
    spans.push(span)
    if ((match || !inBody) && span.start >= (match?.start ?? 0) + snippetLength) break
  }
  const lead = Math.max(0, (match?.start ?? 0) - snippetLead)
  const start = codePointStart(body, spans.find((span) => span.start < lead && lead < span.end)?.end ?? lead)
  const limit = Math.min(body.length, start + snippetLength)
  const cut = spans.find((span) => span.start < limit && limit < span.end)
  const end = codePointEnd(body, cut && cut !== match && cut.start > start ? cut.start : limit)
  return body.slice(start, end).trim()
}

function* tokenSpans(text: string): Generator<Span> {
  let start: number | undefined
  for (const cluster of text.matchAll(/\P{M}\p{M}*|\p{M}+/gu)) {
    const normalized = cluster[0].toLowerCase().normalize("NFC")
    if (!/^[\p{L}\p{N}_]/u.test(normalized)) {
      if (start !== undefined) yield { start, end: cluster.index }
      start = undefined
      continue
    }
    start ??= cluster.index
    if (/[^\p{L}\p{N}_]/u.test(normalized)) {
      yield { start, end: cluster.index + cluster[0].length }
      start = undefined
    }
  }
  if (start !== undefined) yield { start, end: text.length }
}

function codePointStart(text: string, index: number) {
  return isLow(text.charCodeAt(index)) && isHigh(text.charCodeAt(index - 1)) ? index + 1 : index
}

function codePointEnd(text: string, index: number) {
  return isHigh(text.charCodeAt(index - 1)) && isLow(text.charCodeAt(index)) ? index - 1 : index
}

function isHigh(code: number) {
  return code >= 0xd800 && code <= 0xdbff
}

function isLow(code: number) {
  return code >= 0xdc00 && code <= 0xdfff
}
