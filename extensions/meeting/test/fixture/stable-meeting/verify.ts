import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, readdirSync, rmSync, copyFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"

function inspect(directory: string) {
  const scratch = mkdtempSync(path.join(tmpdir(), "meeting-baseline-"))
  try {
    const files = Object.fromEntries(
      readdirSync(directory)
        .sort()
        .map((name) => {
          const bytes = readFileSync(path.join(directory, name))
          copyFileSync(path.join(directory, name), path.join(scratch, name))
          return [name, { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }]
        }),
    )
    const db = new Database(path.join(scratch, "meetings.sqlite"), { strict: true })
    try {
      db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON")
      const schema = db
        .query<
          { type: string; name: string; tbl_name: string; sql: string | null },
          []
        >("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name")
        .all()
      const rows = Object.fromEntries(
        schema
          .filter((entry) => entry.type === "table")
          .map((entry) => [entry.name, db.query(`SELECT rowid,* FROM "${entry.name}" ORDER BY rowid`).all()]),
      )
      assert.equal(Object.keys(rows).length, 9)
      assert.ok(Object.values(rows).every((entries) => entries.length === 1))
      const pragmas = Object.fromEntries(
        [
          "user_version",
          "application_id",
          "schema_version",
          "encoding",
          "page_size",
          "page_count",
          "freelist_count",
          "auto_vacuum",
          "journal_mode",
          "foreign_keys",
          "busy_timeout",
          "synchronous",
          "secure_delete",
          "integrity_check",
          "foreign_key_check",
        ].map((name) => [name, db.query(`PRAGMA ${name}`).all()]),
      )
      assert.deepEqual(pragmas.user_version, [{ user_version: 1 }])
      assert.deepEqual(pragmas.journal_mode, [{ journal_mode: "wal" }])
      assert.deepEqual(pragmas.integrity_check, [{ integrity_check: "ok" }])
      assert.deepEqual(pragmas.foreign_key_check, [])
      return { files, schema, rows, pragmas }
    } finally {
      db.close()
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

const checkpointed = inspect(path.join(import.meta.dir, "checkpointed"))
const wal = inspect(path.join(import.meta.dir, "wal"))
assert.deepEqual(checkpointed.schema, wal.schema)
assert.deepEqual(checkpointed.rows, wal.rows)
assert.deepEqual(checkpointed.pragmas, wal.pragmas)
assert.ok(wal.files["meetings.sqlite-wal"].bytes > 0)
assert.ok(wal.files["meetings.sqlite-shm"].bytes > 0)
const actual = {
  files: { checkpointed: checkpointed.files, wal: wal.files },
  schema: checkpointed.schema,
  rows: checkpointed.rows,
  pragmas: checkpointed.pragmas,
}
if (process.argv[2]) {
  for (const state of ["checkpointed", "wal"]) {
    for (const name of readdirSync(path.join(import.meta.dir, state))) {
      assert.deepEqual(
        readFileSync(path.join(import.meta.dir, state, name)),
        readFileSync(path.join(process.argv[2], state, name)),
      )
    }
  }
  assert.deepEqual(checkpointed, inspect(path.join(process.argv[2], "checkpointed")))
  assert.deepEqual(wal, inspect(path.join(process.argv[2], "wal")))
}
assert.deepEqual(actual, await Bun.file(path.join(import.meta.dir, "snapshot.json")).json())
process.stdout.write("Stable Meeting baseline: bytes, schema, nine-table rows, pragmas and integrity match\n")
