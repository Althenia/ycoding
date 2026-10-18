import { createHash } from "node:crypto"
import path from "node:path"
import { generateManifest, reconcileMembers } from "./manifest"
import { coverageReport, type Tables } from "./coverage"
import { immutableQuery, openImmutableDatabase } from "./immutable"

export const normalization = {
  version: 1,
  tables:
    "Sort table names and column keys by JavaScript UTF-16 code-unit order; sort rows by their canonical JSON encoding. Preserve every row, SQL null, number and text value.",
  text: "Keep SQLite TEXT (including JSON TEXT) verbatim. JSON.stringify escapes lone UTF-16 units in export values and keys; JSON.parse of JSON TEXT reconstructs logical documents without Unicode normalization.",
  integers: "Use SQLite safeIntegers; encode bigint cells as {sqliteInteger: decimal-string} to avoid precision loss.",
  blobs: "Encode BLOB cells as {sqliteBlob: base64-string}; never coerce to text.",
  identity:
    "Do not normalize IDs, timestamps, paths, revisions, ordering sequences or content hashes. A frozen fixture is the oracle; two independent producers need not have equal bytes.",
} as const

export function canonical(value: unknown): unknown {
  if (typeof value === "bigint") return { sqliteInteger: value.toString() }
  if (value instanceof Uint8Array) return { sqliteBlob: Buffer.from(value).toString("base64") }
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, canonical(child)]),
    )
  return value
}

export function exportDatabase(file: string): Tables {
  const db = openImmutableDatabase(file)
  try {
    const names = immutableQuery<{ name: string }>(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
      .all()
      .map((row) => row.name)
    return Object.fromEntries(
      names.map((name) => {
        const rows = immutableQuery<Record<string, unknown>>(db, `SELECT * FROM "${name.replaceAll('"', '""')}"`)
          .all()
          .map(canonical)
        return [
          name,
          rows.sort((left, right) =>
            JSON.stringify(left) < JSON.stringify(right) ? -1 : JSON.stringify(left) > JSON.stringify(right) ? 1 : 0,
          ),
        ]
      }),
    )
  } finally {
    db.close()
  }
}

export async function fingerprint(file: string) {
  return createHash("sha256")
    .update(await Bun.file(file).bytes())
    .digest("hex")
}

export async function sourceFingerprint(repository: string) {
  const files: { file: string; sha256: string }[] = []
  for (const directory of [
    "packages/core/src",
    "packages/schema/src",
    "packages/core/test/rust-baseline",
    "extensions/meeting/test/fixture/stable-meeting",
  ])
    for await (const file of new Bun.Glob("**/*").scan({
      cwd: path.join(repository, directory),
      onlyFiles: true,
      dot: true,
    }))
      files.push({ file: `${directory}/${file}`, sha256: await fingerprint(path.join(repository, directory, file)) })
  files.sort((left, right) => (left.file < right.file ? -1 : 1))
  return { sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"), files }
}

export async function sourceRevision(repository: string) {
  const process = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: repository, stdout: "pipe", stderr: "pipe" })
  const [revision, error, exit] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exit !== 0 || !/^[0-9a-f]{40}\n$/.test(revision))
    throw new Error(`Cannot record baseline source revision: ${error}`)
  return revision.trim()
}

export async function verifyCopy(root: string, files: readonly { file: string; sha256: string; bytes: number }[]) {
  const names = files.map((entry) => entry.file)
  reconcileMembers(names, [...new Set(names)], "copy files")
  for (const file of files) {
    if (
      !file.file ||
      path.isAbsolute(file.file) ||
      file.file.split(/[\\/]/).some((part) => !part || part === "." || part === "..")
    )
      throw new Error("Invalid copied-file path")
    const copied = Bun.file(path.join(root, file.file))
    if (
      !(await copied.exists()) ||
      copied.size !== file.bytes ||
      (await fingerprint(path.join(root, file.file))) !== file.sha256
    )
      throw new Error(`Copy integrity mismatch: ${file.file}`)
  }
}

export async function freezeBaseline(root: string) {
  const repository = path.resolve(import.meta.dir, "../..")
  const core = exportDatabase(path.join(root, "data/core.sqlite"))
  const meeting = exportDatabase(path.join(root, "meeting/meetings.sqlite"))
  const catalog = await Bun.file(path.join(repository, "specs/baseline-storage-catalog.md")).text()
  const rows = catalog
    .split("\n")
    .filter((line) => line.startsWith("| "))
    .map((line) => line.split("|").slice(1, -1))
  const names = (cell: string) => [...cell.matchAll(/`([a-z_]+)`/g)].map((match) => match[1])
  const expectedCore = rows.filter((row) => !row[0].includes("Meeting")).flatMap((row) => names(row[1]))
  const expectedMeeting = rows.filter((row) => row[0].includes("Meeting")).flatMap((row) => names(row[1]))
  reconcileMembers(Object.keys(core), expectedCore, "core tables")
  reconcileMembers(Object.keys(meeting), expectedMeeting, "Meeting tables")
  if (expectedCore.length !== 49 || expectedMeeting.length !== 9)
    throw new Error("Storage catalog counts disagree with baseline")
  for (const file of ["data/core.sqlite-wal", "meeting/meetings.sqlite-wal"])
    if ((await Bun.file(path.join(root, file)).exists()) && Bun.file(path.join(root, file)).size !== 0)
      throw new Error(`Unsettled WAL: ${file}`)
  await Bun.write(
    path.join(root, "coverage.json"),
    JSON.stringify(await coverageReport(repository, core, meeting), null, 2) + "\n",
  )
  await Bun.write(
    path.join(root, "semantic-export.json"),
    JSON.stringify({ normalization, core, meeting }, null, 2) + "\n",
  )
  await Bun.write(
    path.join(root, "operation-manifest.json"),
    JSON.stringify(await generateManifest(repository), null, 2) + "\n",
  )
  const files = []
  for await (const file of new Bun.Glob("**/*").scan({ cwd: root, onlyFiles: true, dot: true }))
    files.push({ file, sha256: await fingerprint(path.join(root, file)), bytes: Bun.file(path.join(root, file)).size })
  const source = await sourceFingerprint(repository)
  if (
    source.sha256 !== process.env.YCODING_BASELINE_SOURCE_DIGEST ||
    !/^[0-9a-f]{40}$/.test(process.env.YCODING_BASELINE_SOURCE_REVISION ?? "")
  )
    throw new Error("Baseline TS source changed during production or provenance is missing")
  await Bun.write(
    path.join(root, "provenance.json"),
    JSON.stringify(
      {
        fixture: "F-STORE",
        harness: "HARNESS-01",
        sourceRevision: process.env.YCODING_BASELINE_SOURCE_REVISION,
        baselinePlanRevision: "b037a1307386fe295c1bd65c1859f48652cf3c16",
        sourceFingerprint: source,
        command: "bun script/rust-parity/producer.ts",
        platform: process.platform,
        architecture: process.arch,
        bun: Bun.version,
        normalization,
        files: files.sort((left, right) => (left.file < right.file ? -1 : 1)),
        boundary:
          "Real TS Core file stores and projectors. Meeting uses the committed stable schema with direct SQLite Unicode/record fixtures, not a TS Meeting runtime. External provider response is deterministic fixture replay; network is denied. No native capture, browser, actual model, user state or credential discovery.",
      },
      null,
      2,
    ) + "\n",
  )
}
