export * as DatabaseRecovery from "./database-recovery"

import { Database } from "@ycoding-ai/core/database/database"
import { DatabaseFormat } from "@ycoding-ai/core/database/format"
import fs from "node:fs/promises"
import path from "node:path"

export async function backupUnsupported(filename = Database.filename()) {
  if (filename === ":memory:" || !(await Bun.file(filename).exists())) return
  const sqlite = await import("bun:sqlite")
  const db = new sqlite.Database(filename, { readonly: true, create: false })
  try {
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
    if (!tables.length) return
    if (tables.some((table) => table.name === "database_format")) {
      const format = db.query("SELECT id FROM database_format LIMIT 1").get() as { id: string } | null
      if (format?.id === DatabaseFormat.CurrentID) return
    }
  } finally {
    db.close()
  }

  const name = path.basename(filename)
  const backup = path.join(
    path.dirname(filename),
    "unsupported",
    `${name}-${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}-${process.pid}`,
  )
  await fs.mkdir(backup, { recursive: true })
  if (!(await move(filename, path.join(backup, name)))) {
    await fs.rm(backup, { recursive: true, force: true })
    return
  }
  await Promise.all(
    ["-wal", "-shm"].map((suffix) => move(filename + suffix, path.join(backup, name + suffix))),
  )
  await fs.writeFile(
    path.join(backup, "RECOVERY.txt"),
    [
      "YCoding backed up this unsupported pre-current database instead of migrating it.",
      `Original path: ${filename}`,
      `Required format: ${DatabaseFormat.CurrentID}`,
      `Created: ${new Date().toISOString()}`,
      "The current application started with a fresh database.",
      "",
    ].join("\n"),
    { mode: 0o600 },
  )
  return backup
}

function move(source: string, target: string) {
  return fs.rename(source, target).then(
    () => true,
    (error) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false
      throw error
    },
  )
}
