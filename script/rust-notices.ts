import { createHash } from "node:crypto"
import { readFile, readdir, writeFile } from "node:fs/promises"
import path from "node:path"

const rule = "=".repeat(80)
const divider = "-".repeat(80)
const beginLine = "BEGIN GENERATED RUST THIRD-PARTY NOTICES (script/rust-notices.ts)"
const endLine = "END GENERATED RUST THIRD-PARTY NOTICES"
const licenseFile = /^(licen[cs]e|copying|unlicense|notice|copyright)(?![a-z])/i
const licenseDirectory = /^licen[cs]es$/i
const registrySources = ["registry+https://github.com/rust-lang/crates.io-index", "sparse+https://index.crates.io/"]

export type Package = {
  id: string
  name: string
  version: string
  source: string | null
  license: string | null
  license_file?: string | null
  manifest_path: string
  authors: string[]
  repository: string | null
}

export type Data = {
  package: string
  targets: { artifact: string; triple: string }[]
  nested: { crate: string; path: string; action: "include" | "exclude"; reason: string }[]
  supplements: { source: string; revision: string; path: string; url: string; file: string; sha256: string; crates: string[] }[]
  elections: {
    crate: string
    version: string
    license: string
    file: string
    sha256: string
    source: string
    statement: { file: string; text: string }
    evidence: string[]
    caveats: string[]
  }[]
  corrections: { crate: string; version: string; declared: string; effective: string; evidence: string[] }[]
  headers: { crate: string; version: string; component: string; file: string; start: string; end: string }[]
  native: {
    duckdb: {
      crate: string
      version: string
      archive: string
      source: string
      revision: string
      licenses: { directory: string; path: string; url: string; file: string; sha256: string }[]
    }
    sqlite: { crate: string; version: string; file: string }
  }
  embedded: { component: string; path: string }[]
  models: { component: string; url: string; file: string; sha256: string }
}

export type Input = {
  root: string
  dataDirectory: string
  data: Data
  packages: Package[]
  workspaceMembers: string[]
  trees: Record<string, string>
}

type Document = { text: string; label: string; source?: string }

const signatures: Record<string, (text: string) => boolean> = {
  MIT: (text) =>
    text.includes("permission is hereby granted, free of charge") &&
    text.includes("the above copyright notice and this permission notice shall be included"),
  "MIT-0": (text) =>
    text.includes("permission is hereby granted, free of charge") && !text.includes("the above copyright notice"),
  ISC: (text) =>
    text.includes(
      "permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies",
    ),
  "0BSD": (text) =>
    text.includes("permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted."),
  "Apache-2.0": (text) => text.includes("apache license") && text.includes("version 2.0, january 2004"),
  "BSD-3-Clause": (text) =>
    text.includes("redistributions of source code must retain") &&
    text.includes("redistributions in binary form must reproduce") &&
    text.includes("endorse or promote products"),
  "BSD-2-Clause": (text) =>
    text.includes("redistributions of source code must retain") &&
    text.includes("redistributions in binary form must reproduce") &&
    !text.includes("endorse or promote products"),
  "Unicode-3.0": (text) => text.includes("unicode license v3"),
  Zlib: (text) => text.includes("altered source versions must be plainly marked"),
  "BSL-1.0": (text) => text.includes("boost software license"),
  "CC0-1.0": (text) => text.includes("cc0 1.0 universal"),
  Unlicense: (text) => text.includes("this is free and unencumbered software released into the public domain"),
  "MPL-2.0": (text) => /mozilla public license,? version 2\.0/.test(text),
  "CDLA-Permissive-2.0": (text) => text.includes("community data license agreement") && text.includes("permissive"),
  "GPL-2.0-only": (text) => text.includes("gnu general public license") && text.includes("version 2"),
}

const exceptions: Record<string, string[]> = { "Apache-2.0": ["LLVM-exception"] }
const exceptionSignatures: Record<string, (text: string) => boolean> = {
  "Apache-2.0 WITH LLVM-exception": (text) => text.includes("llvm exceptions to the apache 2.0 license"),
}

export function treeArguments(data: Data, triple: string) {
  return [
    "tree",
    "--offline",
    "--locked",
    "--manifest-path",
    "rust/Cargo.toml",
    "-p",
    data.package,
    "-e",
    "normal",
    "--target",
    triple,
    "--no-dedupe",
    "--prefix",
    "depth",
    "--format",
    "{p}",
  ]
}

export function metadataArguments(triple: string) {
  return [
    "metadata",
    "--format-version",
    "1",
    "--offline",
    "--locked",
    "--manifest-path",
    "rust/Cargo.toml",
    "--filter-platform",
    triple,
  ]
}

export function parseTree(output: string) {
  const entries = new Map<string, { name: string; version: string; local: boolean }>()
  let pruned: number | undefined
  for (const line of output.split("\n")) {
    const match = /^(\d+)(\S+) v(\S+)(.*)$/.exec(line.trimEnd())
    if (!match) continue
    const [, depthText, name, version, rest] = match
    if (depthText === undefined || name === undefined || version === undefined || rest === undefined) continue
    const depth = Number(depthText)
    if (pruned !== undefined && depth > pruned) continue
    pruned = undefined
    if (rest.includes("(proc-macro)")) {
      pruned = depth
      continue
    }
    entries.set(`${name} ${version}`, { name, version, local: rest.replace("(*)", "").trim().length > 0 })
  }
  return [...entries.values()]
}

export function shippedPackages(input: Input) {
  const byKey = new Map<string, Package[]>()
  for (const item of input.packages) byKey.set(`${item.name} ${item.version}`, [...(byKey.get(`${item.name} ${item.version}`) ?? []), item])
  const shipped = new Map<string, Package>()
  for (const target of input.data.targets) {
    const output = input.trees[target.triple]
    if (output === undefined) throw new Error(`missing cargo tree output for ${target.triple}`)
    for (const entry of parseTree(output)) {
      const key = `${entry.name} ${entry.version}`
      const candidates = [...new Map((byKey.get(key) ?? []).map((item) => [item.id, item])).values()]
      const found = candidates[0]
      if (candidates.length !== 1 || found === undefined)
        throw new Error(`cargo tree package ${key} resolves to ${candidates.length} metadata packages`)
      if (found.source === null) {
        if (!input.workspaceMembers.includes(found.id)) throw new Error(`shipped package ${key} is a path dependency outside the workspace`)
        continue
      }
      if (entry.local || !registrySources.includes(found.source)) throw new Error(`shipped package ${key} has unsupported source ${found.source}`)
      shipped.set(key, found)
    }
  }
  return [...shipped.values()].sort((left, right) => compare(`${left.name} ${left.version}`, `${right.name} ${right.version}`))
}

export function detectLicenses(text: string) {
  const collapsed = text
    .replace(/^[ \t]*(\/\/|#|\*)+/gm, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
  const found = Object.entries(signatures)
    .filter((entry) => entry[1](collapsed))
    .map((entry) => entry[0])
  return [
    ...found,
    ...Object.entries(exceptionSignatures)
      .filter((entry) => found.includes(entry[0].slice(0, entry[0].indexOf(" WITH "))) && entry[1](collapsed))
      .map((entry) => entry[0]),
  ]
}

export function expressionSatisfied(expression: string, detected: ReadonlySet<string>) {
  const tokens = expression.replace(/\//g, " OR ").match(/\(|\)|[A-Za-z0-9.+-]+/g) ?? []
  let position = 0
  const or = (): boolean => {
    let value = and()
    while (tokens[position] === "OR") {
      position++
      const next = and()
      value = value || next
    }
    return value
  }
  const and = (): boolean => {
    let value = atom()
    while (tokens[position] === "AND") {
      position++
      const next = atom()
      value = value && next
    }
    return value
  }
  const atom = (): boolean => {
    const token = tokens[position++]
    if (token === "(") {
      const value = or()
      if (tokens[position++] !== ")") throw new Error(`unbalanced license expression: ${expression}`)
      return value
    }
    if (token === undefined || token === ")" || token === "AND" || token === "OR" || token === "WITH")
      throw new Error(`malformed license expression: ${expression}`)
    if (!(token in signatures)) throw new Error(`license identifier ${token} has no text signature (${expression})`)
    if (tokens[position] !== "WITH") return detected.has(token)
    const exception = tokens[position + 1]
    if (exception === undefined || exception === ")" || exception === "AND" || exception === "OR" || exception === "WITH")
      throw new Error(`malformed license expression: ${expression}`)
    if (!exceptions[token]?.includes(exception)) throw new Error(`unsupported license exception ${exception} for ${token} (${expression})`)
    position += 2
    return detected.has(`${token} WITH ${exception}`)
  }
  const value = or()
  if (position !== tokens.length) throw new Error(`malformed license expression: ${expression}`)
  return value
}

export function prefixOf(current: string) {
  const start = current.indexOf(`${rule}\n${beginLine}\n`)
  return start < 0 ? current : current.slice(0, start)
}

export function spliceNotice(current: string, section: string) {
  const startMarker = `${rule}\n${beginLine}\n`
  const endMarker = `${endLine}\n${rule}\n`
  const starts = current.split(startMarker).length - 1
  const ends = current.split(endMarker).length - 1
  if (starts === 0 && ends === 0)
    return `${current}${current.endsWith("\n") ? "" : "\n"}\n${section}`
  if (starts !== 1 || ends !== 1) throw new Error("NOTICE must contain exactly one generated Rust section with matching markers")
  const start = current.indexOf(startMarker)
  const end = current.indexOf(endMarker)
  if (end < start) throw new Error("NOTICE generated Rust section ends before it begins")
  return current.slice(0, start) + section + current.slice(end + endMarker.length)
}

export async function buildNotice(current: string, input: Input) {
  validateData(input.data)
  const prefix = prefixOf(current)
  const shipped = shippedPackages(input)
  const documents: Document[] = []
  validateRuleTargets(input, shipped)
  for (const item of shipped) {
    documents.push(...(await collectPackage(item, input)))
  }
  documents.push(...(await nativeDocuments(input, shipped)))
  documents.push(...(await embeddedDocuments(input)))
  documents.push(await modelDocument(input))
  return spliceNotice(current, render(input, prefix, shipped, documents))
}

function validateData(data: Data) {
  for (const rule of data.nested) {
    if (rule.action !== "include" && rule.action !== "exclude")
      throw new Error(`nested rule ${rule.crate} ${rule.path} has invalid action ${rule.action}`)
    if (rule.reason.trim().length === 0) throw new Error(`nested rule ${rule.crate} ${rule.path} needs a reason`)
  }
  rejectDuplicates("nested rule", data.nested.map((entry) => `${entry.crate} ${entry.path}`))
  rejectDuplicates("election", data.elections.map((entry) => `${entry.crate} ${entry.version}`))
  rejectDuplicates("correction", data.corrections.map((entry) => `${entry.crate} ${entry.version}`))
  rejectDuplicates("header", data.headers.map((entry) => `${entry.crate} ${entry.version} ${entry.file}`))
}

function rejectDuplicates(kind: string, keys: string[]) {
  const seen = new Set<string>()
  for (const key of keys) {
    if (seen.has(key)) throw new Error(`duplicate ${kind} for ${key}`)
    seen.add(key)
  }
}

function validateRuleTargets(input: Input, shipped: Package[]) {
  const keys = new Set(shipped.map((item) => `${item.name} ${item.version}`))
  const names = new Set(shipped.map((item) => item.name))
  for (const item of input.data.nested)
    if (!names.has(item.crate)) throw new Error(`nested license rule names ${item.crate}, which is not in the shipped closure`)
  for (const item of input.data.supplements)
    for (const crate of item.crates)
      if (!keys.has(crate)) throw new Error(`supplement ${item.file} names ${crate}, which is not in the shipped closure`)
  for (const item of input.data.elections)
    if (!keys.has(`${item.crate} ${item.version}`))
      throw new Error(`election names ${item.crate} ${item.version}, which is not in the shipped closure`)
  for (const item of input.data.corrections)
    if (!keys.has(`${item.crate} ${item.version}`))
      throw new Error(`correction names ${item.crate} ${item.version}, which is not in the shipped closure`)
  for (const item of input.data.headers)
    if (!keys.has(`${item.crate} ${item.version}`))
      throw new Error(`header names ${item.crate} ${item.version}, which is not in the shipped closure`)
}

export async function collectPackage(item: Package, input: Input) {
  const key = `${item.name} ${item.version}`
  const directory = path.dirname(item.manifest_path)
  const top = await topLevelFiles(directory, item)
  const nested = (await nestedFiles(directory, top)).map((file) => classify(input.data, item, file))
  for (const rule of input.data.nested.filter((entry) => entry.crate === item.name)) {
    if (!(await Bun.file(path.join(directory, rule.path)).exists()))
      throw new Error(`nested license rule for ${key} names ${rule.path}, which does not exist`)
  }
  const supplements = supplementsFor(input.data, key)
  const label = (file: string) => `${key} (${file})`
  const documents: Document[] = []
  for (const file of top) documents.push({ text: await readText(path.join(directory, file)), label: label(file) })
  for (const file of nested.filter((entry) => entry.action === "include"))
    documents.push({ text: await readText(path.join(directory, file.path)), label: label(file.path) })
  const election = input.data.elections.find((entry) => entry.crate === item.name && entry.version === item.version)
  const correction = input.data.corrections.find((entry) => entry.crate === item.name && entry.version === item.version)
  if (top.length > 0 && supplements.length > 0)
    throw new Error(`${key} ships license files and also has a supplement; remove the stale supplement`)
  if (top.length > 0 && election) throw new Error(`${key} ships license files and also has an election; remove the stale election`)
  if (election && supplements.length > 0) throw new Error(`${key} has both an election and a supplement`)
  if (top.length === 0 && supplements.length === 0 && !election)
    throw new Error(`${key} has no license text in its package or supplements; add verified upstream license text to script/rust-notices/sources.json`)
  for (const supplement of supplements)
    documents.push({
      text: await verifiedText(input, supplement.file, supplement.sha256),
      label: label(`${supplement.path} @ ${supplement.source} ${supplement.revision.slice(0, 12)}`),
      source: supplement.url,
    })
  if (election) documents.push(await electionDocument(input, item, directory, election))
  if (!item.license) throw new Error(`${key} declares no license expression`)
  if (correction && correction.declared !== item.license)
    throw new Error(`${key} has a stale correction: the package declares ${item.license}, not ${correction.declared}`)
  const expression = correction ? correction.effective : item.license
  const detected = new Set(documents.flatMap((entry) => detectLicenses(entry.text)))
  if (!expressionSatisfied(expression, detected))
    throw new Error(`${key} declares ${expression}, but its license texts only evidence: ${[...detected].sort(compare).join(", ") || "nothing"}`)
  for (const header of input.data.headers.filter((entry) => entry.crate === item.name && entry.version === item.version))
    documents.push({
      text: sourceHeader(await readText(path.join(directory, header.file)), `${key} ${header.file}`, header),
      label: label(`${header.file} header: ${header.component}`),
    })
  return documents
}

async function electionDocument(input: Input, item: Package, directory: string, election: Data["elections"][number]): Promise<Document> {
  const key = `${item.name} ${item.version}`
  if (!item.license || !expressionSatisfied(item.license, new Set([election.license])))
    throw new Error(`${key} declares ${item.license} and does not offer ${election.license}`)
  const statement = await readText(path.join(directory, election.statement.file))
  if (!statement.includes(election.statement.text))
    throw new Error(`${key} election statement "${election.statement.text}" is not present in ${election.statement.file}`)
  return {
    text: await verifiedText(input, election.file, election.sha256),
    label: `${key} (${election.license} election; ${election.statement.file})`,
    source: election.source,
  }
}

function sourceHeader(source: string, name: string, header: Data["headers"][number]) {
  const lines = source.split("\n")
  const start = lines.findIndex((line) => line.includes(header.start))
  const end = start < 0 ? -1 : lines.findIndex((line, index) => index >= start && line.includes(header.end))
  if (end < 0) throw new Error(`${name} does not contain a header from "${header.start}" to "${header.end}"`)
  return normalize(
    lines
      .slice(start, end + 1)
      .map((line) => line.replace(/^\s*(\/\*+|\*+\/?|\/\/+)\s?/, "").trimEnd())
      .join("\n"),
  )
}

async function topLevelFiles(directory: string, item: Package) {
  const entries = await readdir(directory, { withFileTypes: true })
  const direct = entries.filter((entry) => entry.isFile() && licenseFile.test(entry.name)).map((entry) => entry.name)
  const grouped = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && licenseDirectory.test(entry.name))
      .map(async (entry) =>
        (await readdir(path.join(directory, entry.name), { withFileTypes: true }))
          .filter((child) => child.isFile())
          .map((child) => `${entry.name}/${child.name}`),
      ),
  )
  const declared = item.license_file ? [item.license_file.split(path.sep).join("/")] : []
  return [...new Set([...direct, ...grouped.flat(), ...declared])].sort(compare)
}

async function nestedFiles(directory: string, top: string[]) {
  return (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile() && licenseFile.test(entry.name))
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .filter(
      (file) =>
        file.includes("/") &&
        !top.includes(file) &&
        !licenseDirectory.test(file.slice(0, file.indexOf("/"))) &&
        !file.split("/").some((segment) => segment.startsWith(".")),
    )
    .sort(compare)
}

function classify(data: Data, item: Package, file: string) {
  const rule = data.nested.find((entry) => entry.crate === item.name && entry.path === file)
  if (!rule)
    throw new Error(
      `${item.name} ${item.version} contains unclassified license file ${file}; add an include or exclude rule to script/rust-notices/sources.json`,
    )
  return rule
}

function supplementsFor(data: Data, key: string) {
  const found = data.supplements.filter((entry) => entry.crates.includes(key))
  const paths = found.map((entry) => entry.path)
  if (new Set(paths).size !== paths.length) throw new Error(`${key} has conflicting supplements for the same path`)
  return found
}

async function nativeDocuments(input: Input, shipped: Package[]) {
  const native = input.data.native
  const duckdb = shipped.find((item) => item.name === native.duckdb.crate)
  const sqlite = shipped.find((item) => item.name === native.sqlite.crate)
  if (!duckdb || duckdb.version !== native.duckdb.version)
    throw new Error(`DuckDB native evidence pins ${native.duckdb.crate} ${native.duckdb.version}, which is not the shipped version`)
  if (!sqlite || sqlite.version !== native.sqlite.version)
    throw new Error(`SQLite native evidence pins ${native.sqlite.crate} ${native.sqlite.version}, which is not the shipped version`)
  const archive = path.join(path.dirname(duckdb.manifest_path), native.duckdb.archive)
  const listed = await archiveDirectories(archive)
  const covered = native.duckdb.licenses.map((entry) => entry.directory)
  const missing = listed.filter((entry) => !covered.includes(entry))
  const stale = covered.filter((entry) => !listed.includes(entry))
  if (missing.length > 0 || stale.length > 0)
    throw new Error(
      `DuckDB archive third_party directories differ from sources.json (unlicensed: ${missing.join(", ") || "none"}; stale: ${stale.join(", ") || "none"})`,
    )
  const documents: Document[] = []
  for (const entry of native.duckdb.licenses)
    documents.push({
      text: await verifiedText(input, entry.file, entry.sha256),
      label: `DuckDB ${entry.path} (bundled by ${duckdb.name} ${duckdb.version}; ${native.duckdb.source} ${native.duckdb.revision.slice(0, 12)})`,
      source: entry.url,
    })
  const sqliteSource = await readText(path.join(path.dirname(sqlite.manifest_path), native.sqlite.file))
  documents.push({ text: sqliteBlessing(sqliteSource, native.sqlite.file), label: `SQLite (bundled by ${sqlite.name} ${sqlite.version}; ${native.sqlite.file})` })
  return documents
}

async function archiveDirectories(archive: string) {
  const listing = Bun.spawnSync(["tar", "-tzf", archive], { stdout: "pipe", stderr: "pipe" })
  if (listing.exitCode !== 0) throw new Error(`cannot list ${archive}: ${listing.stderr.toString().trim()}`)
  return [
    ...new Set(
      listing.stdout
        .toString()
        .split("\n")
        .map((line) => /^(?:\.\/)?[^/]+\/third_party\/([^/]+)\//.exec(line)?.[1])
        .filter((entry): entry is string => entry !== undefined),
    ),
  ].sort(compare)
}

function sqliteBlessing(source: string, file: string) {
  const lines = source.split("\n").slice(0, 200)
  const start = lines.findIndex((line) => line.includes("The author disclaims copyright to this source code."))
  const end = lines.findIndex((line) => line.includes("May you share freely, never taking more than you give."))
  if (start < 0 || end < start) throw new Error(`${file} does not carry the SQLite public-domain dedication`)
  return lines
    .slice(start, end + 1)
    .map((line) => line.replace(/^\*\*\s?/, "").trimEnd())
    .join("\n")
}

async function embeddedDocuments(input: Input) {
  return Promise.all(
    input.data.embedded.map(async (entry) => ({
      text: await readText(path.join(input.root, entry.path)),
      label: `${entry.component} (${entry.path})`,
    })),
  )
}

async function modelDocument(input: Input): Promise<Document> {
  const entry = input.data.models
  return { text: await verifiedText(input, entry.file, entry.sha256), label: entry.component, source: entry.url }
}

async function verifiedText(input: Input, file: string, sha256: string) {
  const bytes = Buffer.from(await readFile(path.join(input.dataDirectory, file)))
  const actual = createHash("sha256").update(bytes).digest("hex")
  if (actual !== sha256) throw new Error(`${file} digest ${actual} does not match sources.json (${sha256})`)
  return decode(bytes, file)
}

async function readText(file: string) {
  return decode(Buffer.from(await readFile(file)), file)
}

function decode(bytes: Buffer, file: string) {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)
  if (text.trim().length === 0) throw new Error(`${file} is empty`)
  return normalize(text)
}

function normalize(text: string) {
  return text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/^\n+/, "")
    .trimEnd()
}

function render(
  input: Input,
  prefix: string,
  shipped: Package[],
  documents: Document[],
) {
  const groups = new Map<string, { labels: string[]; sources: Set<string> }>()
  for (const document of documents) {
    const group = groups.get(document.text) ?? { labels: [], sources: new Set<string>() }
    group.labels.push(document.label)
    if (document.source) group.sources.add(document.source)
    groups.set(document.text, group)
  }
  const flattenedPrefix = prefix.replace(/\s+/g, " ")
  const blocks = [...groups.entries()]
    .map((entry) => ({ text: entry[0], labels: entry[1].labels.sort(compare), sources: [...entry[1].sources].sort(compare) }))
    .sort((left, right) => compare(firstLabel(left.labels), firstLabel(right.labels)) || compare(left.text, right.text))
    .map((group) =>
      [
        divider,
        "Applies to:",
        ...group.labels.map((label) => `  ${label}`),
        ...(group.sources.length === 0 ? [] : ["Source:", ...group.sources.map((source) => `  ${source}`)]),
        "",
        flattenedPrefix.includes(group.text.replace(/\s+/g, " "))
          ? "This notice is reproduced in full earlier in this file."
          : group.text,
        "",
      ].join("\n"),
    )
  return [
    rule,
    beginLine,
    rule,
    "",
    "The Rust runtime binary links the third-party crates and bundled native sources below.",
    "Each text comes from published package files, license files at pinned upstream revisions",
    "(supplements and bundled native sources), repository-owned license files, an owner-approved",
    "election of the canonical Apache-2.0 text, or a source-header notice with its comment markers",
    "removed. Texts are normalized to LF line endings without leading blank lines or trailing",
    "whitespace. When a crate offers a choice of licenses, every text it ships is included.",
    "",
    `Closure: ${shipped.length} crates from \`cargo tree -p ${input.data.package} -e normal\` for ${input.data.targets
      .map((target) => `${target.artifact} (${target.triple})`)
      .join(", ")}.`,
    "Procedural macros, build scripts, and development dependencies are not part of the closure.",
    "",
    ...blocks,
    ...determinations(input, shipped),
    endLine,
    rule,
    "",
  ].join("\n")
}

function determinations(input: Input, shipped: Package[]) {
  const license = (crate: string, version: string) => shipped.find((item) => item.name === crate && item.version === version)?.license
  const entries = [
    ...input.data.elections.map((entry) => ({
      key: `${entry.crate} ${entry.version}`,
      lines: [
        `${entry.crate} ${entry.version}: ${entry.license} elected from "${license(entry.crate, entry.version)}" (statement in ${entry.statement.file}: "${entry.statement.text}"); text: ${entry.source}`,
        ...entry.evidence.map((item) => `  Evidence: ${item}`),
        ...entry.caveats.map((item) => `  Caveat: ${item}`),
      ],
    })),
    ...input.data.corrections.map((entry) => ({
      key: `${entry.crate} ${entry.version}`,
      lines: [
        `${entry.crate} ${entry.version}: package metadata declares ${entry.declared}; evidenced license ${entry.effective}`,
        ...entry.evidence.map((item) => `  Evidence: ${item}`),
      ],
    })),
  ].sort((left, right) => compare(left.key, right.key))
  if (entries.length === 0) return []
  return [divider, "Approved license determinations", "", ...entries.flatMap((entry) => entry.lines), ""]
}

function firstLabel(labels: string[]) {
  const first = labels[0]
  if (first === undefined) throw new Error("license group has no labels")
  return first
}

function compare(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

async function cargo(root: string, args: string[]) {
  const process = Bun.spawn(["cargo", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited])
  if (code !== 0) throw new Error(`cargo ${args[0]} failed (${code}): ${stderr.trim()}`)
  return stdout
}

export async function loadInput(root: string): Promise<Input> {
  const dataDirectory = path.join(root, "script/rust-notices")
  const data: Data = JSON.parse(await readFile(path.join(dataDirectory, "sources.json"), "utf8"))
  const trees = Object.fromEntries(
    await Promise.all(data.targets.map(async (target) => [target.triple, await cargo(root, treeArguments(data, target.triple))] as const)),
  )
  const metadata = await Promise.all(
    data.targets.map(async (target) => JSON.parse(await cargo(root, metadataArguments(target.triple))) as { packages: Package[]; workspace_members: string[] }),
  )
  return {
    root,
    dataDirectory,
    data,
    trees,
    packages: metadata.flatMap((entry) => entry.packages),
    workspaceMembers: [...new Set(metadata.flatMap((entry) => entry.workspace_members))],
  }
}

export async function generate(root: string, mode: "write" | "check") {
  const noticePath = path.join(root, "NOTICE")
  const current = await readFile(noticePath, "utf8")
  const next = await buildNotice(current, await loadInput(root))
  if (next === current) return true
  if (mode === "check") return false
  await writeFile(noticePath, next)
  return true
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dirname, "..")
  const mode = process.argv.includes("--check") ? "check" : "write"
  const ok = await generate(root, mode)
  if (!ok) {
    console.error("NOTICE is out of date; run `bun script/rust-notices.ts` and commit the result")
    process.exit(1)
  }
}
