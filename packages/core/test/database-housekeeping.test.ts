import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { stat } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { layerFromPath, Service } from "@ycoding-ai/core/database/database"
import { tmpdir } from "./fixture/tmpdir"

test("converts and reclaims an existing database while preserving its data across reopen", async () => {
  await using dir = await tmpdir("ycoding-database-housekeeping-")
  const filename = path.join(dir.path, "existing.db")
  await initialize(filename)
  seedExistingDatabase(filename)

  const before = await stat(filename)
  const seeded = open(filename)
  expect(autoVacuum(seeded)).toBe(0)
  expect(freelist(seeded)).toBeGreaterThan(0)
  seeded.close()

  await initialize(filename)

  const after = await stat(filename)
  const reclaimed = open(filename)
  expect(autoVacuum(reclaimed)).toBe(2)
  expect(
    reclaimed
      .query<{ marker: string; bytes: number }, []>("SELECT marker, length(payload) AS bytes FROM housekeeping_fixture")
      .get(),
  ).toEqual({
    marker: "keep",
    bytes: 8_192,
  })
  expect(reclaimed.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check).toBe("ok")
  expect(after.size).toBeLessThan(before.size / 2)
  reclaimed.close()

  const reusable = open(filename)
  reusable.exec(`
    INSERT INTO housekeeping_fixture (marker, payload)
    WITH RECURSIVE counter(value) AS (
      VALUES (1)
      UNION ALL
      SELECT value + 1 FROM counter WHERE value < 64
    )
    SELECT 'discard', randomblob(8192) FROM counter;
    DELETE FROM housekeeping_fixture WHERE marker = 'discard';
  `)
  const reusableFreelist = freelist(reusable)
  expect(reusableFreelist).toBeGreaterThan(0)
  reusable.close()
  const reusableSize = await stat(filename)

  await initialize(filename)
  const reopened = open(filename)
  expect(autoVacuum(reopened)).toBe(2)
  expect(freelist(reopened)).toBeLessThan(reusableFreelist ?? 0)
  expect(reopened.query<{ count: number }, []>("SELECT count(*) AS count FROM housekeeping_fixture").get()?.count).toBe(
    1,
  )
  expect((await stat(filename)).size).toBeLessThan(reusableSize.size)
  reopened.close()
})

test("preserves an existing FULL auto-vacuum database", async () => {
  await using dir = await tmpdir("ycoding-database-housekeeping-full-")
  const filename = path.join(dir.path, "existing.db")
  await initialize(filename)

  const existing = open(filename)
  existing.exec(`
    PRAGMA auto_vacuum = FULL;
    CREATE TABLE full_vacuum_fixture (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO full_vacuum_fixture (value) VALUES ('preserved');
  `)
  expect(autoVacuum(existing)).toBe(1)
  existing.close()

  await initialize(filename)
  const reopened = open(filename)
  expect(autoVacuum(reopened)).toBe(1)
  expect(reopened.query<{ value: string }, []>("SELECT value FROM full_vacuum_fixture").get()?.value).toBe("preserved")
  expect(reopened.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check).toBe("ok")
  reopened.close()
})

test("initializes a fresh database with incremental auto-vacuum and preserves new data across reopen", async () => {
  await using dir = await tmpdir("ycoding-database-housekeeping-fresh-")
  const filename = path.join(dir.path, "fresh.db")

  await initialize(filename)
  const initialized = open(filename)
  expect(autoVacuum(initialized)).toBe(2)
  initialized.exec(`
    CREATE TABLE fresh_vacuum_fixture (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO fresh_vacuum_fixture (value) VALUES ('roundtrip');
  `)
  initialized.close()

  await initialize(filename)
  const reopened = open(filename)
  expect(autoVacuum(reopened)).toBe(2)
  expect(reopened.query<{ value: string }, []>("SELECT value FROM fresh_vacuum_fixture").get()?.value).toBe("roundtrip")
  expect(reopened.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check).toBe("ok")
  reopened.close()
})

test("a failed conversion preserves existing rows and remains retryable", async () => {
  await using dir = await tmpdir("ycoding-database-housekeeping-failure-")
  const filename = path.join(dir.path, "existing.db")
  await initialize(filename)
  seedExistingDatabase(filename)

  const locked = open(filename)
  locked.exec("PRAGMA journal_mode = WAL; BEGIN IMMEDIATE; UPDATE housekeeping_fixture SET marker = 'uncommitted'")
  const exit = await Effect.runPromiseExit(openLayer(filename))
  expect(exit._tag).toBe("Failure")
  locked.exec("ROLLBACK")
  locked.close()

  const unchanged = open(filename)
  expect(autoVacuum(unchanged)).toBe(0)
  expect(unchanged.query<{ marker: string }, []>("SELECT marker FROM housekeeping_fixture").get()?.marker).toBe("keep")
  expect(unchanged.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check).toBe("ok")
  unchanged.close()

  await initialize(filename)
  const retried = open(filename)
  expect(autoVacuum(retried)).toBe(2)
  expect(retried.query<{ marker: string }, []>("SELECT marker FROM housekeeping_fixture").get()?.marker).toBe("keep")
  retried.close()
}, 10_000)

function initialize(filename: string) {
  return Effect.runPromise(openLayer(filename))
}

function openLayer(filename: string) {
  return Service.pipe(Effect.provide(layerFromPath(filename)), Effect.scoped)
}

function seedExistingDatabase(filename: string) {
  const database = open(filename)
  try {
    database.exec(`
      PRAGMA wal_checkpoint(TRUNCATE);
      PRAGMA journal_mode = DELETE;
      PRAGMA auto_vacuum = NONE;
      VACUUM;
      CREATE TABLE housekeeping_fixture (id INTEGER PRIMARY KEY, marker TEXT NOT NULL, payload BLOB NOT NULL);
      INSERT INTO housekeeping_fixture (marker, payload)
      WITH RECURSIVE counter(value) AS (
        VALUES (1)
        UNION ALL
        SELECT value + 1 FROM counter WHERE value < 512
      )
      SELECT CASE value WHEN 1 THEN 'keep' ELSE 'discard' END, randomblob(8192) FROM counter;
      DELETE FROM housekeeping_fixture WHERE marker = 'discard';
    `)
  } finally {
    database.close()
  }
}

function open(filename: string) {
  return new Database(filename)
}

function autoVacuum(database: Database) {
  return database.query<{ auto_vacuum: number }, []>("PRAGMA auto_vacuum").get()?.auto_vacuum
}

function freelist(database: Database) {
  return database.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get()?.freelist_count
}
