import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("standalone server exits when its owner is killed", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-standalone-"))
  const owner = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixture/standalone-owner.ts")], {
    cwd: path.join(import.meta.dir, ".."),
    env: {
      ...process.env,
      YCODING_DB: path.join(directory, "ycoding.db"),
      YCODING_SERVER_USERNAME: "custom",
      XDG_CACHE_HOME: path.join(directory, "cache"),
      XDG_CONFIG_HOME: path.join(directory, "config"),
      XDG_DATA_HOME: path.join(directory, "data"),
      XDG_STATE_HOME: path.join(directory, "state"),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const stderr = new Response(owner.stderr).text()
  const line = await Promise.race([readLine(owner.stdout), Bun.sleep(30_000).then(() => undefined)])
  const [rawPID, url, status] = line?.split(" ") ?? []
  const pid = Number(rawPID)

  try {
    if (!line) {
      owner.kill("SIGKILL")
      await owner.exited
      throw new Error(`Standalone owner exited before readiness (${(await stderr).length} stderr characters captured)`)
    }
    expect(pid).toBeGreaterThan(0)
    expect(url).toStartWith("http://127.0.0.1:")
    expect(status).toBe("200")
    expect(running(pid)).toBe(true)

    owner.kill("SIGKILL")
    await owner.exited

    expect(await waitForExit(pid)).toBe(true)
  } finally {
    owner.kill("SIGKILL")
    if (running(pid)) process.kill(pid, "SIGKILL")
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 30_000)

async function readLine(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  while (true) {
    const result = await reader.read()
    if (result.done) break
    chunks.push(decoder.decode(result.value, { stream: true }))
    const output = chunks.join("")
    const newline = output.indexOf("\n")
    if (newline !== -1) {
      reader.releaseLock()
      return output.slice(0, newline)
    }
  }
  reader.releaseLock()
  return chunks.join("") + decoder.decode()
}

async function waitForExit(pid: number, attempts = 100): Promise<boolean> {
  if (!running(pid)) return true
  if (attempts === 0) return false
  await Bun.sleep(50)
  return waitForExit(pid, attempts - 1)
}

function running(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
