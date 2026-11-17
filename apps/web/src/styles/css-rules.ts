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
  readonly line: number
  readonly endLine: number
  readonly conditionLines: readonly number[]
}

export type Stylesheet = {
  readonly name: string
  readonly rules: readonly Rule[]
}

export function parseStylesheet(name: string, source: string): Stylesheet {
  const rules: Rule[] = []
  const text = source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
  parseBlocks(text, [], [], rules, text, 0)
  return { name, rules }
}

export function stylesheetImports(source: string): readonly string[] | undefined {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "")
  const directives = text.match(/(?:^|[;\n])\s*@import\b[^;]*;/g) ?? []
  if ((text.match(/@import\b/g) ?? []).length !== directives.length) return undefined
  const imports: string[] = []
  for (const directive of directives) {
    const match = directive.replace(/^[;\s]+/, "").match(/^@import\s+(["'])(\.[^"']+\.css)\1\s*;$/)
    if (!match?.[2]) return undefined
    imports.push(match[2])
  }
  return imports
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

function parseBlocks(source: string, conditions: readonly string[], conditionLines: readonly number[], rules: Rule[], text: string, offset: number): void {
  let index = 0
  let header = ""
  let quote = ""
  while (index < source.length) {
    const character = source[index]!
    if (character === "\\") {
      header += source.slice(index, index + 2)
      index += 2
      continue
    }
    if (quote || character === '"' || character === "'") {
      header += character
      quote = quote === character ? "" : quote || character
      index += 1
      continue
    }
    if (character === ";") {
      header = ""
      index += 1
      continue
    }
    if (character === "{") {
      const end = matchingBrace(source, index)
      const body = source.slice(index + 1, end)
      const prelude = header.trim()
      const line = text.slice(0, offset + index - header.length + header.search(/\S/)).split("\n").length
      const endLine = text.slice(0, offset + end).split("\n").length
      if (prelude.startsWith("@")) parseBlocks(body, [...conditions, prelude], [...conditionLines, line], rules, text, offset + index + 1)
      else rules.push({ header: prelude, declarations: declarationsOf(body), conditions, line, endLine, conditionLines })
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
  let quote = ""
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "\\") { index += 1; continue }
    if (quote) {
      if (source[index] === quote) quote = ""
      continue
    }
    if (source[index] === '"' || source[index] === "'") { quote = source[index]!; continue }
    if (source[index] === "{") depth += 1
    if (source[index] === "}") {
      depth -= 1
      if (depth === 0) return index
    }
  }
  throw new Error("unbalanced css block")
}
