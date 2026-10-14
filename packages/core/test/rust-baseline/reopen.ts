import { lstat, readdir, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const root = process.argv[2]
if (
  !root ||
  process.argv.length !== 3 ||
  path.dirname(root) !== (await realpath(tmpdir())) ||
  !/^ycoding-rust-baseline-[A-Za-z0-9]+$/.test(path.basename(root)) ||
  !(await lstat(root)).isDirectory() ||
  (await realpath(root)) !== root ||
  (await readdir(root)).sort().join(",") !== "core.sqlite,meetings.sqlite"
)
  throw new Error("Refusing non-isolated reopen root")
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.XDG_STATE_HOME = path.join(root, "state")
process.env.XDG_CACHE_HOME = path.join(root, "cache")
process.env.YCODING_TEST_HOME = path.join(root, "home")
process.env.TMPDIR = root
const { Effect } = await import("effect")
const { Database } = await import("@ycoding-ai/core/database/database")
await Effect.runPromise(
  Database.Service.pipe(
    Effect.flatMap((database) => database.db.run("PRAGMA wal_checkpoint(TRUNCATE)")),
    Effect.provide(Database.layerFromPath(path.join(root, "core.sqlite"))),
    Effect.scoped,
  ),
)
{
  const { Database } = await import("bun:sqlite")
  const meeting = new Database(`${pathToFileURL(path.join(root, "meetings.sqlite")).href}?immutable=1`, {
    readonly: true,
    strict: true,
  })
  try {
    for (const table of [
      "meetings",
      "segments",
      "findings",
      "checkpoints",
      "proposals",
      "plans",
      "approvals",
      "jobs",
      "knowledge_references",
    ])
      if (meeting.query(`SELECT data FROM ${table}`).all().length !== 1)
        throw new Error(`Incomplete Meeting baseline: ${table}`)
    if (meeting.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check !== "ok")
      throw new Error("Corrupt Meeting baseline")
    if (meeting.query("PRAGMA foreign_key_check").all().length) throw new Error("Invalid Meeting baseline references")
  } finally {
    meeting.close()
  }
}
