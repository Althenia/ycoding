import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { cleanupRuntimeSmoke } from "./runtime-smoke"

test("runtime cache benchmark leaves prediction on-demand without relaxing accounting or prefix checks", async () => {
  const source = await Bun.file(path.join(import.meta.dir, "runtime-smoke.ts")).text()
  const config = source.split('path.join(project, "ycoding.json"),')[1]?.split("const dir =")[0]
  expect(config).not.toContain("prediction")
  expect(source).toContain("toolSummary.helpers !== 0")
  expect(source).toContain("requests.length - toolRequestsStart !== 3")
  expect(source).toContain("toolSummary.physical !== 3")
  expect(source).toContain("beforeDiagnostics.requests?.latestNamespace !== stableNamespace")
  expect(source).toContain("afterDiagnostics.requests?.latestNamespace !== stableNamespace")
  expect(source).toContain('assertClose(toolSummary.cost, 0.001875, "Tool benchmark estimated cost")')
  expect(source).toContain('assertClose(openAISummary.cost, 0.001455, "OpenAI benchmark estimated cost")')
})

test("runtime smoke waits for stdio server shutdown before removing its workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-runtime-cleanup-"))
  const marker = `${root}.closed`
  const server = Bun.spawn(
    [
      process.execPath,
      "-e",
      `process.stdin.resume(); process.stdin.on("end", async () => {
        await Bun.write(${JSON.stringify(marker)}, "closed")
        process.exit(0)
      })`,
    ],
    { cwd: root, stdin: "pipe", stdout: "ignore", stderr: "inherit" },
  )
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") })
  try {
    await cleanupRuntimeSmoke(provider, server, root)
    expect(server.exitCode).toBe(0)
    expect(await readFile(marker, "utf8")).toBe("closed")
    expect(await Bun.file(root).exists()).toBe(false)
  } finally {
    server.kill()
    await server.exited
    await provider.stop(true)
    await rm(root, { recursive: true, force: true })
    await rm(marker, { force: true })
  }
})
