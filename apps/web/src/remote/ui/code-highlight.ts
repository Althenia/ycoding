export type CodeTokenKind = "keyword" | "string" | "number" | "literal" | "comment" | "function" | "type" | "property" | "meta"
export type CodeToken = { readonly text: string; readonly kind?: CodeTokenKind }
export type CodeLanguage = "markdown" | "typescript" | "javascript" | "rust" | "python" | "json" | "bash"

const languages: Record<string, CodeLanguage> = {
  md: "markdown", markdown: "markdown",
  ts: "typescript", tsx: "typescript", typescript: "typescript",
  js: "javascript", jsx: "javascript", javascript: "javascript", mjs: "javascript", cjs: "javascript",
  rs: "rust", rust: "rust",
  py: "python", python: "python",
  json: "json", jsonc: "json",
  sh: "bash", bash: "bash", shell: "bash", zsh: "bash",
}

const labels: Record<CodeLanguage, string> = {
  markdown: "Markdown", typescript: "TypeScript", javascript: "JavaScript", rust: "Rust", python: "Python", json: "JSON", bash: "Bash",
}

type Rule = {
  readonly pattern: RegExp
  readonly kind?: CodeTokenKind | ((text: string, after: string) => CodeTokenKind | undefined)
  readonly at?: (code: string, index: number) => boolean
}

const words = (list: string) => new Set(list.split(" "))
const atLineStart = (code: string, index: number) => index === 0 || code[index - 1] === "\n"
const afterNonWord = (code: string, index: number) => index === 0 || !/\w/.test(code[index - 1]!)
const atWordStart = (code: string, index: number) => index === 0 || /\s/.test(code[index - 1]!)

const scriptKeywords = words("as async await break case catch class const continue debugger default delete do else enum export extends finally for from function if implements import in instanceof interface let new of private protected public readonly return satisfies static super switch throw try type typeof var void while with yield abstract declare namespace keyof infer is")
const scriptLiterals = words("true false null undefined NaN Infinity this")
const rustKeywords = words("as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while")
const rustLiterals = words("true false")
const pythonKeywords = words("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case")
const pythonLiterals = words("True False None self cls")
const bashKeywords = words("if then else elif fi for while until do done case esac in function select return exit break continue local export readonly declare source alias unset shift trap")
const bashBuiltins = words("echo cd pwd printf read test ls cat grep sed awk git bun npm node sudo rm mv cp mkdir chmod curl")

const numberPattern = /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)(?:n|[iu](?:\d+|size)|f\d+)?\b/y

function wordRule(keywords: ReadonlySet<string>, literals: ReadonlySet<string>, wordPattern: RegExp): Rule {
  return {
    pattern: wordPattern,
    kind: (text, after) => keywords.has(text) ? "keyword" : literals.has(text) ? "literal" : /^[A-Z]/.test(text) ? "type" : /^(?:<[^<>\n]*>)?\s*\(/.test(after) ? "function" : undefined,
  }
}

const cStyleComments: Rule = { pattern: /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y, kind: "comment" }

const scriptRules: readonly Rule[] = [
  cStyleComments,
  { pattern: /`(?:\\[\s\S]|[^`\\])*`?|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?/y, kind: "string" },
  { pattern: numberPattern, kind: "number" },
  { pattern: /@[A-Za-z_$][\w$]*/y, kind: "meta" },
  wordRule(scriptKeywords, scriptLiterals, /[A-Za-z_$][\w$]*/y),
]

const rules: Record<CodeLanguage, readonly Rule[]> = {
  typescript: scriptRules,
  javascript: scriptRules,
  rust: [
    cStyleComments,
    { pattern: /r(#*)"[\s\S]*?(?:"\1|$)|b?"(?:\\[\s\S]|[^"\\])*"?|b?'(?:\\.|[^'\\\n])'/y, kind: "string" },
    { pattern: /'[A-Za-z_]\w*/y, kind: "type" },
    { pattern: /#!?\[[^\]\n]*\]?/y, kind: "meta" },
    { pattern: /\b[a-z_]\w*!/y, kind: "function" },
    { pattern: numberPattern, kind: "number" },
    wordRule(rustKeywords, rustLiterals, /[A-Za-z_]\w*/y),
  ],
  python: [
    { pattern: /#[^\n]*/y, kind: "comment" },
    { pattern: /(?:[rRbBfFuU]{1,2})?(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?)/y, kind: "string" },
    { pattern: numberPattern, kind: "number" },
    { pattern: /@[A-Za-z_][\w.]*/y, kind: "meta" },
    wordRule(pythonKeywords, pythonLiterals, /[A-Za-z_]\w*/y),
  ],
  json: [
    { pattern: /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y, kind: "comment" },
    { pattern: /"(?:\\.|[^"\\\n])*"?/y, kind: (_text, after) => /^\s*:/.test(after) ? "property" : "string" },
    { pattern: /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y, kind: "number" },
    { pattern: /\b(?:true|false|null)\b/y, kind: "literal" },
  ],
  bash: [
    { pattern: /#[^\n]*/y, kind: "comment", at: atWordStart },
    { pattern: /"(?:\\[\s\S]|[^"\\])*"?|'[^']*'?/y, kind: "string" },
    { pattern: /\$(?:\{[^}\n]*\}?|\([^)\n]*\)?|[A-Za-z_]\w*|[0-9@#?$!*-])/y, kind: "type" },
    { pattern: /--?[A-Za-z][\w-]*/y, kind: "property", at: atWordStart },
    { pattern: numberPattern, kind: "number" },
    { pattern: /[A-Za-z_][\w-]*/y, kind: (text) => bashKeywords.has(text) ? "keyword" : bashBuiltins.has(text) ? "function" : undefined },
  ],
  markdown: [
    { pattern: /#{1,6}[ \t][^\n]*/y, kind: "function", at: atLineStart },
    { pattern: /(?:```|~~~)[^\n]*/y, kind: "meta", at: atLineStart },
    { pattern: />[^\n]*/y, kind: "comment", at: atLineStart },
    { pattern: /(?:[-*+]|\d+[.)])(?=[ \t])/y, kind: "keyword", at: atLineStart },
    { pattern: /`[^`\n]+`/y, kind: "string" },
    { pattern: /\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_/y, kind: "type", at: afterNonWord },
    { pattern: /!?\[[^\]\n]*\]\([^)\n]*\)/y, kind: "property" },
  ],
}

export function codeLanguage(language: string | undefined): CodeLanguage | undefined {
  return languages[(language ?? "").trim().split(/\s+/)[0]!.toLowerCase()]
}

export function codeLanguageLabel(language: string | undefined): string {
  const known = codeLanguage(language)
  return known === undefined ? "Code" : labels[known]
}

export function highlightCode(code: string, language: string | undefined): readonly CodeToken[] {
  const known = codeLanguage(language)
  if (known === undefined || code === "") return code === "" ? [] : [{ text: code }]
  const active = rules[known]
  const tokens: CodeToken[] = []
  const push = (text: string, kind?: CodeTokenKind) => {
    const last = tokens.at(-1)
    if (last !== undefined && last.kind === kind) tokens[tokens.length - 1] = { text: last.text + text, ...(kind === undefined ? {} : { kind }) }
    else tokens.push({ text, ...(kind === undefined ? {} : { kind }) })
  }
  let index = 0
  while (index < code.length) {
    const hit = firstMatch(active, code, index)
    if (hit === undefined) {
      push(code[index]!)
      index += 1
      continue
    }
    const kind = typeof hit.rule.kind === "function" ? hit.rule.kind(hit.text, code.slice(index + hit.text.length)) : hit.rule.kind
    push(hit.text, kind)
    index += hit.text.length
  }
  return tokens
}

function firstMatch(active: readonly Rule[], code: string, index: number) {
  for (const rule of active) {
    if (rule.at !== undefined && !rule.at(code, index)) continue
    rule.pattern.lastIndex = index
    const match = rule.pattern.exec(code)
    if (match !== null && match[0] !== "") return { rule, text: match[0] }
  }
  return undefined
}
