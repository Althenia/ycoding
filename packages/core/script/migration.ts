#!/usr/bin/env bun

import { $ } from "bun"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import { parseArgs } from "util"
import { Schema } from "effect"

const root = path.resolve(import.meta.dirname, "../../..")
const snapshot = path.join(root, "packages/core/schema.json")
const tsDir = path.join(root, "packages/core/src/database/migration")
const registry = path.join(root, "packages/core/src/database/migration.gen.ts")
const schema = path.join(root, "packages/core/src/database/schema.gen.ts")
const args = parseArgs({
  args: import.meta.main ? process.argv.slice(2) : [],
  options: {
    check: { type: "boolean" },
    reset: { type: "boolean" },
    name: { type: "string" },
    regenerate: { type: "string" },
    baseline: { type: "string" },
  },
})

const pragmaOff = "PRAGMA foreign_keys=OFF;"
const pragmaOn = "PRAGMA foreign_keys=ON;"
const byName = (left: string, right: string) => left.localeCompare(right)

const review = (table: string) => new Error(`Table rebuild for ${table} requires review`)

const action = /ON\s+(?:DELETE|UPDATE)\s+(?:NO ACTION|SET NULL|SET DEFAULT|CASCADE|RESTRICT)/
const actions = `((?:\\s+${action.source})*)`
const actionClauses = new RegExp(action.source, "gi")
const keyHead = /FOREIGN KEY\s*\(\s*`([^`]+)`\s*\)\s+REFERENCES\s+`([^`]+)`\s*\(\s*`([^`]+)`\s*\)/
const canonicalKey = new RegExp(keyHead.source + actions, "gi")
const inlineHead = /\bREFERENCES\s+`?(\w+)`?\s*\(\s*`?(\w+)`?\s*\)/
const inlineReference = new RegExp(inlineHead.source + actions, "i")

if (import.meta.main) {
  if (args.values.regenerate !== undefined || args.values.baseline !== undefined) {
    await regenerate(args.values)
    process.exit(0)
  }
  if (args.values.check) {
    await check()
    process.exit(0)
  }
  if (args.values.reset) {
    await reset()
    process.exit(0)
  }
  await generate()
}

type RegenerationOptions = {
  regenerate?: string
  baseline?: string
  check?: boolean
  reset?: boolean
  name?: string
}

function validateRegenerationOptions(options: RegenerationOptions) {
  if (!options.regenerate || !options.baseline || options.check || options.reset || options.name !== undefined) {
    throw new Error("Regeneration requires --regenerate and --baseline without --check, --reset, or --name")
  }
  if (!/^\d{14}_[a-zA-Z0-9_-]+$/.test(options.regenerate)) {
    throw new Error("Invalid regeneration target")
  }
}

interface RegenerationInput extends RegenerationOptions {
  migrations: readonly string[]
  current: unknown
  previous: unknown
  generatedCount?: number
  generatedSql?: string
}

export function validateRegeneration(input: RegenerationInput) {
  validateRegenerationOptions(input)
  if (!input.migrations.includes(input.regenerate!) || input.migrations.at(-1) !== input.regenerate) {
    throw new Error("Regeneration target must exist and be the latest migration")
  }
  const snapshotSchema = Schema.Struct({
    version: Schema.Literal("7"),
    dialect: Schema.Literal("sqlite"),
    id: Schema.String,
    prevIds: Schema.Array(Schema.String),
    ddl: Schema.Array(Schema.Unknown),
  })
  const current = Schema.decodeUnknownSync(snapshotSchema)(input.current)
  const previous = Schema.decodeUnknownSync(snapshotSchema)(input.previous)
  if (!current.id || !previous.id || previous.id === current.id || !current.prevIds.includes(previous.id)) {
    throw new Error("Regeneration baseline must be a previous snapshot of the current schema")
  }
  if (input.generatedCount !== undefined && input.generatedCount !== 1) {
    throw new Error(`Expected one generated migration, found ${input.generatedCount}`)
  }
  if (input.generatedSql !== undefined && !input.generatedSql.trim()) {
    throw new Error("Generated migration has no incremental SQL")
  }
}

async function regenerate(options: RegenerationOptions) {
  validateRegenerationOptions(options)
  const targetID = options.regenerate!
  const baseline = options.baseline!
  const migrations = await typescriptMigrations()
  const current = await Bun.file(snapshot).json()
  const previous = await Bun.file(baseline).json()
  const input = { ...options, migrations, current, previous }
  validateRegeneration(input)
  const target = path.join(tsDir, `${targetID}.ts`)
  if (!(await fs.lstat(target)).isFile()) throw new Error(`Invalid migration target: ${targetID}`)

  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-core-migration-"))
  const incremental = path.join(temporary, "incremental")
  const full = path.join(temporary, "full")
  try {
    await fs.mkdir(incremental)
    await fs.mkdir(path.join(incremental, "baseline"))
    await Bun.write(path.join(incremental, "baseline/snapshot.json"), JSON.stringify(previous))
    await drizzle(temporary, incremental)
    const generated = await generatedMigrations(incremental)
    validateRegeneration({ ...input, generatedCount: generated.length })
    const generatedDir = path.join(incremental, generated[0])
    const incrementalSql = await Bun.file(path.join(generatedDir, "migration.sql")).text()
    console.log(`Regeneration incremental SQL for ${targetID}:\n${incrementalSql}`)
    await fs.mkdir(full)
    await drizzle(temporary, full, "schema")
    const fullSql = await generatedSql(full)
    const nextSnapshot = await Bun.file(path.join(generatedDir, "snapshot.json")).json()
    const rendered = renderMigration(targetID, incrementalSql, nextSnapshot, fullSql, previous)
    if (/tx\.run\(`\s*DROP\s+TABLE\b/i.test(rendered)) {
      throw new Error("Regeneration contains a table drop; review the incremental SQL before proceeding")
    }
    const migrationOutput = await formatTypescript(rendered)
    const schemaOutput = await formatTypescript(renderSchema(fullSql))
    const registryOutput = await formatTypescript(renderRegistry(migrations))
    validateRegeneration({ ...input, generatedCount: generated.length, generatedSql: incrementalSql })
    await Bun.write(target, migrationOutput)
    await fs.copyFile(path.join(generatedDir, "snapshot.json"), snapshot)
    await Bun.write(schema, schemaOutput)
    await Bun.write(registry, registryOutput)
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
}

async function reset() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-core-migration-reset-"))
  const full = path.join(temporary, "full")
  try {
    await fs.mkdir(full)
    await drizzle(temporary, full, "schema")
    const generated = await generatedMigrations(full)
    if (generated.length !== 1) throw new Error(`Expected one full schema migration, found ${generated.length}.`)
    await fs.copyFile(path.join(full, generated[0]!, "snapshot.json"), snapshot)
    await Bun.write(schema, await formatTypescript(renderSchema(await generatedSql(full))))
    await Bun.write(registry, await formatTypescript(renderRegistry([])))
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
}

async function generate() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-core-migration-"))
  const incremental = path.join(temporary, "incremental")
  const full = path.join(temporary, "full")
  try {
    await fs.mkdir(incremental)
    await fs.mkdir(path.join(incremental, "baseline"))
    await fs.copyFile(snapshot, path.join(incremental, "baseline/snapshot.json"))
    const baseline = await Bun.file(snapshot).json()
    await drizzle(temporary, incremental, args.values.name)

    const generated = await generatedMigrations(incremental)
    if (generated.length > 1) throw new Error(`Expected one generated migration, found ${generated.length}.`)
    await fs.mkdir(full)
    await drizzle(temporary, full, "schema")
    const fullSql = await generatedSql(full)
    const name = generated[0]
    if (name) {
      const target = path.join(tsDir, `${name}.ts`)
      if (await Bun.file(target).exists()) throw new Error(`Database migration already exists: ${name}`)
      await Bun.write(
        target,
        await formatTypescript(
          renderMigration(
            name,
            await Bun.file(path.join(incremental, name, "migration.sql")).text(),
            await Bun.file(path.join(incremental, name, "snapshot.json")).json(),
            fullSql,
            baseline,
          ),
        ),
      )
      await fs.copyFile(path.join(incremental, name, "snapshot.json"), snapshot)
    }

    await Bun.write(schema, await formatTypescript(renderSchema(fullSql)))
    await Bun.write(registry, await formatTypescript(renderRegistry(await typescriptMigrations())))
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
}

async function check() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-core-migration-check-"))
  const incremental = path.join(temporary, "incremental")
  const full = path.join(temporary, "full")
  try {
    await fs.mkdir(incremental)
    await fs.mkdir(path.join(incremental, "baseline"))
    await fs.copyFile(snapshot, path.join(incremental, "baseline/snapshot.json"))
    await drizzle(temporary, incremental)
    if ((await generatedMigrations(incremental)).length > 0) {
      throw new Error(
        "Core schema has ungenerated database migrations. Run `bun script/migration.ts` from packages/core.",
      )
    }

    await fs.mkdir(full)
    await drizzle(temporary, full, "schema")
    if ((await Bun.file(schema).text()) !== (await formatTypescript(renderSchema(await generatedSql(full))))) {
      throw new Error("Current database schema is stale. Run `bun script/migration.ts` from packages/core.")
    }

    const migrations = await typescriptMigrations()
    if ((await Bun.file(registry).text()) !== (await formatTypescript(renderRegistry(migrations)))) {
      throw new Error("Database migration registry is stale. Run `bun script/migration.ts` from packages/core.")
    }
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
}

async function drizzle(temporary: string, output: string, name?: string) {
  const config = path.join(temporary, `${path.basename(output)}.config.ts`)
  await Bun.write(
    config,
    `import config from ${JSON.stringify(pathToFileURL(path.join(root, "packages/core/drizzle.config.ts")).href)}

export default { ...config, out: ${JSON.stringify(output)} }
`,
  )
  await $`bun drizzle-kit generate --config ${config} ${name ? ["--name", name] : []}`.cwd(
    path.join(root, "packages/core"),
  )
}

async function generatedMigrations(directory: string) {
  return (await Array.fromAsync(new Bun.Glob("*/migration.sql").scan({ cwd: directory })))
    .map((file) => file.split("/")[0])
    .filter((name): name is string => name !== undefined)
    .sort()
}

async function generatedSql(directory: string) {
  const generated = await generatedMigrations(directory)
  if (generated.length !== 1) throw new Error(`Expected one full schema migration, found ${generated.length}.`)
  return Bun.file(path.join(directory, generated[0]!, "migration.sql")).text()
}

async function typescriptMigrations() {
  await fs.mkdir(tsDir, { recursive: true })
  return (await Array.fromAsync(new Bun.Glob("*.ts").scan({ cwd: tsDir })))
    .map((file) => path.basename(file, ".ts"))
    .sort()
}

type Entry = { readonly [key: string]: unknown }

function isEntry(value: unknown): value is Entry {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

interface Rebuild {
  parts: string[]
  table: string
  previous: unknown
  next: unknown
  full: string[]
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (!isEntry(value)) return JSON.stringify(value)
  const fields = Object.entries(value).sort(([left], [right]) => byName(left, right))
  const items = fields.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
  return `{${items.join(",")}}`
}

function tableEntries(snapshot: unknown, table: string) {
  const entries = new Map<string, Entry>()
  const ddl = Schema.decodeUnknownSync(Schema.Struct({ ddl: Schema.Array(Schema.Unknown) }))(snapshot).ddl
  for (const value of ddl) {
    if (!isEntry(value)) continue
    if (value.table !== table && !(value.entityType === "tables" && value.name === table)) continue
    const key = JSON.stringify([value.entityType, value.name])
    if (typeof value.entityType !== "string" || typeof value.name !== "string" || entries.has(key)) {
      throw review(table)
    }
    entries.set(key, value)
  }
  return entries
}

function namesOf(entries: Entry[], entityType: string) {
  return entries.filter((entry) => entry.entityType === entityType).map((entry) => String(entry.name))
}

function indexName(statement: string) {
  return /^CREATE (?:UNIQUE )?INDEX `([^`]+)`/.exec(statement)?.[1] ?? ""
}

function isIndexOn(statement: string, table: string) {
  return /^CREATE (?:UNIQUE )?INDEX\b/.test(statement) && statement.includes(` ON \`${table}\` (`)
}

function columnList(list: string) {
  return list.split(", ").map((item) => /^`([^`]+)`$/.exec(item)?.[1] ?? "")
}

function copiesColumns(statement: string, table: string, columns: string[]) {
  const prefix = `INSERT INTO \`__new_${table}\`(`
  const suffix = ` FROM \`${table}\`;`
  if (!statement.startsWith(prefix) || !statement.endsWith(suffix)) return false
  const lists = statement.slice(prefix.length, -suffix.length).split(") SELECT ")
  if (lists.length !== 2) return false
  const target = columnList(lists[0])
  const source = columnList(lists[1])
  if (target.includes("") || target.join(",") !== source.join(",")) return false
  return [...target].sort(byName).join(",") === [...columns].sort(byName).join(",")
}

function rewriteCheckRebuilds(parts: string[], snapshot: unknown, full: string[], previous?: unknown) {
  if (previous === undefined) return parts
  const tables = parts.flatMap((statement) => {
    const match = /^CREATE TABLE `__new_([^`]+)` \(/.exec(statement)
    return match ? [match[1]] : []
  })
  let current = parts
  for (const table of tables) {
    current = rewriteCheckRebuild({ parts: current, table, previous, next: snapshot, full })
  }
  return current
}

function rewriteCheckRebuild({ parts, table, previous, next, full }: Rebuild) {
  const before = tableEntries(previous, table)
  const after = tableEntries(next, table)
  const added = [...after].filter(([key]) => !before.has(key))
  if (!added.some(([, entry]) => entry.entityType === "checks")) return parts

  const changed = [...before].some(([key, entry]) => canonicalJson(after.get(key)) !== canonicalJson(entry))
  const columns = added.filter(([, entry]) => entry.entityType === "columns")
  const checks = added.filter(([, entry]) => entry.entityType === "checks")
  if (changed || added.length !== 2 || columns.length !== 1 || checks.length !== 1) throw review(table)
  const columnName = columns[0][1].name
  const checkName = checks[0][1].name
  const checkValue = checks[0][1].value
  if (typeof columnName !== "string" || typeof checkName !== "string" || typeof checkValue !== "string") {
    throw review(table)
  }

  const canonical = full.find((statement) => statement.startsWith(`CREATE TABLE \`${table}\` (`))
  if (canonical === undefined) throw review(table)
  const prefix = `"${columnName}" IN (`
  const literal = "'(?:[^']|'')*'"
  const literals = new RegExp(`^${literal}(?:, ${literal})*$`)
  const inner = checkValue.slice(prefix.length, -1)
  const quoted = checkValue.startsWith(prefix) && checkValue.endsWith(")") && literals.test(inner)
  if (!quoted || !canonical.includes(`CONSTRAINT "${checkName}" CHECK(${checkValue})`)) throw review(table)

  const lines = canonical.split("\n").map((line) => line.trim())
  const definitions = lines.filter((line) => line.startsWith(`\`${columnName}\` `))
  if (definitions.length !== 1) throw review(table)
  const add = `ALTER TABLE \`${table}\` ADD ${definitions[0].replace(/,$/, "")};`
  const create = canonical.replace(`CREATE TABLE \`${table}\``, `CREATE TABLE \`__new_${table}\``)
  const drop = `DROP TABLE \`${table}\`;`
  const rename = `ALTER TABLE \`__new_${table}\` RENAME TO \`${table}\`;`
  const expected = [add, pragmaOff, create, parts[3], drop, rename, pragmaOn]
  if (JSON.stringify(parts.slice(0, expected.length)) !== JSON.stringify(expected)) throw review(table)

  const entries = [...before.values()]
  if (!copiesColumns(parts[3], table, namesOf(entries, "columns"))) throw review(table)
  const recreated = parts.slice(expected.length)
  const preexisting = namesOf(entries, "indexes")
  const indexes = full.filter((statement) => isIndexOn(statement, table))
  if (recreated.length !== indexes.length || new Set(recreated).size !== recreated.length) throw review(table)
  if (!recreated.every((statement) => indexes.includes(statement))) throw review(table)
  if (!indexes.every((statement) => preexisting.includes(indexName(statement)))) throw review(table)
  return [`${add.slice(0, -1)} CONSTRAINT \`${checkName}\` CHECK (${checkValue});`]
}

function withActions(statement: string, full: string[]) {
  const added = /^ALTER TABLE `([^`]+)` ADD `([^`]+)` (.+);$/is.exec(statement)
  if (!added || !/\bREFERENCES\b/i.test(added[3])) return statement

  const [, table, column] = added
  const definition = full.find((item) => item.startsWith(`CREATE TABLE \`${table}\` (`))
  const matches = [...(definition ?? "").matchAll(canonicalKey)].filter((item) => item[1] === column)
  const reference = inlineReference.exec(statement)
  const match = matches[0]
  if (matches.length !== 1 || !reference || match[2] !== reference[1] || match[3] !== reference[2]) {
    throw new Error(`Missing canonical foreign-key metadata for ${table}.${column}`)
  }
  const missing = (match[4].match(actionClauses) ?? []).filter((clause) => {
    const [, kind] = /^ON\s+(DELETE|UPDATE)/i.exec(clause) ?? []
    return !new RegExp(`\\bON\\s+${kind}\\b`, "i").test(reference[3])
  })
  return statement.replace(reference[0], reference[0] + (missing.length ? ` ${missing.join(" ")}` : ""))
}

export function renderMigration(
  name: string,
  sql: string,
  snapshot: unknown,
  fullSql: string,
  previousSnapshot?: unknown,
) {
  const parts = sql.split("--> statement-breakpoint").map((statement) => statement.trim()).filter(Boolean)
  const full = fullSql.split("--> statement-breakpoint").map((statement) => statement.trim()).filter(Boolean)
  Schema.decodeUnknownSync(Schema.Struct({ ddl: Schema.Array(Schema.Unknown) }))(snapshot)
  const rebuilt = rewriteCheckRebuilds(parts, snapshot, full, previousSnapshot)
  const statements = rebuilt.map((statement) => withActions(statement, full)).join("--> statement-breakpoint")
  return `import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: ${JSON.stringify(name)},
  up(tx) {
    return Effect.gen(function* () {
${renderStatements(statements)}
    })
  },
} satisfies DatabaseMigration.Migration
`
}

function renderSchema(sql: string) {
  return `import { Effect } from "effect"
import type { DatabaseMigration } from "./migration"

export default {
  up(tx) {
    return Effect.gen(function* () {
${renderStatements(sql)}
    })
  },
} satisfies Omit<DatabaseMigration.Migration, "id">
`
}

function renderStatements(sql: string) {
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .map(renderRun)
    .join("\n")
}

function renderRun(statement: string) {
  const lines = statement.replaceAll("\t", "  ").split("\n")
  if (lines.length === 1) return `      yield* tx.run(\`${escapeTemplate(lines[0])}\`)`
  return `      yield* tx.run(\`\n${lines.map((line) => `        ${escapeTemplate(line)}`).join("\n")}\n      \`)`
}

function escapeTemplate(line: string) {
  return line.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${")
}

async function formatTypescript(input: string) {
  const prettier = await import("prettier")
  const typescript = await import("prettier/plugins/typescript")
  const estree = await import("prettier/plugins/estree")
  return prettier.format(input, {
    parser: "typescript",
    plugins: [typescript.default, estree.default],
    semi: false,
    printWidth: 120,
  })
}

function renderRegistry(names: string[]) {
  if (names.length === 0)
    return `import type { DatabaseMigration } from "./migration"

export const migrations: DatabaseMigration.Migration[] = []
`
  return `import type { DatabaseMigration } from "./migration"

export const migrations = (
  await Promise.all([
${names.map((name) => `    import("./migration/${name}"),`).join("\n")}
  ])
).map((module) => module.default) satisfies DatabaseMigration.Migration[]
`
}
