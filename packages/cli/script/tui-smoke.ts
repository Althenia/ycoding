#!/usr/bin/env bun

import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { BUN_BINARY, platformBinary } from "../src/binary"
import { verifyPackagedComputerHelper } from "./computer-helper"

const dir = path.resolve(import.meta.dirname, "..")
const outdir = path.resolve(dir, process.argv.find((arg) => arg.startsWith("--dir="))?.slice("--dir=".length) ?? "dist")
const platform = process.platform === "win32" ? "windows" : process.platform
const executable = platformBinary(BUN_BINARY)
const binary = path.join(outdir, `tui-${platform}-${process.arch}`, "bin", executable)

if (!(await Bun.file(binary).exists())) throw new Error(`TUI artifact not found: ${binary}`)
await verifyPackagedComputerHelper(path.dirname(binary))

const help = Bun.spawnSync([binary, "--help"], { stdout: "pipe", stderr: "pipe" })
const helpText = help.stdout.toString()
const helpError = help.stderr.toString()
if (help.exitCode !== 0) throw new Error(`TUI help failed (${help.exitCode}): ${helpError || helpText}`)
if (!helpText.includes("YCoding TUI")) throw new Error("TUI help is missing the product description")
for (const command of ["run", "update", "remote"]) {
  if (!new RegExp(`^  ${command}(?:\\s|$)`, "m").test(helpText))
    throw new Error(`TUI help is missing command: ${command}`)
}
for (const command of ["api", "auth", "debug", "mcp", "mini", "service"]) {
  if (new RegExp(`^  ${command}(?:\\s|$)`, "m").test(helpText))
    throw new Error(`TUI help exposes excluded command: ${command}`)
}
for (const expected of [
  { command: "run", text: "Run YCoding with a message", flag: "--model" },
  { command: "update", text: "Update ycoding to a release", flag: "--version" },
  { command: "remote", text: "Control this machine's YCoding agent", flag: "enroll" },
]) {
  const result = Bun.spawnSync([binary, expected.command, "--help"], { stdout: "pipe", stderr: "pipe" })
  const text = result.stdout.toString()
  if (result.exitCode !== 0)
    throw new Error(`${expected.command} help failed (${result.exitCode}): ${result.stderr.toString() || text}`)
  if (!text.includes(expected.text) || !text.includes(expected.flag))
    throw new Error(`${expected.command} help is missing its description or ${expected.flag}`)
}

const remoteHome = await mkdtemp(path.join(os.tmpdir(), "ycoding-tui-smoke-"))
try {
  const result = Bun.spawnSync([binary, "remote", "status"], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HOME: remoteHome,
      YCODING_TEST_HOME: remoteHome,
      XDG_CACHE_HOME: path.join(remoteHome, "cache"),
      XDG_CONFIG_HOME: path.join(remoteHome, "config"),
      XDG_DATA_HOME: path.join(remoteHome, "data"),
      XDG_STATE_HOME: path.join(remoteHome, "state"),
      YCODING_DB: undefined,
      YCODING_PASSWORD: undefined,
      YCODING_CONFIG_DIR: undefined,
      YCODING_CONFIG: undefined,
      YCODING_REMOTE_URL: undefined,
    },
  })
  const text = result.stdout.toString()
  if (result.exitCode !== 0)
    throw new Error(`remote status failed (${result.exitCode}): ${result.stderr.toString() || text}`)
  if (!text.includes("Not enrolled")) throw new Error("remote status did not dispatch the remote handler")
} finally {
  await rm(remoteHome, { recursive: true, force: true })
}

const server = Bun.spawn([binary, "serve", "--stdio", "--port", "0"], {
  // The stdio server owns its lifetime through EOF. Do not inherit a CI runner's stdin:
  // it can remain open after the smoke parent is ready and make the timeout kill a healthy server.
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env, YCODING_PASSWORD: "tui-artifact-smoke" },
})
server.stdin.end()
const stdout = new Response(server.stdout).text()
const stderr = new Response(server.stderr).text()
const timeout = setTimeout(() => server.kill(), 5_000)
const exitCode = await server.exited
clearTimeout(timeout)
const [serverText, serverError] = await Promise.all([stdout, stderr])
const readiness = serverText
  .split("\n")
  .map((line) => line.trim())
  .find(Boolean)
if (!readiness) throw new Error(`Hidden server produced no readiness line: ${serverError}`)
const ready: unknown = JSON.parse(readiness)
const url = typeof ready === "object" && ready !== null ? Reflect.get(ready, "url") : undefined
if (typeof url !== "string" || !url.startsWith("http://127.0.0.1:"))
  throw new Error(`Invalid hidden server readiness: ${readiness}`)
if (exitCode !== 0) throw new Error(`Hidden server exited with ${exitCode}: ${serverError}`)

console.log(`TUI artifact smoke passed: ${binary}`)
