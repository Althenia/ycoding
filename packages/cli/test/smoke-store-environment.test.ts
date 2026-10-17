import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const cliRoot = path.resolve(import.meta.dir, "..")
const captured = ["YCODING_DB", "YCODING_SQLITE_IMPORT_SOURCE", "YCODING_DISABLE_CHANNEL_DB", "XDG_DATA_HOME"]

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-smoke-store-env-"))
  const capture = path.join(directory, "capture.jsonl")
  const stub = path.join(directory, "artifact.ts")
  const preload = path.join(directory, "preload.ts")
  await Bun.write(
    stub,
    `import { appendFileSync } from "node:fs"
const keys = ${JSON.stringify(captured)}
appendFileSync(process.env.YCODING_TEST_STUB_CAPTURE!, JSON.stringify(Object.fromEntries(keys.map((key) => [key, process.env[key]]))) + "\\n")
process.exit(1)
`,
  )
  await Bun.write(
    preload,
    `const spawn = Bun.spawn
Bun.spawn = (args, options) => spawn([process.execPath, ${JSON.stringify(stub)}, ...args.slice(1)], options)
`,
  )
  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: path.join(directory, "parent-home"),
    TMPDIR: directory,
    TMP: directory,
    TEMP: directory,
    YCODING_TEST_STUB_CAPTURE: capture,
    YCODING_DB: path.join(directory, "parent.redb"),
    YCODING_SQLITE_IMPORT_SOURCE: path.join(directory, "parent-source.sqlite"),
    YCODING_DISABLE_CHANNEL_DB: "0",
  }
  return {
    directory,
    preload,
    run: async (script: string, ...args: string[]) => {
      const child = Bun.spawn([process.execPath, "--preload", preload, script, ...args], {
        cwd: cliRoot,
        env: environment,
        stdout: "pipe",
        stderr: "pipe",
      })
      const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
      const exitCode = await Promise.race([child.exited, Bun.sleep(40_000).then(() => undefined)])
      if (exitCode === undefined) {
        child.kill()
        throw new Error("The smoke script neither exited nor refused within 40 seconds")
      }
      const [stdout, stderr] = await output
      return { exitCode, stdout, stderr }
    },
    captured: async (result: { exitCode: number; stdout: string; stderr: string }) => {
      if (!(await Bun.file(capture).exists()))
        throw new Error(
          `The artifact stub never started (smoke exit ${result.exitCode}).\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
        )
      return (await Bun.file(capture).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, string | undefined>)
    },
    close: () => rm(directory, { recursive: true, force: true }),
  }
}

test("runtime smoke scrubs ambient store selection and keeps the stable-slot selector", async () => {
  const smoke = await fixture()
  try {
    const platform = process.platform === "win32" ? "windows" : process.platform
    await Bun.write(
      path.join(
        smoke.directory,
        "dist",
        `tui-${platform}-${process.arch}`,
        "bin",
        process.platform === "win32" ? "ycoding.exe" : "ycoding",
      ),
      "stub artifact",
    )
    const result = await smoke.run("script/runtime-smoke.ts", `--dir=${path.join(smoke.directory, "dist")}`)
    expect(result.exitCode).not.toBe(0)
    const [server] = await smoke.captured(result)
    expect(server.YCODING_DB ?? "").toBe("")
    expect(server.YCODING_SQLITE_IMPORT_SOURCE ?? "").toBe("")
    expect(server.YCODING_DISABLE_CHANNEL_DB).toBe("1")
    expect(server.XDG_DATA_HOME).toStartWith(os.tmpdir())
    expect(server.XDG_DATA_HOME).not.toBe(path.join(smoke.directory, "parent-home"))
  } finally {
    await smoke.close()
  }
}, 60_000)

test("isolated-browser smoke scrubs ambient store selection and keeps the stable-slot selector", async () => {
  const smoke = await fixture()
  try {
    const artifact = path.join(smoke.directory, "ycoding")
    await Bun.write(artifact, "stub artifact")
    const result = await smoke.run("script/isolated-browser-smoke.ts", `--binary=${artifact}`)
    expect(result.exitCode).not.toBe(0)
    if (process.platform !== "darwin" || process.arch !== "arm64") {
      expect(result.stderr).toContain("approved only for macOS arm64")
      return
    }
    const [server] = await smoke.captured(result)
    expect(server.YCODING_DB ?? "").toBe("")
    expect(server.YCODING_SQLITE_IMPORT_SOURCE ?? "").toBe("")
    expect(server.YCODING_DISABLE_CHANNEL_DB).toBe("1")
    expect(server.XDG_DATA_HOME).toStartWith(os.tmpdir())
  } finally {
    await smoke.close()
  }
}, 60_000)
