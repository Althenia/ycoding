import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test.each(["ready", "invalid-readiness", "failed-exit", "version-mismatch", "version-failure"])(
  "artifact smoke isolates server state and cleans up after %s",
  async (mode) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-tui-smoke-test-"))
    try {
      const capture = path.join(directory, "capture.jsonl")
      const stub = path.join(directory, "artifact.ts")
      const preload = path.join(directory, "preload.ts")
      const platform = process.platform === "win32" ? "windows" : process.platform
      await Bun.write(path.join(directory, `tui-${platform}-${process.arch}`, "package.json"), JSON.stringify({ version: "0.10.13" }))
      await Bun.write(
        path.join(
          directory,
          `tui-${platform}-${process.arch}`,
          "bin",
          process.platform === "win32" ? "ycoding.exe" : "ycoding",
        ),
        "stub artifact",
      )
      await Bun.write(
        stub,
        `import { appendFileSync } from "node:fs"
const args = process.argv.slice(2)
if (args[0] === "--version") {
  console.log(${JSON.stringify(mode === "version-mismatch" ? "ycoding v0.10.12" : "ycoding v0.10.13")})
  process.exit(${mode === "version-failure" ? 7 : 0})
}
if (args.includes("--help")) {
  console.log("YCoding TUI\\n  run\\n  update\\n  remote\\n  service\\nRun YCoding with a message --model\\nUpdate ycoding to a release --version\\nControl this machine's YCoding agent enroll\\nManage the background server restart")
  process.exit(0)
}
const env = Object.fromEntries(["HOME", "YCODING_TEST_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "TMPDIR", "TMP", "TEMP", "YCODING_DB", "YCODING_CONFIG_DIR", "YCODING_CONFIG", "YCODING_PASSWORD", "YCODING_REMOTE_URL"].map((key) => [key, process.env[key]]))
appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ args, env }) + "\\n")
if (args[0] === "remote") {
  console.log("Not enrolled")
  process.exit(0)
}
if (args[0] !== "serve") throw new Error("Unexpected artifact command")
const input = await Bun.stdin.text()
if (input !== "") throw new Error("Expected empty stdin EOF")
console.log(JSON.stringify({ url: ${JSON.stringify(mode === "invalid-readiness" ? "invalid" : "http://127.0.0.1:12345")} }))
process.exit(${mode === "failed-exit" ? 7 : 0})
`,
      )
      await Bun.write(
        preload,
        `import { mock } from "bun:test"
mock.module(${JSON.stringify(path.resolve(import.meta.dir, "../script/computer-use.ts"))}, () => ({ verifyPackagedComputerHelper: async () => {} }))
const spawn = Bun.spawn
const spawnSync = Bun.spawnSync
Bun.spawn = (args, options) => spawn([process.execPath, ${JSON.stringify(stub)}, ...args.slice(1)], options)
Bun.spawnSync = (args, options) => spawnSync([process.execPath, ${JSON.stringify(stub)}, ...args.slice(1)], options)
`,
      )
      const inherited = {
        HOME: path.join(directory, "parent-home"),
        YCODING_TEST_HOME: path.join(directory, "parent-test-home"),
        XDG_CACHE_HOME: path.join(directory, "parent-cache"),
        XDG_CONFIG_HOME: path.join(directory, "parent-config"),
        XDG_DATA_HOME: path.join(directory, "parent-data"),
        XDG_STATE_HOME: path.join(directory, "parent-state"),
        TMPDIR: directory,
        TMP: directory,
        TEMP: directory,
        YCODING_DB: path.join(directory, "parent.db"),
        YCODING_CONFIG_DIR: path.join(directory, "parent-config-dir"),
        YCODING_CONFIG: path.join(directory, "parent.json"),
        YCODING_PASSWORD: "parent-password",
        YCODING_REMOTE_URL: "https://example.invalid",
      }
      const child = Bun.spawn([process.execPath, "--preload", preload, "script/tui-smoke.ts", `--dir=${directory}`], {
        cwd: path.resolve(import.meta.dir, ".."),
        env: { ...process.env, ...inherited },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      if (mode === "version-mismatch" || mode === "version-failure") {
        expect(exitCode).not.toBe(0)
        expect(stderr).toContain("TUI artifact version")
        expect(existsSync(capture)).toBe(false)
        expect(stdout).not.toContain("TUI artifact smoke passed:")
        return
      }
      if (mode === "ready") {
        expect(exitCode, stderr).toBe(0)
        expect(stdout).toContain("TUI artifact smoke passed:")
      }
      if (mode !== "ready") {
        expect(exitCode).not.toBe(0)
        expect(stderr).toContain(
          mode === "invalid-readiness" ? "Invalid hidden server readiness" : "Hidden server exited with 7",
        )
        expect(stdout).not.toContain("TUI artifact smoke passed:")
      }
      const calls: { args: string[]; env: Record<string, string> }[] = (await Bun.file(capture).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(calls.map((call) => call.args)).toEqual([
        ["remote", "status"],
        ["serve", "--stdio", "--port", "0"],
      ])
      const remote = calls[0].env
      const server = calls[1].env
      expect(server.HOME).not.toBe(inherited.HOME)
      expect(server.HOME).toBe(remote.HOME)
      expect(server.YCODING_TEST_HOME).toBe(server.HOME)
      for (const key of ["TMPDIR", "TMP", "TEMP"]) expect(server[key]).toBe(server.HOME)
      for (const [key, suffix] of [
        ["XDG_CACHE_HOME", "cache"],
        ["XDG_CONFIG_HOME", "config"],
        ["XDG_DATA_HOME", "data"],
        ["XDG_STATE_HOME", "state"],
      ]) {
        expect(server[key]).toBe(path.join(server.HOME, suffix))
      }
      for (const key of ["YCODING_DB", "YCODING_CONFIG_DIR", "YCODING_CONFIG", "YCODING_REMOTE_URL"])
        expect(server[key]).toBeUndefined()
      expect(server.YCODING_PASSWORD).toBe("tui-artifact-smoke")
      expect(remote.YCODING_PASSWORD).toBeUndefined()
      expect(existsSync(server.HOME)).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  30_000,
)
