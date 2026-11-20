import { describe, expect, test } from "bun:test"
import { codeLanguage, codeLanguageLabel, highlightCode, type CodeTokenKind } from "./code-highlight"

const samples: Record<string, string> = {
  typescript: "// note\nimport { a } from \"./a\"\nexport async function run<T>(value: T): Promise<number> {\n  const total = 0x1f + 42n + 3.5e2\n  return `tpl ${value}` && true ? new Map() : null\n}\n/* block\ncomment */",
  rust: "#[derive(Debug)]\n// c\nfn main<'a>(x: &'a str) -> Option<i32> {\n    let n = 42u8; println!(\"hi {}\", r#\"raw\"#);\n    match x { 'c' => None, _ => Some(1) }\n}",
  python: "# c\n@decorator.x\nclass A(Base):\n    def run(self, n: int = 1_000) -> None:\n        \"\"\"doc\n        string\"\"\"\n        return f\"v{n}\" if n else None",
  json: "{\n  \"name\": \"ycoding\", \"n\": -1.5e3, \"ok\": true, \"none\": null, \"list\": [1, \"two\"]\n}",
  bash: "#!/bin/sh\n# comment\nif [ -n $HOME ]; then echo ${HOME} --flag -v 42 'single'; fi\nexport NAME=$(whoami)",
  markdown: "# Title\n\n> quote\n\n- item with `code` and **bold** and _em_\n1. [link](https://example.com)\n\n```ts\nconst x = 1\n```\n\nsnake_case_word",
}

const kindsOf = (code: string, language: string) => new Set(highlightCode(code, language).flatMap((token) => token.kind ? [token.kind] : []))
const textOf = (code: string, language: string, kind: CodeTokenKind) => highlightCode(code, language).filter((token) => token.kind === kind).map((token) => token.text)

describe("highlightCode", () => {
  test("concatenated token text equals the raw code for every language, including odd and unterminated input", () => {
    for (const [language, code] of Object.entries(samples)) {
      expect(highlightCode(code, language).map((token) => token.text).join(""), language).toBe(code)
      for (const cut of [1, 7, code.length - 1]) expect(highlightCode(code.slice(0, cut), language).map((token) => token.text).join(""), `${language} ${cut}`).toBe(code.slice(0, cut))
    }
    for (const code of ["\"unterminated", "`tpl ${", "/* open", "'''open", "r#\"raw", "$", "***", "\n\n", "é𝒳 ✓"]) {
      for (const language of Object.keys(samples)) expect(highlightCode(code, language).map((token) => token.text).join("")).toBe(code)
    }
  })

  test("unknown or missing languages are one plain token and empty code has none", () => {
    expect(highlightCode("const x = 1", "brainfuck")).toEqual([{ text: "const x = 1" }])
    expect(highlightCode("const x = 1", undefined)).toEqual([{ text: "const x = 1" }])
    expect(highlightCode("", "ts")).toEqual([])
  })

  test("TypeScript and JavaScript classify keywords, strings, numbers, literals, comments, functions and types", () => {
    for (const language of ["ts", "tsx", "js", "jsx", "javascript"]) {
      expect(textOf(samples.typescript!, language, "keyword")).toEqual(expect.arrayContaining(["import", "from", "export", "async", "function", "const", "return", "new"]))
      expect(textOf(samples.typescript!, language, "string")).toEqual(expect.arrayContaining(["\"./a\"", "`tpl ${value}`"]))
      expect(textOf(samples.typescript!, language, "number")).toEqual(expect.arrayContaining(["0x1f", "42n", "3.5e2"]))
      expect(textOf(samples.typescript!, language, "literal")).toEqual(expect.arrayContaining(["true", "null"]))
      expect(textOf(samples.typescript!, language, "comment")).toEqual(["// note", "/* block\ncomment */"])
      expect(textOf(samples.typescript!, language, "function")).toContain("run")
      expect(textOf(samples.typescript!, language, "type")).toEqual(expect.arrayContaining(["Promise", "Map"]))
    }
  })

  test("Rust classifies attributes, macros, lifetimes, raw strings and keywords", () => {
    const kinds = kindsOf(samples.rust!, "rs")
    for (const kind of ["meta", "comment", "keyword", "function", "type", "number", "string"] as const) expect(kinds.has(kind), kind).toBe(true)
    expect(textOf(samples.rust!, "rust", "function")).toEqual(expect.arrayContaining(["main", "println!"]))
    expect(textOf(samples.rust!, "rust", "string")).toEqual(expect.arrayContaining(["r#\"raw\"#", "'c'"]))
    expect(textOf(samples.rust!, "rust", "type")).toContain("'a")
  })

  test("Python classifies decorators, triple-quoted strings, keywords and literals", () => {
    expect(textOf(samples.python!, "py", "meta")).toEqual(["@decorator.x"])
    expect(textOf(samples.python!, "python", "string")).toEqual(expect.arrayContaining(["\"\"\"doc\n        string\"\"\"", "f\"v{n}\""]))
    expect(textOf(samples.python!, "python", "keyword")).toEqual(expect.arrayContaining(["class", "def", "return", "if", "else"]))
    expect(textOf(samples.python!, "python", "literal")).toEqual(expect.arrayContaining(["self", "None"]))
    expect(textOf(samples.python!, "python", "number")).toContain("1_000")
  })

  test("JSON separates property keys from string values and classifies numbers and literals", () => {
    expect(textOf(samples.json!, "json", "property")).toEqual(["\"name\"", "\"n\"", "\"ok\"", "\"none\"", "\"list\""])
    expect(textOf(samples.json!, "json", "string")).toEqual(["\"ycoding\"", "\"two\""])
    expect(textOf(samples.json!, "json", "number")).toEqual(["-1.5e3", "1"])
    expect(textOf(samples.json!, "json", "literal")).toEqual(["true", "null"])
  })

  test("Bash classifies comments only at word starts, variables, flags, builtins and keywords", () => {
    for (const language of ["sh", "bash", "shell", "zsh"]) {
      expect(textOf(samples.bash!, language, "comment")).toEqual(["#!/bin/sh", "# comment"])
      expect(textOf(samples.bash!, language, "type")).toEqual(expect.arrayContaining(["$HOME", "${HOME}", "$(whoami)"]))
      expect(textOf(samples.bash!, language, "property")).toEqual(["-n", "--flag", "-v"])
      expect(textOf(samples.bash!, language, "keyword")).toEqual(expect.arrayContaining(["if", "then", "fi", "export"]))
      expect(textOf(samples.bash!, language, "function")).toContain("echo")
    }
    expect(textOf("echo a#b", "bash", "comment")).toEqual([])
  })

  test("Markdown classifies headings, quotes, list markers, inline code, emphasis, links and fences but not snake_case", () => {
    expect(textOf(samples.markdown!, "md", "function")).toEqual(["# Title"])
    expect(textOf(samples.markdown!, "markdown", "comment")).toEqual(["> quote"])
    expect(textOf(samples.markdown!, "markdown", "keyword")).toEqual(["-", "1."])
    expect(textOf(samples.markdown!, "markdown", "string")).toEqual(["`code`"])
    expect(textOf(samples.markdown!, "markdown", "type")).toEqual(["**bold**", "_em_"])
    expect(textOf(samples.markdown!, "markdown", "property")).toEqual(["[link](https://example.com)"])
    expect(textOf(samples.markdown!, "markdown", "meta")).toEqual(["```ts", "```"])
  })
})

describe("language names", () => {
  test("map every alias to one label and fall back to Code", () => {
    const labels: Record<string, string> = {
      md: "Markdown", markdown: "Markdown", ts: "TypeScript", tsx: "TypeScript", typescript: "TypeScript",
      js: "JavaScript", jsx: "JavaScript", javascript: "JavaScript", rs: "Rust", rust: "Rust", py: "Python", python: "Python",
      json: "JSON", sh: "Bash", bash: "Bash", shell: "Bash", zsh: "Bash", " TS  title=x": "TypeScript", JSON: "JSON",
    }
    for (const [alias, label] of Object.entries(labels)) expect(codeLanguageLabel(alias), alias).toBe(label)
    for (const alias of [undefined, "", "   ", "cobol", "text"]) {
      expect(codeLanguageLabel(alias)).toBe("Code")
      expect(codeLanguage(alias)).toBeUndefined()
    }
  })
})
