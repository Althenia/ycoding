import { expect } from "bun:test"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { CodeMode, DiscoveryPrompt, Tool, toolError } from "../../../../../packages/codemode/src/index.js"
import { ToolRuntime } from "../../../../../packages/codemode/src/tool-runtime.js"

const root = new URL("../../../../../", import.meta.url)
const require = createRequire(new URL("packages/codemode/package.json", root))
const { Cause, Effect, Schema } = await import(require.resolve("effect"))
const selected = {
  codemode: [287],
  callbacks: [84, 118, 138, 263, 269],
  parity: [365, 811, 826, 858, 871],
  stdlib: [
    205, 210, 221, 227, 238, 251, 265, 283, 287, 291, 318, 327, 351, 355, 361, 375, 380, 386, 394, 399, 739, 861, 876,
    1008,
  ],
  "regexp-math-test262": [53, 81, 97, 123, 147, 180, 201, 216],
}
const native = {
  date: Date,
  constructor: RegExp,
  exec: RegExp.prototype.exec,
  test: RegExp.prototype.test,
  escape: RegExp.escape,
  match: String.prototype.match,
  matchAll: String.prototype.matchAll,
  replace: String.prototype.replace,
  replaceAll: String.prototype.replaceAll,
  search: String.prototype.search,
  split: String.prototype.split,
}
const clock = 1704067200000
globalThis.Date = new Proxy(native.date, {
  construct(target, args, newTarget) {
    return Reflect.construct(target, args.length === 0 ? [clock] : args, newTarget)
  },
  get(target, key, receiver) {
    if (key === "now") return () => clock
    return Reflect.get(target, key, receiver)
  },
})
const units = (input: string) => Array.from({ length: input.length }, (_, index) => input.charCodeAt(index))
const normalize = (value: unknown): unknown => {
  if (value === undefined) return { undefined: true }
  if (typeof value === "string") return { utf16: units(value) }
  if (typeof value === "number" && !Number.isFinite(value)) return { number: String(value) }
  if (Array.isArray(value)) {
    return {
      items: value.map(normalize),
      ...Object.fromEntries(
        Object.keys(value)
          .filter((key) => !/^\d+$/.test(key))
          .map((key) => [key, normalize(Reflect.get(value, key))]),
      ),
    }
  }
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]))
  return value
}
const groups: Array<{ source: string; line: number; name: string; vectors: Array<unknown> }> = []

const field = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object" ? Reflect.get(value, key) : undefined
const array = (value: unknown): Array<unknown> => {
  if (!Array.isArray(value)) throw new Error(`Expected array: ${JSON.stringify(value)}`)
  return value
}
const rustUnits = (value: unknown) => {
  const items = array(field(value, "utf16"))
  if (items.length === 0) return "[0u16; 0]"
  return `[${items.join(",")}]`
}
const rustText = (value: string) => JSON.stringify(value)
const rustList = (value: unknown, convert: (value: unknown) => string) => `vec![${array(value).map(convert).join(",")}]`
const rustOptionalText = (value: unknown) => (field(value, "undefined") ? "None" : `Some(${rustUnits(value)}.to_vec())`)
const rustRange = (value: unknown) =>
  field(value, "undefined") ? "None" : `Some((${array(field(value, "items")).join(",")}))`
const rustObject = (value: unknown, convert: (value: unknown) => string) => {
  if (field(value, "undefined") || value === undefined) return "None"
  if (value === null || typeof value !== "object") throw new Error("Expected object")
  return `Some(vec![${Object.entries(value)
    .map(([name, item]) => `(${rustUnits({ utf16: units(name) })}.to_vec(),${convert(item)})`)
    .join(",")}])`
}
const rustMatch = (value: unknown): string => {
  const indices = field(value, "indices")
  return `Match { captures:${rustList(field(value, "items"), rustOptionalText)}, index:${field(value, "index")}, groups:${rustObject(field(value, "groups"), rustOptionalText)}, indices:${indices === undefined ? "None" : `Some(${rustList(field(indices, "items"), rustRange)})`}, index_groups:${rustObject(field(indices, "groups"), rustRange)} }`
}
const rustVector = (vector: unknown): string => {
  const operation = field(vector, "operation")
  const error = field(vector, "error")
  if (operation === "escape")
    return `assert_eq!(escape(&${rustUnits(field(vector, "input"))}),${rustUnits(field(vector, "result"))}.to_vec());`
  const flags = String(field(vector, "flags"))
  const constructor = `RegExp::new(&${rustUnits(field(vector, "pattern"))},${rustText(flags)})`
  if (operation === "compile") {
    if (error) return `assert!(${constructor}.is_err());`
    return `{ let regex=${constructor}.unwrap(); assert_eq!(regex.source(),&${rustUnits(field(vector, "source"))}); assert_eq!(regex.flags(),${rustText(String(field(vector, "canonicalFlags")))}); }`
  }
  const before = field(vector, "lastIndex")
  const after = field(vector, "finalLastIndex")
  if (typeof before !== "number" || typeof after !== "number")
    throw new Error(`Unrepresentable engine lastIndex: ${JSON.stringify(vector)}`)
  const input = rustUnits(field(vector, "input"))
  const result = field(vector, "result")
  const args = field(field(vector, "args"), "items")
  const argument = args === undefined ? undefined : array(args)[0]
  const callback =
    field(argument, "utf16") &&
    String.fromCharCode(...(array(field(argument, "utf16")) as Array<number>)) === "callback"
  const method =
    operation === "match"
      ? "string_match"
      : operation === "matchAll"
        ? "match_all"
        : operation === "replaceAll"
          ? "replace_all"
          : operation
  const limit = typeof argument === "number" ? argument >>> 0 : 0xffffffff
  const call = `regex.${method}(&${input},${operation === "split" ? `${limit},` : operation === "replace" || operation === "replaceAll" ? `&${rustUnits(argument)},` : ""}&mut budget)`
  let assertion = ""
  if (error) assertion = `assert_eq!(${call},Err(Error::RequiresGlobal));`
  else if (operation === "exec")
    assertion = `assert_eq!(${call}.unwrap(),${result === null ? "None" : `Some(${rustMatch(result)})`});`
  else if (operation === "test") assertion = `assert!(${result ? "" : "!"}${call}.unwrap());`
  else if (operation === "search")
    assertion = `assert_eq!(${call}.unwrap(),${result === -1 ? "None" : `Some(${result})`});`
  else if (operation === "matchAll")
    assertion = `assert_eq!(${call}.unwrap(),${rustList(field(result, "items"), rustMatch)});`
  else if (operation === "split")
    assertion = `assert_eq!(${call}.unwrap(),${rustList(field(result, "items"), rustOptionalText)});`
  else if (operation === "match")
    assertion = `assert_eq!(${call}.unwrap(),${result === null ? "None" : flags.includes("g") ? `Some(StringMatch::Global(${rustList(field(result, "items"), (value) => `${rustUnits(value)}.to_vec()`)}))` : `Some(StringMatch::Single(${rustMatch(result)}))`});`
  else if (callback) {
    const replacements = array(field(vector, "replacements"))
    const expected = replacements.map((replacement) => {
      const args = array(field(field(replacement, "args"), "items"))
      const hasGroups = typeof args[args.length - 1] === "object" && !field(args[args.length - 1], "utf16")
      const offset = args[args.length - (hasGroups ? 3 : 2)]
      return `(${rustList(args.slice(0, args.length - (hasGroups ? 3 : 2)), rustOptionalText)},${offset},${hasGroups ? rustObject(args[args.length - 1], rustOptionalText) : "None"})`
    })
    assertion = `let matches=regex.replacement_matches(&${input},${operation === "replaceAll"},&mut budget).unwrap(); assert_eq!(matches.iter().map(|matched| (matched.captures.clone(),matched.index,matched.groups.clone())).collect::<Vec<_>>(),vec![${expected.join(",")}]); let replacements=${rustList(replacements, (replacement) => `${rustUnits(field(replacement, "result"))}.to_vec()`)}; let mut replacements=replacements.into_iter(); assert_eq!(replace_matches(&${input},&matches,|_| replacements.next().unwrap(),&mut budget).unwrap(),${rustUnits(result)}.to_vec());`
  } else if (operation === "replace" || operation === "replaceAll")
    assertion = `assert_eq!(${call}.unwrap(),${rustUnits(result)}.to_vec());`
  else throw new Error(`Unknown operation ${operation}`)
  return `{ let mut regex=${constructor}.unwrap(); regex.last_index=${before}; let mut budget=Budget::unlimited(); ${assertion} assert_eq!(regex.last_index,${after}); }`
}
const jobs: Array<{ source: string; line: number; name: string; run: () => Promise<unknown> }> = []
let current: (typeof groups)[number] | undefined
let depth = 0
const record = (vector: unknown) => current?.vectors.push(vector)
const tracked = new WeakSet<RegExp>()
const relevant = () => {
  const stack = new Error().stack ?? ""
  return stack.includes("/codemode/src/values.ts") || stack.includes("toHostRegex")
}
globalThis.RegExp = new Proxy(native.constructor, {
  construct(target, args) {
    const capture = relevant()
    try {
      const regex = Reflect.construct(target, args)
      if (capture) {
        tracked.add(regex)
        record({
          operation: "compile",
          pattern: normalize(args[0] ?? ""),
          flags: args[1] ?? "",
          source: normalize(regex.source),
          canonicalFlags: regex.flags,
        })
      }
      return regex
    } catch (error) {
      if (capture)
        record({
          operation: "compile",
          pattern: normalize(args[0] ?? ""),
          flags: args[1] ?? "",
          error: error instanceof Error ? error.name : String(error),
        })
      throw error
    }
  },
})
for (const method of ["exec", "test"] as const) {
  RegExp.prototype[method] = function (input: string) {
    if (depth > 0 || !tracked.has(this)) return Reflect.apply(native[method], this, [input])
    const before = this.lastIndex
    depth += 1
    try {
      const result = Reflect.apply(native[method], this, [input])
      record({
        operation: method,
        pattern: normalize(this.source),
        flags: this.flags,
        input: normalize(input),
        lastIndex: normalize(before),
        result: normalize(result),
        finalLastIndex: normalize(this.lastIndex),
      })
      return result
    } finally {
      depth -= 1
    }
  } as (typeof RegExp.prototype)[typeof method]
}
RegExp.escape = (input: string) => {
  try {
    const result = native.escape(input)
    record({ operation: "escape", input: normalize(input), result: normalize(result) })
    return result
  } catch (error) {
    record({ operation: "escape", input: normalize(input), error: error instanceof Error ? error.name : String(error) })
    throw error
  }
}
for (const method of ["match", "matchAll", "replace", "replaceAll", "search", "split"] as const) {
  Reflect.set(String.prototype, method, function (this: string, pattern: unknown, ...args: Array<unknown>) {
    if (!(pattern instanceof native.constructor) || !tracked.has(pattern) || depth > 0)
      return Reflect.apply(native[method], this, [pattern, ...args])
    const before = pattern.lastIndex
    const replacements: Array<unknown> = []
    const supplied =
      typeof args[0] === "function"
        ? [
            (...values: Array<unknown>) => {
              const result = Reflect.apply(args[0] as (...values: Array<unknown>) => unknown, undefined, values)
              replacements.push({ args: normalize(values), result: normalize(String(result)) })
              return result
            },
          ]
        : args
    depth += 1
    try {
      const result = Reflect.apply(native[method], this, [pattern, ...supplied])
      if (method === "matchAll") {
        const matches = Array.from(result as Iterable<RegExpMatchArray>)
        record({
          operation: method,
          pattern: normalize(pattern.source),
          flags: pattern.flags,
          input: normalize(String(this)),
          lastIndex: normalize(before),
          result: normalize(matches),
          finalLastIndex: normalize(pattern.lastIndex),
        })
        return matches.values()
      }
      record({
        operation: method,
        pattern: normalize(pattern.source),
        flags: pattern.flags,
        input: normalize(String(this)),
        lastIndex: normalize(before),
        args: normalize(args.map((arg) => (typeof arg === "function" ? "callback" : arg))),
        replacements,
        result: normalize(result),
        finalLastIndex: normalize(pattern.lastIndex),
      })
      return result
    } catch (error) {
      record({
        operation: method,
        pattern: normalize(pattern.source),
        flags: pattern.flags,
        input: normalize(String(this)),
        lastIndex: normalize(before),
        error: error instanceof Error ? error.name : String(error),
        finalLastIndex: normalize(pattern.lastIndex),
      })
      throw error
    } finally {
      depth -= 1
    }
  })
}
try {
  for (const source of [...Object.keys(selected), "string-regexp-test262"]) {
    const text = await Bun.file(new URL(`packages/codemode/test/${source}.test.ts`, root)).text()
    const testLines = Array.from(text.matchAll(/^\s*test\("([^"\n]+)"/gm), (match) => ({
      name: match[1],
      line: text.slice(0, match.index).split("\n").length + (match[0].startsWith("\n") ? 1 : 0),
    }))
    const remaining = [...testLines]
    const test = (name: string, run: () => Promise<unknown>) => {
      const entry = remaining.shift()
      const line =
        source === "string-regexp-test262"
          ? text.split("\n").findIndex((line) => line.includes(`path: "${name}"`)) + 1
          : (entry?.line ?? 0)
      if (source === "string-regexp-test262") {
        const block = text.slice(text.indexOf(`path: "${name}"`), text.indexOf(`path: "${name}"`) + 600)
        if (name.includes("/replaceAll/") && !name.includes("searchValue-replacer-RegExp-call")) return
        if (!block) throw new Error(`Missing vector ${name}`)
      } else if (!(Reflect.get(selected, source) as Array<number>).includes(line)) return
      jobs.push({ source, line, name, run })
    }
    const describe = (_name: string, run: () => void) => run()
    const transformed = new Bun.Transpiler({ loader: "ts" }).transformSync(text.replace(/^import .*$/gm, ""))
    const bindings = {
      describe,
      expect,
      test,
      Cause,
      Effect,
      Schema,
      CodeMode,
      DiscoveryPrompt,
      Tool,
      toolError,
      ToolRuntime,
    }
    const names = Array.from(text.matchAll(/^import \{ ([^}]+) \}/gm)).flatMap((match) => match[1].split(", "))
    new Function(...names, transformed)(...names.map((name) => Reflect.get(bindings, name)))
  }
  if (jobs.length !== 104)
    throw new Error(
      `Expected 104 corpus groups, registered ${jobs.length}: ${JSON.stringify(jobs.map(({ source, line }) => ({ source, line })))}`,
    )
  for (const job of jobs) {
    current = { source: job.source, line: job.line, name: job.name, vectors: [] }
    await job.run()
    groups.push(current)
  }
  const baseline = groups
  current = { source: "engine", line: 0, name: "Additional native parser and matcher boundary vectors", vectors: [] }
  const supplementalPatterns = [
    "",
    "a|ab",
    "(a|ab)c",
    "a+?",
    "a{2,4}?",
    "(?:a?){2,4}",
    "(a?)*",
    "(a?)+",
    "(a?){2}",
    "(a|(b))*",
    "(a(b)?)+",
    "^",
    "$",
    "^a$",
    ".",
    "[^]",
    "[]",
    "\\b",
    "\\B",
    "\\w+",
    "\\W+",
    "\\s",
    "\\S",
    "\\d",
    "\\D",
    "(?=(a+))a*b\\1",
    "(?!(a))b\\1",
    "(?<=([ab]+)([bc]+))$",
    "(?<!a)b",
    "(?<=\\1([ab]+))c",
    "(?<=([ab]+)\\1)$",
    "(?<x>a)|(?<x>b)",
    "(?:(?<x>a)|(?<x>b))+",
    "(?<x>a)|b\\k<x>",
    "\\1(a)",
    "(a)?\\1",
    "\\2(a)",
    "\\0",
    "\\00",
    "\\08",
    "\\123",
    "\\400",
    "\\8",
    "\\9",
    "[\\1]",
    "[\\8]",
    "\\x61",
    "\\xq",
    "\\u0061",
    "\\uqqqq",
    "\\u{61}",
    "\\cA",
    "\\c1",
    "[\\c1]",
    "[\\c_]",
    "[\\c?]",
    "\\q",
    "\\k<foo>",
    "(?<x>a)\\k<x>",
    "(?<x>a)\\k<missing>",
    "a{",
    "a{,2}",
    "a{2,1}",
    "a{1,}",
    "*",
    "a**",
    "a++",
    "[a-z]",
    "[z-a]",
    "[\\d-a]",
    "[a-\\d]",
    "[-a]",
    "[a-]",
    "(?=a)*",
    "(?<=a)*",
    "(?i:a)",
    "(?i:a)(?-i:b)",
    "(?s:.)",
    "(?m:^b$)",
    "(?ims-:a)",
    "(?i-i:a)",
    "(?g:a)",
    "\\uD83D\\uDE00",
    "[\\uD83D\\uDE00]",
    "[😀-😃]",
    "(?<\\u0061>a)",
    "(?<𝒜>a)",
    "(?<\\uD835\\uDC9C>a)",
    "[(?<]\\k",
    "(?<a>x)[\\k<a>]",
    "(?<\\u{1D49C}>a)",
    "\\p{Script=Tai_Yo}",
    "\\p{Script=Sidetic}",
    "\\p{gc=digit}",
    "\\\n",
    "\\\r",
    "\\\u2028",
    "\n",
    "\\/",
    "/",
    "[/]",
    "\\é",
    "\\😀",
    "\\\u00a0",
    "\\\ufeff",
  ]
  const supplementalInputs = ["", "a", "aaabc", "ababc", "b", "a\nb", "😀", "\uD800", "1 _\t\uFEFF"]
  const compiled = new Set<string>()
  const snapshot = (pattern: string, flags: string, input: string) => {
    const key = JSON.stringify([pattern, flags])
    const capture = !compiled.has(key)
    compiled.add(key)
    try {
      const regex = new native.constructor(pattern, flags)
      if (capture)
        record({
          operation: "compile",
          pattern: normalize(pattern),
          flags,
          source: normalize(regex.source),
          canonicalFlags: regex.flags,
        })
      record({
        operation: "exec",
        pattern: normalize(regex.source),
        flags,
        input: normalize(input),
        lastIndex: 0,
        result: normalize(native.exec.call(regex, input)),
        finalLastIndex: regex.lastIndex,
      })
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      if (capture) record({ operation: "compile", pattern: normalize(pattern), flags, error: error.name })
    }
  }
  for (const pattern of supplementalPatterns)
    for (const flags of ["", "du", "dv", "di"]) for (const input of supplementalInputs) snapshot(pattern, flags, input)
  for (const pattern of ["\\é", "\\\u2028", "\\\u2029", "\\\u00a0", "\\\ufeff"])
    for (const flags of ["u", "v"]) snapshot(pattern, flags, pattern.slice(1))
  for (const [pattern, input] of [
    ["(?:){10000}", ""],
    ["(a?){10000}", ""],
    ["(|a){2}$", "a"],
    ["(a|){2}$", "a"],
    ["(?=a){10000}", "a"],
  ])
    snapshot(pattern, "d", input)
  for (const pattern of [
    "[a&&a]",
    "[a&&b]",
    "[a-z&&[^b]]",
    "[a-z--[b]]",
    "[ab&&c]",
    "[a&&b--c]",
    "[a--b&&c]",
    "[a&&]",
    "[&&a]",
    "[a-b-c]",
    "[!!]",
    "[\\!\\!]",
    "[\\q{ab|a|}]",
    "[\\q{a}--[a]]",
    "[^\\q{a}]",
    "[^\\p{Basic_Emoji}]",
    "[\\p{Basic_Emoji}&&[\\q{🛤️}]]",
    "\\p{Basic_Emoji}",
    "\\p{ASCII}",
    "\\p{Assigned}",
    "\\p{Any}",
    "\\p{Script=Han}",
    "\\p{scx=Hira}",
    "\\p{Lu}",
    "\\p{L}",
    "\\p{General_Category=Number}",
    "\\P{Lowercase_Letter}",
    "\\p{ascii}",
    "\\p{Script=han}",
    "\\p{Script_Extensions=Han}",
  ])
    for (const flags of ["du", "dv", "diu", "div"])
      for (const input of ["a", "b", "ab", "A", "𠮷", "ー", "🛤️", "1", ""]) snapshot(pattern, flags, input)
  const supplemental = current
  current = undefined
  const license = await Bun.file(new URL("packages/codemode/test/LICENSE.test262", root)).text()
  await Bun.write(
    new URL("corpus.json", import.meta.url),
    JSON.stringify(
      {
        oracle: `Bun ${Bun.version} / JavaScriptCore`,
        clock,
        provenance:
          "packages/codemode/test; original assertions executed before capture; native intermediate RegExp results precede CodeMode blocked-member filtering",
        license,
        groups: baseline,
        supplemental,
      },
      null,
      2,
    ) + "\n",
  )
  const tests = baseline
    .filter((group) => group.vectors.length > 0)
    .map(
      (group, index) =>
        `#[test]\nfn corpus_${index}_${group.source.replaceAll("-", "_")}_${group.line}() {\n${group.vectors.map(rustVector).join("\n")}\n}`,
    )
    .join("\n\n")
  await Bun.write(
    new URL("../../tests/regexp_corpus.rs", import.meta.url),
    `use ycoding_core::regexp::{Budget, Match, RegExp, StringMatch, escape, replace_matches};\n\n${tests}\n`,
  )
  const extra = supplemental.vectors
    .map((vector, index) => `#[test]\nfn native_boundary_${index}() { ${rustVector(vector)} }`)
    .join("\n")
  await Bun.write(
    new URL("../../tests/regexp_oracle.rs", import.meta.url),
    `use ycoding_core::regexp::{Budget, Match, RegExp};\n${extra}\n`,
  )
  const cases: Array<{ point: number; candidate: Array<number>; matches: Array<boolean> }> = []
  const equivalences = [new Map<number, number>(), new Map<number, number>()]
  const representative = (table: Map<number, number>, point: number): number => {
    const parent = table.get(point)
    if (parent === undefined || parent === point) return point
    const root = representative(table, parent)
    table.set(point, root)
    return root
  }
  for (let point = 0; point <= 0x10ffff; point += 1) {
    const text = String.fromCodePoint(point)
    const candidates = new Set([text.toUpperCase(), text.toLowerCase()])
    candidates.delete(text)
    if (candidates.size === 0) continue
    const regexes = ["i", "iu", "iv"].map((flags) => new native.constructor(native.escape(text), flags))
    for (const candidate of candidates) {
      const matches = regexes.map((regex) => native.test.call(regex, candidate))
      cases.push({ point, candidate: units(candidate), matches })
      if (Array.from(candidate).length !== 1) continue
      const other = candidate.codePointAt(0)
      if (other === undefined) throw new Error("Missing case candidate")
      for (const [index, table] of equivalences.entries()) {
        if (!matches[index] || (index === 0 && (point > 0xffff || other > 0xffff))) continue
        const left = representative(table, point)
        const right = representative(table, other)
        table.set(left, Math.min(left, right))
        table.set(right, Math.min(left, right))
      }
    }
  }
  const constants = equivalences
    .map((table, index) => {
      const entries = Array.from(table.keys())
        .sort((left, right) => left - right)
        .flatMap((point) => {
          const folded = representative(table, point)
          return point === folded ? [] : [`(${point},${folded})`]
        })
      return `pub(super) const ${index === 0 ? "LEGACY" : "UNICODE"}: &[(u32,u32)] = &[${entries.join(",")}];`
    })
    .join("\n")
  await Bun.write(new URL("case_data.rs", import.meta.url), constants + "\n")
  const caseVectors = cases
    .map(
      ({ point, candidate, matches }) =>
        `(${rustUnits({ utf16: units(String.fromCodePoint(point)) })}.as_slice(),[${candidate}].as_slice(),[${matches}])`,
    )
    .join(",\n")
  await Bun.write(
    new URL("../../tests/regexp_case_oracle.rs", import.meta.url),
    `use ycoding_core::regexp::{Budget, RegExp, escape};\n#[test]\nfn all_host_casing_transforms_match_per_mode() {\n let vectors: &[(&[u16], &[u16], [bool;3])] = &[${caseVectors}];\n for (pattern,input,expected) in vectors { for (index,flags) in ["i","iu","iv"].iter().enumerate() { assert_eq!(RegExp::new(&escape(pattern),flags).unwrap().test(input,&mut Budget::unlimited()).unwrap(),expected[index],"{pattern:?}/{flags} on {input:?}"); } }\n}\n`,
  )
  const formatting = Bun.spawn(
    [
      "rustfmt",
      "--edition",
      "2024",
      fileURLToPath(new URL("case_data.rs", import.meta.url)),
      ...["regexp_corpus.rs", "regexp_oracle.rs", "regexp_case_oracle.rs"].map((name) =>
        fileURLToPath(new URL(`../../tests/${name}`, import.meta.url)),
      ),
    ],
    { stdout: "inherit", stderr: "inherit" },
  )
  if ((await formatting.exited) !== 0) throw new Error("Generated Rust fixture formatting failed")
  console.log(`${groups.length} groups, ${groups.reduce((sum, group) => sum + group.vectors.length, 0)} operations`)
} finally {
  globalThis.Date = native.date
  globalThis.RegExp = native.constructor
  RegExp.prototype.exec = native.exec
  RegExp.prototype.test = native.test
  RegExp.escape = native.escape
  for (const method of ["match", "matchAll", "replace", "replaceAll", "search", "split"] as const)
    Reflect.set(String.prototype, method, native[method])
}
