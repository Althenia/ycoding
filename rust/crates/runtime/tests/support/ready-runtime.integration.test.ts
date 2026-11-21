import { expect, test } from "bun:test"
import { access, readdir, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { Service } from "../../../../../packages/client/src/promise/service"
import { fixture } from "./launcher-client"

test("the ready fixture owns an initially empty configuration override and removes it", async () => {
  const binary = process.env.YCODING_TEST_RUST_RUNTIME
  if (!binary) throw new Error("YCODING_TEST_RUST_RUNTIME must name the built launcher")
  const runtime = await fixture(binary)
  try {
    expect(typeof runtime.configDir).toBe("string")
    expect(await readdir(runtime.configDir)).toEqual([])
    expect(runtime.command("config-test")).toContain(`YCODING_CONFIG_DIR=${runtime.configDir}`)
    await writeFile(
      join(runtime.configDir, "ycoding.json"),
      JSON.stringify({ username: "{file:missing-test-input.txt}" }),
    )
    await expect(
      Service.ensure({
        file: runtime.file,
        version: "config-test",
        command: runtime.command("config-test"),
        startupErrorFile: runtime.startupErrorFile,
      }),
    ).rejects.toThrow("production composition failed")
  } finally {
    await runtime.dispose()
  }
  await expect(access(runtime.configDir)).rejects.toThrow()
})

test("the command harness exposes URL, password and its owned configuration directory", () => {
  const binary = process.env.YCODING_TEST_RUST_RUNTIME
  if (!binary) throw new Error("YCODING_TEST_RUST_RUNTIME must name the built launcher")
  const probe = `
const directory = process.env.YCODING_V5_TEST_CONFIG_DIR
if (!directory) throw new Error("missing configuration directory")
const paths = Bun.spawnSync([process.env.YCODING_TEST_RUST_RUNTIME, "--paths"], { env: { ...process.env, YCODING_CONFIG_DIR: directory } })
if (paths.exitCode !== 0) throw new Error("path lookup failed")
if (JSON.parse(new TextDecoder().decode(paths.stdout)).config !== directory) throw new Error("configuration override differs")
const response = await fetch(new URL("/health", process.env.YCODING_V5_TEST_URL), { headers: { authorization: "Basic " + btoa("ycoding:" + process.env.YCODING_V5_TEST_PASSWORD) } })
if (response.status !== 200) throw new Error("runtime is not ready")
console.log(JSON.stringify({ configDir: directory, health: response.status, passwordPresent: Boolean(process.env.YCODING_V5_TEST_PASSWORD) }))
`
  const output = spawnSync(
    process.execPath,
    [join(import.meta.dir, "ready-runtime.ts"), binary, process.execPath, "-e", probe],
    { encoding: "utf8", timeout: 120_000 },
  )
  expect(output.status).toBe(0)
  const result = JSON.parse(output.stdout) as { configDir: string; health: number; passwordPresent: boolean }
  expect(result.health).toBe(200)
  expect(result.passwordPresent).toBe(true)
  expect(existsSync(result.configDir)).toBe(false)
}, 120_000)
