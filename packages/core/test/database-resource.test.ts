import { expect, test } from "bun:test"
import { mkdtemp, readdir, readlink, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Database } from "@ycoding-ai/core/database/database"
import { Effect } from "effect"

test("keeps SQLite descriptors stable across 100 database layer scopes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ycoding-database-resource-"))
  const filename = path.join(directory, "resource.sqlite")

  try {
    for (let iteration = 0; iteration < 100; iteration++) {
      await Effect.runPromise(Effect.scoped(Database.Service.pipe(Effect.provide(Database.layer({ path: filename })))))
    }

    expect(await openDatabaseDescriptors(await realpath(filename))).toEqual([])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

async function openDatabaseDescriptors(filename: string) {
  if (process.platform === "darwin") {
    const output = Bun.spawnSync(["lsof", "-a", "-p", String(process.pid), "-Fn"], { stdout: "pipe" })
    if (output.exitCode !== 0) throw new Error("lsof failed while inspecting SQLite descriptors")
    return output.stdout
      .toString()
      .split("\n")
      .filter((line) => line.startsWith("n") && line.slice(1).startsWith(filename))
  }

  if (process.platform === "linux") {
    const directory = `/proc/${process.pid}/fd`
    return (
      await Promise.all(
        (await readdir(directory)).map((descriptor) =>
          readlink(path.join(directory, descriptor)).then(
            (target) => ({ descriptor, target }),
            () => undefined,
          ),
        ),
      )
    ).filter((entry) => entry?.target.startsWith(filename))
  }

  throw new Error(`SQLite descriptor inspection is unsupported on ${process.platform}`)
}
