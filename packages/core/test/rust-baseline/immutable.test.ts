import { Database } from "bun:sqlite"
import { afterAll, expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { exportDatabase, fingerprint } from "../../../../script/rust-parity/export"
import { immutableQuery, openImmutableDatabase } from "../../../../script/rust-parity/immutable"

const allocated: string[] = []
afterAll(async () => {
  await Promise.all(allocated.map((root) => rm(root, { recursive: true, force: true })))
})

test("immutable baseline export preserves SQLite values and frozen WAL files through escaped URI paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ycoding-immutable-"))
  allocated.push(root)
  const file = path.join(root, "baseline # % é.sqlite")
  const writer = new Database(file, { create: true, strict: true, safeIntegers: true })
  try {
    writer.run("PRAGMA journal_mode = WAL")
    writer.run(
      'CREATE TABLE "quoted"" table" (minimum INTEGER, maximum INTEGER, unsafe INTEGER, small INTEGER, real REAL, absent TEXT, text TEXT, bytes BLOB)',
    )
    writer
      .query('INSERT INTO "quoted"" table" VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        -9223372036854775808n,
        9223372036854775807n,
        9007199254740993n,
        7n,
        1.25,
        null,
        "é 🧪",
        new Uint8Array([0, 255, 128]),
      )
    writer.run("PRAGMA wal_checkpoint(TRUNCATE)")
    // Leave the settled writer open so existing WAL/SHM bytes must also survive.
    const files = (await readdir(root)).sort()
    expect(files).toContain(`${path.basename(file)}-wal`)
    expect(Bun.file(`${file}-wal`).size).toBe(0)
    const hashes = await Promise.all(files.map((name) => fingerprint(path.join(root, name))))
    expect(exportDatabase(file)).toEqual({
      'quoted" table': [
        {
          minimum: { sqliteInteger: "-9223372036854775808" },
          maximum: { sqliteInteger: "9223372036854775807" },
          unsafe: { sqliteInteger: "9007199254740993" },
          small: { sqliteInteger: "7" },
          real: 1.25,
          absent: null,
          text: "é 🧪",
          bytes: { sqliteBlob: "AP+A" },
        },
      ],
    })
    expect((await readdir(root)).sort()).toEqual(files)
    expect(await Promise.all(files.map((name) => fingerprint(path.join(root, name))))).toEqual(hashes)
  } finally {
    writer.close()
  }
})

test("immutable baseline queries reject writes and every unbound parameter", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ycoding-immutable-"))
  allocated.push(root)
  const file = path.join(root, "baseline.sqlite")
  const writer = new Database(file, { create: true })
  writer.run("CREATE TABLE example (value INTEGER)")
  writer.close()
  const before = await fingerprint(file)
  const reader = openImmutableDatabase(file)
  try {
    expect(() => reader.run("INSERT INTO example VALUES (1)")).toThrow("readonly")
    for (const placeholder of ["?", "?1", "$missing", ":missing", "@missing"])
      expect(() => immutableQuery(reader, `SELECT ${placeholder}`)).toThrow("must not contain parameters")
    expect(immutableQuery<{ count: bigint }>(reader, "SELECT count(*) AS count FROM example").get()).toEqual({
      count: 0n,
    })
  } finally {
    reader.close()
  }
  expect(await fingerprint(file)).toBe(before)
  expect(await readdir(root)).toEqual([path.basename(file)])
  expect(() => openImmutableDatabase(path.join(root, "missing.sqlite"))).toThrow()
  expect(await readdir(root)).toEqual([path.basename(file)])
})
