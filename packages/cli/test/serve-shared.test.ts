import { expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { recordStartupError } from "../src/commands/handlers/serve-shared"

test("managed serve records a bounded startup failure for the parent", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ycoding-startup-error-"))
  const file = path.join(directory, "error")
  const previous = process.env.YCODING_SERVICE_STARTUP_ERROR_FILE
  process.env.YCODING_SERVICE_STARTUP_ERROR_FILE = file
  try {
    await Effect.runPromise(recordStartupError(new Error("port collision")))
    expect(await readFile(file, "utf8")).toBe("port collision")
  } finally {
    if (previous === undefined) delete process.env.YCODING_SERVICE_STARTUP_ERROR_FILE
    else process.env.YCODING_SERVICE_STARTUP_ERROR_FILE = previous
    await rm(directory, { recursive: true, force: true })
  }
})
