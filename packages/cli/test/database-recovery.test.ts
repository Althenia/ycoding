import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { pathToFileURL } from "node:url"
import { DatabaseFormat } from "@ycoding-ai/core/database/format"
import { backupUnsupported } from "../src/services/database-recovery"

test("recovery leaves memory, absent files and directories untouched", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-recovery-"))
  try {
    expect(await backupUnsupported(":memory:")).toBeUndefined()
    expect(await backupUnsupported(path.join(root, "missing.db"))).toBeUndefined()
    expect(await backupUnsupported(root)).toBeUndefined()
    expect(await fs.readdir(root)).toEqual([])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

for (const format of ["empty", "current", "obsolete", "missing-format-row"] as const) {
  test(`recovery ${format === "empty" || format === "current" ? "preserves" : "backs up"} the ${format} database`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-recovery-"))
    const filename = path.join(root, "fixture.db")
    try {
      const seed = new DatabaseSync(filename)
      if (format !== "empty") {
        seed.exec("CREATE TABLE database_format (id TEXT NOT NULL)")
        if (format !== "missing-format-row")
          seed
            .prepare("INSERT INTO database_format VALUES (?)")
            .run(format === "current" ? DatabaseFormat.CurrentID : "synthetic-old-format")
      }
      seed.close()
      const before = await fs.readFile(filename)
      const backup = await backupUnsupported(filename)
      if (format === "empty" || format === "current") {
        expect(backup).toBeUndefined()
        expect(await fs.readFile(filename)).toEqual(before)
        expect(await fs.readdir(root)).toEqual(["fixture.db"])
        return
      }
      expect(backup).toBeString()
      if (!backup) throw new Error("Unsupported database was not backed up")
      expect(await fs.readFile(path.join(backup, "fixture.db"))).toEqual(before)
      expect(await fs.readFile(path.join(backup, "RECOVERY.txt"), "utf8")).toContain(DatabaseFormat.CurrentID)
      expect((await fs.stat(path.join(backup, "RECOVERY.txt"))).mode & 0o777).toBe(0o600)
      await assert.rejects(fs.stat(filename), { code: "ENOENT" })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
}

test("recovery preserves unsupported rows and their recovered WAL and shared-memory files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-recovery-wal-"))
  const filename = path.join(root, "fixture.db")
  try {
    const source = path.join(root, "source.db")
    const seed = new DatabaseSync(source)
    try {
      seed.exec(
        "PRAGMA journal_mode = WAL; CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('preserved')",
      )
      for (const suffix of ["", "-wal", "-shm"]) await fs.copyFile(source + suffix, filename + suffix)
    } finally {
      seed.close()
    }
    const backup = await backupUnsupported(filename)
    expect(backup).toBeString()
    if (!backup) throw new Error("Unsupported database was not backed up")
    for (const suffix of ["", "-wal", "-shm"]) {
      expect((await fs.stat(path.join(backup, "fixture.db" + suffix))).isFile()).toBe(true)
      await assert.rejects(fs.stat(filename + suffix), { code: "ENOENT" })
    }
    const preserved = new DatabaseSync(path.join(backup, "fixture.db"), { readOnly: true })
    try {
      expect(preserved.prepare("SELECT value FROM sentinel").get()?.value).toBe("preserved")
    } finally {
      preserved.close()
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("recovery propagates filesystem and malformed-database errors without moving data", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-recovery-error-"))
  const filename = path.join(root, "invalid.db")
  try {
    await fs.writeFile(filename, "synthetic invalid SQLite data")
    await assert.rejects(backupUnsupported(path.join(filename, "child.db")), { code: "ENOTDIR" })
    await assert.rejects(backupUnsupported(filename))
    expect(await fs.readFile(filename, "utf8")).toBe("synthetic invalid SQLite data")
    expect(await fs.readdir(root)).toEqual(["invalid.db"])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("the Bun recovery connection rejects writes and never creates an absent database", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-recovery-reader-"))
  const filename = path.join(root, "fixture.db")
  try {
    const seed = new DatabaseSync(filename)
    seed.exec("CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('preserved')")
    seed.close()
    const sqlite = await import("#database-recovery-sqlite")
    const reader = sqlite.open(filename)
    try {
      expect(() => reader.query("DELETE FROM sentinel").all()).toThrow()
      expect(reader.query("SELECT value FROM sentinel").get()).toEqual({ value: "preserved" })
    } finally {
      reader.close()
    }
    expect(() => sqlite.open(path.join(root, "missing.db"))).toThrow()
    expect(await fs.readdir(root)).toEqual(["fixture.db"])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("the actual Node 26.4 recovery connection is read-only and cannot create a missing database", async () => {
  if (!process.env.NODE_BIN) throw new Error("NODE_BIN must identify the installed Node 26.4.0 runtime")
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-node-recovery-reader-"))
  const filename = path.join(root, "fixture.db")
  try {
    const seed = new DatabaseSync(filename)
    seed.exec("CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('preserved')")
    seed.close()
    const module = pathToFileURL(path.join(import.meta.dir, "../src/services/database-recovery-sqlite.node.ts")).href
    const result = spawnSync(
      process.env.NODE_BIN,
      [
        "--input-type=module",
        "-e",
        `
      import assert from "node:assert/strict"
      import { open } from ${JSON.stringify(module)}
      assert.equal(process.versions.node, "26.4.0")
      assert.equal(typeof globalThis.Bun, "undefined")
      const reader = open(${JSON.stringify(filename)})
      try {
        assert.throws(() => reader.query("DELETE FROM sentinel").all(), /readonly/)
        assert.equal(reader.query("SELECT value FROM sentinel").get().value, "preserved")
      } finally { reader.close() }
      assert.throws(() => open(${JSON.stringify(path.join(root, "missing.db"))}))
    `,
      ],
      { encoding: "utf8", timeout: 10_000 },
    )
    expect(result.error).toBeUndefined()
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(await fs.readdir(root)).toEqual(["fixture.db"])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
