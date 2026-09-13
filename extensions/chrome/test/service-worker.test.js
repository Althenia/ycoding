import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

test("Chrome bridge service-worker lifecycle in an isolated runtime", async () => {
  // Chrome creates a fresh global scope for each worker; module caching must not retain test listeners.
  const child = Bun.spawn([process.execPath, "test", "./test/fixtures/service-worker.case.js"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(exitCode, stdout + stderr).toBe(0)
  } finally {
    child.kill()
    await child.exited
  }
}, 15000)
