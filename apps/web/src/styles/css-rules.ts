/**
 * Source-level stylesheet reader for the design-system contract tests.
 *
 * The stylesheets are the artifact under test: the approved token contract names
 * values and layering in CSS, so the tests read the rules that ship rather than a
 * transcription of them. A rule keeps the at-rule preludes that enclose it, which
 * is what lets a test assert that a value lives in the right layer (a width step, a
 * pointer step, a reduced-motion step) instead of merely existing.
 */

export type Declarations = Record<string, string>

export type Rule = {
  /** The selector or keyframe step, comma-joined exactly as authored. */
  readonly header: string
  readonly declarations: Declarations
  /** Enclosing at-rule preludes, outermost first, for example `@media (min-width: 768px)`. */
  readonly conditions: readonly string[]
}

export type Stylesheet = {
  readonly name: string
  readonly rules: readonly Rule[]
}

export function parseStylesheet(name: string, source: string): Stylesheet {
  const rules: Rule[] = []
  parseBlocks(source.replace(/\/\*[\s\S]*?\*\//g, ""), [], rules)
  return { name, rules }
}

export function readStylesheet(name: string): Promise<Stylesheet> {
  return Bun.file(new URL(name, import.meta.url))
    .text()
    .then((source) => parseStylesheet(name, source))
}

/** Declarations of every rule that matches, later rules overriding earlier ones. */
export function declarationsWhere(sheet: Stylesheet, predicate: (rule: Rule) => boolean): Declarations {
  return sheet.rules.filter(predicate).reduce<Declarations>((merged, rule) => ({ ...merged, ...rule.declarations }), {})
}

/** The first `(min-width: Npx)` or `(max-width: Npx)` threshold in a media prelude. */
export function widthThreshold(prelude: string): { readonly min?: number; readonly max?: number } | undefined {
  const min = prelude.match(/\(min-width:\s*(\d+)px\)/)
  const max = prelude.match(/\(max-width:\s*(\d+)px\)/)
  if (min?.[1] !== undefined) return { min: Number(min[1]) }
  if (max?.[1] !== undefined) return { max: Number(max[1]) }
  return undefined
}

export function declarationsOf(block: string): Declarations {
  return Object.fromEntries(
    block
      .split(";")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => {
        const separator = entry.indexOf(":")
        return [entry.slice(0, separator).trim(), entry.slice(separator + 1).trim()]
      }),
  )
}

function parseBlocks(source: string, conditions: readonly string[], rules: Rule[]): void {
  let index = 0
  let header = ""
  while (index < source.length) {
    const character = source[index]!
    if (character === "{") {
      const end = matchingBrace(source, index)
      const body = source.slice(index + 1, end)
      const prelude = header.trim()
      if (prelude.startsWith("@")) parseBlocks(body, [...conditions, prelude], rules)
      else rules.push({ header: prelude, declarations: declarationsOf(body), conditions })
      header = ""
      index = end + 1
      continue
    }
    if (character === "}") {
      header = ""
      index += 1
      continue
    }
    header += character
    index += 1
  }
}

function matchingBrace(source: string, open: number): number {
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1
    if (source[index] === "}") {
      depth -= 1
      if (depth === 0) return index
    }
  }
  throw new Error("unbalanced css block")
}
