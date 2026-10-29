import { isIP } from "node:net"

export type TomlValue =
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "integer"; readonly value: bigint }
  | { readonly kind: "float"; readonly value: number; readonly negativeNan?: boolean }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "datetime"; readonly value: string }
  | { readonly kind: "array"; readonly items: TomlValue[] }
  | TomlTable

export interface TomlTable {
  readonly kind: "table"
  readonly entries: Map<string, TomlValue>
}

export class TomlParseError extends Error {
  constructor(
    readonly line: number,
    readonly column: number,
    readonly detail: string,
  ) {
    super(`${line}:${column}: ${detail}`)
    this.name = "TomlParseError"
  }
}

export function tomlTable(entries: Iterable<readonly [string, TomlValue]> = []): TomlTable {
  return { kind: "table", entries: new Map(entries) }
}

type TableState = "implicit" | "header" | "dotted" | "inline" | "array-element"

const INT64_MIN = -(2n ** 63n)
const INT64_MAX = 2n ** 63n - 1n
const BARE_KEY = /^[A-Za-z0-9_-]+$/
const DATE = /^(\d{4})-(\d{2})-(\d{2})/
const TIME = /^(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?/
const OFFSET = /^(?:[Zz]|[+-]\d{2}:\d{2})/

class Parser {
  private index = 0
  private readonly states = new WeakMap<TomlTable, TableState>()
  private readonly arraysOfTables = new WeakSet<TomlValue[]>()
  readonly root = tomlTable()
  private current: TomlTable = this.root

  constructor(private readonly text: string) {}

  fail(detail: string, at = this.index): never {
    let line = 1
    let column = 1
    for (let position = 0; position < at && position < this.text.length; position++) {
      if (this.text[position] === "\n") {
        line++
        column = 1
      } else column++
    }
    throw new TomlParseError(line, column, detail)
  }

  private peek(offset = 0) {
    return this.text[this.index + offset]
  }

  private startsWith(token: string) {
    return this.text.startsWith(token, this.index)
  }

  private skipSpaces() {
    while (this.peek() === " " || this.peek() === "\t") this.index++
  }

  private skipComment() {
    if (this.peek() !== "#") return
    while (this.index < this.text.length && this.peek() !== "\n") {
      const code = this.text.charCodeAt(this.index)
      if ((code < 0x20 && code !== 0x09) || code === 0x7f) {
        if (!(code === 0x0d && this.peek(1) === "\n")) this.fail("invalid comment character")
      }
      this.index++
    }
  }

  private newline(): boolean {
    if (this.peek() === "\n") {
      this.index++
      return true
    }
    if (this.peek() === "\r" && this.peek(1) === "\n") {
      this.index += 2
      return true
    }
    return false
  }

  private skipBlank() {
    for (;;) {
      this.skipSpaces()
      this.skipComment()
      if (!this.newline()) return
    }
  }

  private endOfLine() {
    this.skipSpaces()
    this.skipComment()
    if (this.index >= this.text.length) return
    if (!this.newline()) this.fail(`extra \`${this.peek()}\`, expected nothing`)
  }

  parse(): TomlTable {
    this.states.set(this.root, "header")
    for (;;) {
      this.skipBlank()
      if (this.index >= this.text.length) return this.root
      if (this.peek() === "[") this.header()
      else {
        this.keyValue(this.current)
        this.endOfLine()
      }
    }
  }

  private header() {
    const arrayOfTables = this.startsWith("[[")
    this.index += arrayOfTables ? 2 : 1
    this.skipSpaces()
    const key = this.key()
    this.skipSpaces()
    if (arrayOfTables ? !this.startsWith("]]") : this.peek() !== "]") this.fail(arrayOfTables ? "expected `]]`" : "expected `]`")
    this.index += arrayOfTables ? 2 : 1
    this.endOfLine()
    let table = this.root
    for (const part of key.slice(0, -1)) table = this.descend(table, part)
    const last = key[key.length - 1]
    const existing = table.entries.get(last)
    if (arrayOfTables) {
      const element = tomlTable()
      this.states.set(element, "array-element")
      if (existing === undefined) {
        const items = [element]
        this.arraysOfTables.add(items)
        table.entries.set(last, { kind: "array", items })
      } else if (existing.kind === "array" && this.arraysOfTables.has(existing.items)) existing.items.push(element)
      else this.fail(`duplicate key \`${last}\``)
      this.current = element
      return
    }
    if (existing === undefined) {
      const created = tomlTable()
      this.states.set(created, "header")
      table.entries.set(last, created)
      this.current = created
      return
    }
    if (existing.kind !== "table" || this.states.get(existing) !== "implicit") this.fail(`duplicate key \`${last}\``)
    this.states.set(existing, "header")
    this.current = existing
  }

  private descend(table: TomlTable, part: string): TomlTable {
    const existing = table.entries.get(part)
    if (existing === undefined) {
      const created = tomlTable()
      this.states.set(created, "implicit")
      table.entries.set(part, created)
      return created
    }
    if (existing.kind === "table") {
      if (this.states.get(existing) === "inline") this.fail(`duplicate key \`${part}\``)
      return existing
    }
    if (existing.kind === "array" && this.arraysOfTables.has(existing.items)) {
      const last = existing.items[existing.items.length - 1]
      if (last?.kind === "table") return last
    }
    return this.fail(`duplicate key \`${part}\``)
  }

  private keyValue(table: TomlTable) {
    const keyStart = this.index
    const key = this.key()
    this.skipSpaces()
    if (this.peek() !== "=") this.fail("expected `=`")
    this.index++
    this.skipSpaces()
    let target = table
    for (const part of key.slice(0, -1)) {
      const existing = target.entries.get(part)
      if (existing === undefined) {
        const created = tomlTable()
        this.states.set(created, "dotted")
        target.entries.set(part, created)
        target = created
        continue
      }
      if (existing.kind !== "table" || this.states.get(existing) !== "dotted") this.fail(`duplicate key \`${part}\``, keyStart)
      target = existing
    }
    const last = key[key.length - 1]
    if (target.entries.has(last)) this.fail(`duplicate key \`${last}\``, keyStart)
    target.entries.set(last, this.value())
  }

  private key(): string[] {
    const parts = [this.simpleKey()]
    for (;;) {
      this.skipSpaces()
      if (this.peek() !== ".") return parts
      this.index++
      this.skipSpaces()
      parts.push(this.simpleKey())
    }
  }

  private simpleKey(): string {
    if (this.peek() === '"') {
      if (this.startsWith('"""')) this.fail("multiline strings are not allowed for keys")
      return this.basicString()
    }
    if (this.peek() === "'") {
      if (this.startsWith("'''")) this.fail("multiline strings are not allowed for keys")
      return this.literalString()
    }
    const start = this.index
    while (this.index < this.text.length && /[A-Za-z0-9_-]/.test(this.peek())) this.index++
    if (start === this.index) this.fail("invalid key")
    return this.text.slice(start, this.index)
  }

  private value(): TomlValue {
    const char = this.peek()
    if (char === undefined) return this.fail("expected a value")
    if (this.startsWith('"""')) return { kind: "string", value: this.multilineBasicString() }
    if (this.startsWith("'''")) return { kind: "string", value: this.multilineLiteralString() }
    if (char === '"') return { kind: "string", value: this.basicString() }
    if (char === "'") return { kind: "string", value: this.literalString() }
    if (char === "[") return this.array()
    if (char === "{") return this.inlineTable()
    if (this.startsWith("true") && !/[A-Za-z0-9_-]/.test(this.peek(4) ?? "")) {
      this.index += 4
      return { kind: "boolean", value: true }
    }
    if (this.startsWith("false") && !/[A-Za-z0-9_-]/.test(this.peek(5) ?? "")) {
      this.index += 5
      return { kind: "boolean", value: false }
    }
    const rest = this.text.slice(this.index)
    if (DATE.test(rest) || /^\d{2}:\d{2}/.test(rest)) return this.datetime()
    return this.number()
  }

  private basicString(): string {
    this.index++
    let out = ""
    for (;;) {
      const char = this.peek()
      if (char === undefined || char === "\n" || char === "\r") this.fail("invalid basic string, expected `\"`")
      this.index++
      if (char === '"') return out
      if (char === "\\") out += this.escape()
      else {
        this.checkStringChar(char)
        out += char
      }
    }
  }

  private multilineBasicString(): string {
    this.index += 3
    this.newline()
    let out = ""
    for (;;) {
      if (this.index >= this.text.length) this.fail("invalid multiline basic string, expected `\"\"\"`")
      if (this.startsWith('"""')) {
        let quotes = 3
        while (this.peek(quotes) === '"' && quotes < 5) quotes++
        out += '"'.repeat(quotes - 3)
        this.index += quotes
        return out
      }
      const char = this.peek()
      if (char === "\\") {
        const save = this.index
        this.index++
        let probe = this.index
        while (this.text[probe] === " " || this.text[probe] === "\t") probe++
        if (this.text[probe] === "\n" || (this.text[probe] === "\r" && this.text[probe + 1] === "\n")) {
          this.index = probe
          for (;;) {
            if (this.newline()) continue
            if (this.peek() === " " || this.peek() === "\t") {
              this.index++
              continue
            }
            break
          }
          continue
        }
        this.index = save + 1
        out += this.escape()
        continue
      }
      if (this.newline()) {
        out += "\n"
        continue
      }
      this.checkStringChar(char)
      out += char
      this.index++
    }
  }

  private literalString(): string {
    this.index++
    const start = this.index
    for (;;) {
      const char = this.peek()
      if (char === undefined || char === "\n" || char === "\r") this.fail("invalid literal string, expected `'`")
      if (char === "'") {
        const value = this.text.slice(start, this.index)
        this.index++
        return value
      }
      this.checkStringChar(char)
      this.index++
    }
  }

  private multilineLiteralString(): string {
    this.index += 3
    this.newline()
    let out = ""
    for (;;) {
      if (this.index >= this.text.length) this.fail("invalid multiline literal string, expected `'''`")
      if (this.startsWith("'''")) {
        let quotes = 3
        while (this.peek(quotes) === "'" && quotes < 5) quotes++
        out += "'".repeat(quotes - 3)
        this.index += quotes
        return out
      }
      if (this.newline()) {
        out += "\n"
        continue
      }
      const char = this.peek()
      this.checkStringChar(char)
      out += char
      this.index++
    }
  }

  private checkStringChar(char: string) {
    const code = char.charCodeAt(0)
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) this.fail("invalid string character")
  }

  private escape(): string {
    const char = this.peek()
    this.index++
    switch (char) {
      case "b":
        return "\b"
      case "t":
        return "\t"
      case "n":
        return "\n"
      case "f":
        return "\f"
      case "r":
        return "\r"
      case "e":
        return "\u001b"
      case '"':
        return '"'
      case "\\":
        return "\\"
      case "x":
        return this.hexEscape(2)
      case "u":
        return this.hexEscape(4)
      case "U":
        return this.hexEscape(8)
      default:
        return this.fail("invalid escape sequence", this.index - 1)
    }
  }

  private hexEscape(length: number): string {
    const digits = this.text.slice(this.index, this.index + length)
    if (!new RegExp(`^[0-9A-Fa-f]{${length}}$`).test(digits)) this.fail("invalid unicode escape")
    const code = Number.parseInt(digits, 16)
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) this.fail("invalid unicode escape")
    this.index += length
    return String.fromCodePoint(code)
  }

  private array(): TomlValue {
    this.index++
    const items: TomlValue[] = []
    for (;;) {
      this.skipBlank()
      if (this.peek() === "]") {
        this.index++
        return { kind: "array", items }
      }
      items.push(this.value())
      this.skipBlank()
      if (this.peek() === ",") {
        this.index++
        continue
      }
      if (this.peek() === "]") {
        this.index++
        return { kind: "array", items }
      }
      this.fail("invalid array, expected `,` or `]`")
    }
  }

  private inlineTable(): TomlValue {
    this.index++
    const table = tomlTable()
    this.states.set(table, "inline")
    for (;;) {
      this.skipBlank()
      if (this.peek() === "}") {
        this.index++
        this.freeze(table)
        return table
      }
      this.keyValue(table)
      this.skipBlank()
      if (this.peek() === ",") {
        this.index++
        continue
      }
      if (this.peek() === "}") {
        this.index++
        this.freeze(table)
        return table
      }
      this.fail("invalid inline table, expected `,` or `}`")
    }
  }

  private freeze(table: TomlTable) {
    this.states.set(table, "inline")
    for (const value of table.entries.values()) if (value.kind === "table") this.freeze(value)
  }

  private datetime(): TomlValue {
    const rest = this.text.slice(this.index)
    const date = DATE.exec(rest)
    let consumed = 0
    let out = ""
    if (date) {
      const [text, year, month, day] = date
      if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > daysInMonth(Number(year), Number(month)))
        this.fail("invalid date")
      out = text
      consumed = text.length
      const separator = rest[consumed]
      const afterSeparator = rest.slice(consumed + 1)
      if ((separator === "T" || separator === "t" || separator === " ") && /^\d{2}:\d{2}/.test(afterSeparator)) {
        consumed++
        const time = this.time(afterSeparator)
        out += `T${time.text}`
        consumed += time.length
        const offset = OFFSET.exec(rest.slice(consumed))
        if (offset) {
          const value = offset[0]
          if (value !== "Z" && value !== "z") {
            const [hours, minutes] = value.slice(1).split(":").map(Number)
            if (hours > 23 || minutes > 59) this.fail("invalid offset")
          }
          out += value === "z" ? "Z" : value
          consumed += value.length
        }
      }
    } else {
      const time = this.time(rest)
      out = time.text
      consumed = time.length
    }
    if (/[A-Za-z0-9_.:+-]/.test(rest[consumed] ?? "")) this.fail("invalid datetime")
    this.index += consumed
    return { kind: "datetime", value: out }
  }

  private time(text: string): { readonly text: string; readonly length: number } {
    const match = TIME.exec(text)
    if (!match) return this.fail("invalid time")
    const [whole, hour, minute, second, fraction] = match
    if (Number(hour) > 23 || Number(minute) > 59 || Number(second ?? "0") > 60) this.fail("invalid time")
    if (fraction !== undefined && fraction.length === 1) this.fail("invalid time")
    let normalized = `${hour}:${minute}:${second ?? "00"}`
    if (fraction !== undefined) {
      const nanos = fraction.slice(1, 10).padEnd(9, "0")
      const trimmed = nanos.replace(/0+$/, "")
      if (trimmed.length > 0) normalized += `.${trimmed}`
    }
    return { text: normalized, length: whole.length }
  }

  private number(): TomlValue {
    const rest = this.text.slice(this.index)
    const special = /^([+-])?(inf|nan)(?![A-Za-z0-9_])/.exec(rest)
    if (special) {
      this.index += special[0].length
      const negative = special[1] === "-"
      if (special[2] === "inf") return { kind: "float", value: negative ? -Infinity : Infinity }
      return { kind: "float", value: Number.NaN, negativeNan: negative }
    }
    const radix = /^0([xob])([0-9A-Fa-f_]+)/.exec(rest)
    if (radix) {
      const digits = radix[2]
      const pattern = radix[1] === "x" ? /^[0-9A-Fa-f](?:_?[0-9A-Fa-f])*$/ : radix[1] === "o" ? /^[0-7](?:_?[0-7])*$/ : /^[01](?:_?[01])*$/
      if (!pattern.test(digits)) this.fail("invalid integer")
      const value = BigInt(`0${radix[1]}${digits.replaceAll("_", "")}`)
      if (value > INT64_MAX) this.fail("integer number overflowed")
      this.index += radix[0].length
      this.checkValueEnd()
      return { kind: "integer", value }
    }
    const match = /^[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?/.exec(rest)
    if (!match || match[0].length === 0 || /^[+-]?$/.test(match[0])) return this.fail("invalid value")
    const text = match[0]
    this.index += text.length
    this.checkValueEnd()
    const clean = text.replaceAll("_", "")
    if (/[.eE]/.test(clean)) {
      const value = Number(clean)
      if (!Number.isFinite(value)) this.fail("invalid float")
      return { kind: "float", value }
    }
    const value = BigInt(clean)
    if (value < INT64_MIN || value > INT64_MAX) this.fail("integer number overflowed")
    return { kind: "integer", value }
  }

  private checkValueEnd() {
    if (/[A-Za-z0-9_.]/.test(this.peek() ?? "")) this.fail("invalid number")
  }
}

function daysInMonth(year: number, month: number) {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

export function parseToml(text: string): TomlTable {
  return new Parser(text).parse()
}

const KEY_ALIASES: readonly { readonly legacy: readonly string[]; readonly canonical: readonly string[] }[] = [
  { legacy: ["tui", "whimsy"], canonical: ["tui", "effects", "starfield"] },
  { legacy: ["memories", "no_memories_if_mcp_or_web_search"], canonical: ["memories", "disable_on_external_context"] },
  { legacy: ["agents", "max_threads"], canonical: ["agents", "max_concurrent_threads_per_session"] },
]
const STRUCTURED_FEATURES = new Set(["code_mode", "multi_agent_v2", "network_proxy", "sleep_tool", "runtime_agent_instances"])

const samePath = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every((segment, index) => segment === right[index])

function cloneToml(value: TomlValue): TomlValue {
  if (value.kind === "table") return tomlTable([...value.entries].map(([key, child]) => [key, cloneToml(child)] as const))
  if (value.kind === "array") return { kind: "array", items: value.items.map(cloneToml) }
  return value
}

function normalizeTableAliases(path: readonly string[], entries: Map<string, TomlValue>) {
  aliases: for (const alias of KEY_ALIASES) {
    const tablePath = alias.legacy.slice(0, -1)
    const legacyKey = alias.legacy[alias.legacy.length - 1]
    if (!samePath(path, tablePath) || !samePath(alias.canonical.slice(0, tablePath.length), tablePath)) continue
    const value = entries.get(legacyKey)
    if (value === undefined) continue
    entries.delete(legacyKey)
    const canonicalPath = alias.canonical.slice(tablePath.length)
    let destination = entries
    for (const parent of canonicalPath.slice(0, -1)) {
      let child = destination.get(parent)
      if (child === undefined) {
        child = tomlTable()
        destination.set(parent, child)
      }
      if (child.kind !== "table") continue aliases
      destination = child.entries
    }
    const key = canonicalPath[canonicalPath.length - 1]
    if (!destination.has(key)) destination.set(key, value)
  }
}

function normalizeKeyAliases(value: TomlValue, path: readonly string[]): TomlValue {
  if (!KEY_ALIASES.some((alias) => path.length <= alias.legacy.length && samePath(alias.legacy.slice(0, path.length), path))) return cloneToml(value)
  if (value.kind === "array") return { kind: "array", items: value.items.map((item) => normalizeKeyAliases(item, path)) }
  if (value.kind !== "table") return value
  const normalized = tomlTable([...value.entries].map(([key, child]) => [key, normalizeKeyAliases(child, [...path, key])] as const))
  normalizeTableAliases(path, normalized.entries)
  return normalized
}

function normalizeBaseKeyAliases(base: TomlValue, overlay: TomlValue, path: string[]) {
  if (base.kind !== "table" || overlay.kind !== "table") return
  normalizeTableAliases(path, base.entries)
  for (const [key, value] of overlay.entries) {
    const existing = base.entries.get(key)
    if (existing === undefined) continue
    path.push(key)
    normalizeBaseKeyAliases(existing, value, path)
    path.pop()
  }
}

function isStructuredFeaturePath(path: readonly string[]) {
  if (path.length === 4 && path[0] === "profiles") return path[2] === "features" && STRUCTURED_FEATURES.has(path[3])
  return path.length === 2 && path[0] === "features" && STRUCTURED_FEATURES.has(path[1])
}

function isNetworkDomainsPath(path: readonly string[]) {
  return (
    (path.length === 4 && path[0] === "permissions" && path[2] === "network" && path[3] === "domains") ||
    samePath(path, ["application", "network", "domains"])
  )
}

const asciiLower = (text: string) => text.replace(/[A-Z]/g, (char) => char.toLowerCase())

function normalizeIpLiteral(host: string): string {
  if (!host.includes("%") && isIP(host) !== 0) return host
  for (const delimiter of ["%25", "%"]) {
    const at = host.indexOf(delimiter)
    if (at === -1) continue
    const ip = host.slice(0, at)
    if (!ip.includes("%") && isIP(ip) !== 0) return `${ip}%${host.slice(at + delimiter.length)}`
  }
  return host
}

function normalizeDnsHostOrIpLiteral(host: string) {
  return normalizeIpLiteral(asciiLower(host).replace(/\.+$/, ""))
}

function normalizeHost(raw: string): string {
  const host = raw.trim()
  const end = host.indexOf("]")
  if (host.startsWith("[") && end !== -1) return normalizeDnsHostOrIpLiteral(host.slice(1, end))
  if (host.split(":").length === 2) return normalizeDnsHostOrIpLiteral(host.split(":")[0])
  return normalizeDnsHostOrIpLiteral(host)
}

function rekey(entries: Map<string, TomlValue>, normalize: (key: string) => string) {
  const previous = [...entries]
  entries.clear()
  for (const [key, value] of previous) entries.set(normalize(key), value)
}

function envSources(value: TomlValue | undefined): string[] | undefined {
  const env = value?.kind === "table" ? value.entries.get("env") : undefined
  return env?.kind === "array" ? env.items.flatMap((item) => (item.kind === "string" ? [item.value] : [])) : undefined
}

const envKeysMatch = (left: string, right: string) => left === right || (process.platform === "win32" && asciiLower(left) === asciiLower(right))

function replaceFilterRepresentation(base: TomlValue, overlay: TomlValue, path: readonly string[]) {
  if (!samePath(path, ["shell_environment_policy"]) || overlay.kind !== "table" || base.kind !== "table") return
  if (overlay.entries.has("filters")) for (const field of ["exclude", "include_only"]) base.entries.delete(field)
  else if (overlay.entries.has("exclude") || overlay.entries.has("include_only")) base.entries.delete("filters")
}

function mergeAt(base: TomlValue, overlay: TomlValue, path: string[]): TomlValue {
  replaceFilterRepresentation(base, overlay, path)
  if (isStructuredFeaturePath(path)) {
    if (base.kind === "boolean" && overlay.kind === "table") base = tomlTable([["enabled", base]])
    else if (base.kind === "table" && overlay.kind === "boolean") {
      base.entries.set("enabled", overlay)
      return base
    }
  }
  if (base.kind !== "table" || overlay.kind !== "table") return overlay
  return mergeTables(base, overlay, path)
}

function mergeTables(base: TomlTable, overlay: TomlTable, path: string[]): TomlTable {
  if (isNetworkDomainsPath(path)) {
    rekey(base.entries, normalizeHost)
    rekey(overlay.entries, normalizeHost)
  }
  if (samePath(path, ["shell_environment_policy", "filters"])) {
    rekey(base.entries, (key) => key.toLowerCase())
    rekey(overlay.entries, (key) => key.toLowerCase())
  }
  if (path[path.length - 1] === "credentials" && isStructuredFeaturePath(path.slice(0, -1))) {
    for (const [providerId, provider] of overlay.entries) {
      const claimed = envSources(provider)
      if (claimed === undefined) continue
      for (const [existingId, existing] of base.entries) {
        if (existingId === providerId) continue
        const sources = envSources(overlay.entries.get(existingId)) ?? envSources(existing)
        if (sources?.some((source) => claimed.some((candidate) => envKeysMatch(source, candidate)))) base.entries.delete(existingId)
      }
    }
  }
  for (const [key, value] of overlay.entries) {
    const existing = base.entries.get(key)
    path.push(key)
    base.entries.set(key, existing === undefined ? value : mergeAt(existing, value, path))
    path.pop()
  }
  return base
}

export function mergeToml(base: TomlTable, overlay: TomlTable): TomlTable {
  const normalized = tomlTable([...overlay.entries].map(([key, value]) => [key, normalizeKeyAliases(value, [key])] as const))
  normalizeTableAliases([], normalized.entries)
  const merged = tomlTable([...base.entries].map(([key, value]) => [key, cloneToml(value)] as const))
  normalizeBaseKeyAliases(merged, normalized, [])
  return mergeTables(merged, normalized, [])
}

type Selector = { terminal: boolean; readonly children: Map<string, Selector> }

function selector(paths: readonly (readonly string[])[]): Selector {
  const root: Selector = { terminal: false, children: new Map() }
  for (const path of paths) {
    let node = root
    for (const segment of path) {
      if (node.terminal) break
      let child = node.children.get(segment)
      if (child === undefined) {
        child = { terminal: false, children: new Map() }
        node.children.set(segment, child)
      }
      node = child
    }
    if (!node.terminal) {
      node.terminal = true
      node.children.clear()
    }
  }
  return root
}

function projectValue(value: TomlValue, node: Selector): TomlValue {
  if (node.terminal || value.kind !== "table") return value
  const projected = tomlTable()
  for (const [key, child] of value.entries) {
    const childNode = node.children.get(key)
    if (childNode !== undefined) projected.entries.set(key, projectValue(child, childNode))
  }
  return projected
}

export function projectToml(value: TomlValue, paths: readonly (readonly string[])[]): TomlValue | undefined {
  const node = selector(paths)
  const projected = projectValue(value, node)
  if (!node.terminal && projected.kind === "table" && projected.entries.size === 0) return undefined
  return projected
}

function keyRepr(key: string): string {
  if (BARE_KEY.test(key)) return key
  let escapeCodes = false
  let escape = false
  let doubleQuotes = false
  let singleQuotes = false
  for (const char of key) {
    const code = char.charCodeAt(0)
    if (char === "'") singleQuotes = true
    else if (char === '"') doubleQuotes = true
    else if (char === "\\") escape = true
    else if (char !== "\t" && (code <= 0x1f || code === 0x7f)) escapeCodes = true
  }
  if (!escapeCodes && !escape && !doubleQuotes) return `"${key}"`
  if (!escapeCodes && !singleQuotes) return `'${key}'`
  return `"${escapeBasic(key, false)}"`
}

function escapeBasic(value: string, multiline: boolean): string {
  const maxQuotes = multiline ? 2 : 0
  let out = ""
  let quotes = 0
  for (const char of value) {
    if (char === '"') {
      quotes++
      out += quotes > maxQuotes ? '\\"' : '"'
      if (quotes > maxQuotes) quotes = 0
      continue
    }
    quotes = 0
    const code = char.charCodeAt(0)
    if (char === "\b") out += "\\b"
    else if (char === "\t") out += "\\t"
    else if (char === "\n") out += multiline ? "\n" : "\\n"
    else if (char === "\f") out += "\\f"
    else if (char === "\r") out += "\\r"
    else if (char === "\\") out += "\\\\"
    else if (code <= 0x1f || code === 0x7f) out += `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`
    else out += char
  }
  return out
}

function stringRepr(value: string): string {
  let maxSingles = 0
  let maxDoubles = 0
  let singles = 0
  let doubles = 0
  let escapeCodes = false
  let escape = false
  let newline = false
  for (const char of value) {
    singles = char === "'" ? singles + 1 : 0
    doubles = char === '"' ? doubles + 1 : 0
    maxSingles = Math.max(maxSingles, singles)
    maxDoubles = Math.max(maxDoubles, doubles)
    const code = char.charCodeAt(0)
    if (char === "\\") escape = true
    else if (char === "\n") newline = true
    else if (char !== "\t" && (code <= 0x1f || code === 0x7f)) escapeCodes = true
  }
  const prefix = newline ? "\n" : ""
  if (!escapeCodes && !escape && maxDoubles === 0 && !newline) return `"${escapeBasic(value, false)}"`
  if (!escapeCodes && maxSingles === 0 && !newline) return `'${value}'`
  if (!escapeCodes && !escape && maxDoubles <= 2) return `"""${prefix}${escapeBasic(value, true)}"""`
  if (!escapeCodes && maxSingles <= 2) return `'''${prefix}${value}'''`
  return newline ? `"""${prefix}${escapeBasic(value, true)}"""` : `"${escapeBasic(value, false)}"`
}

function decimal(value: number): string {
  const text = Math.abs(value).toString()
  const match = /^(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(text)
  if (!match) return text
  const digits = match[1] + (match[2] ?? "")
  const point = match[1].length + Number(match[3])
  if (point <= 0) return `0.${"0".repeat(-point)}${digits}`
  if (point >= digits.length) return digits + "0".repeat(point - digits.length)
  return `${digits.slice(0, point)}.${digits.slice(point)}`
}

function floatRepr(value: number, negativeNan = false): string {
  if (Number.isNaN(value)) return negativeNan ? "-nan" : "nan"
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0"
  if (value === Infinity) return "inf"
  if (value === -Infinity) return "-inf"
  const text = `${value < 0 ? "-" : ""}${decimal(value)}`
  return value % 1 === 0 ? `${text}.0` : text
}

function inlineRepr(value: TomlValue): string {
  if (value.kind === "string") return stringRepr(value.value)
  if (value.kind === "integer") return value.value.toString()
  if (value.kind === "float") return floatRepr(value.value, value.negativeNan)
  if (value.kind === "boolean") return value.value ? "true" : "false"
  if (value.kind === "datetime") return value.value
  if (value.kind === "array") return `[${value.items.map(inlineRepr).join(", ")}]`
  if (value.entries.size === 0) return "{}"
  return `{ ${[...value.entries].map(([key, item]) => `${keyRepr(key)} = ${inlineRepr(item)}`).join(", ")} }`
}

function isArrayOfTables(value: TomlValue): value is { readonly kind: "array"; readonly items: TomlTable[] } {
  return value.kind === "array" && value.items.length > 0 && value.items.every((item) => item.kind === "table")
}

export function stringifyToml(root: TomlTable): string {
  const sections: string[] = []
  const emit = (table: TomlTable, path: readonly string[], element: boolean) => {
    const lines: string[] = []
    const children: [string, TomlValue][] = []
    for (const [key, value] of table.entries) {
      if (value.kind === "table" || isArrayOfTables(value)) children.push([key, value])
      else lines.push(`${keyRepr(key)} = ${inlineRepr(value)}`)
    }
    const header = path.map(keyRepr).join(".")
    if (path.length > 0 && (element || lines.length > 0 || table.entries.size === 0))
      lines.unshift(element ? `[[${header}]]` : `[${header}]`)
    if (lines.length > 0) sections.push(`${lines.join("\n")}\n`)
    for (const [key, value] of children) {
      if (value.kind === "table") emit(value, [...path, key], false)
      else if (isArrayOfTables(value)) for (const item of value.items) emit(item, [...path, key], true)
    }
  }
  emit(root, [], false)
  return sections.join("\n")
}
