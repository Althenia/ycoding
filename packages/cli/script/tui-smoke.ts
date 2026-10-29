#!/usr/bin/env bun

import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { BUN_BINARY, platformBinary } from "../src/binary"
import { verifyPackagedComputerHelper } from "./computer-use"

const dir = path.resolve(import.meta.dirname, "..")
const outdir = path.resolve(dir, process.argv.find((arg) => arg.startsWith("--dir="))?.slice("--dir=".length) ?? "dist")
const platform = process.platform === "win32" ? "windows" : process.platform
const executable = platformBinary(BUN_BINARY)
const binary = path.join(outdir, `tui-${platform}-${process.arch}`, "bin", executable)

if (!(await Bun.file(binary).exists())) throw new Error(`TUI artifact not found: ${binary}`)
const metadata: unknown = await Bun.file(path.join(outdir, `tui-${platform}-${process.arch}`, "package.json")).json()
if (typeof metadata !== "object" || metadata === null || !("version" in metadata) || typeof metadata.version !== "string" || !metadata.version)
  throw new Error("TUI artifact version is missing from build metadata")
const version = Bun.spawnSync([binary, "--version"], { stdout: "pipe", stderr: "pipe" })
if (version.exitCode !== 0 || version.stdout.toString().trim() !== `${BUN_BINARY} v${metadata.version}`)
  throw new Error(`TUI artifact version mismatch: expected ${metadata.version}, received ${version.stdout.toString().trim()} (exit ${version.exitCode})`)
await verifyPackagedComputerHelper(path.dirname(binary))

const help = Bun.spawnSync([binary, "--help"], { stdout: "pipe", stderr: "pipe" })
const helpText = help.stdout.toString()
const helpError = help.stderr.toString()
if (help.exitCode !== 0) throw new Error(`TUI help failed (${help.exitCode}): ${helpError || helpText}`)
if (!helpText.includes("YCoding TUI")) throw new Error("TUI help is missing the product description")
for (const command of ["run", "update", "remote", "service", "api", "decision", "dots"]) {
  if (!new RegExp(`^  ${command}(?:\\s|$)`, "m").test(helpText))
    throw new Error(`TUI help is missing command: ${command}`)
}
for (const command of ["auth", "debug", "mcp", "mini"]) {
  if (new RegExp(`^  ${command}(?:\\s|$)`, "m").test(helpText))
    throw new Error(`TUI help exposes excluded command: ${command}`)
}
for (const expected of [
  { command: "run", text: "Run YCoding with a message", flag: "--model" },
  { command: "update", text: "Update ycoding to a release", flag: "--version" },
  { command: "remote", text: "Control this machine's YCoding agent", flag: "enroll" },
  { command: "service", text: "Manage the background server", flag: "restart" },
  { command: "api", text: "Make a request to the running server", flag: "--param" },
  { command: "decision", text: "Inspect pending decisions across all Sessions and Locations", flag: "list" },
  { command: "dots", text: "Manage this computer's Dots connection", flag: "attach" },
]) {
  const result = Bun.spawnSync([binary, expected.command, "--help"], { stdout: "pipe", stderr: "pipe" })
  const text = result.stdout.toString()
  if (result.exitCode !== 0)
    throw new Error(`${expected.command} help failed (${result.exitCode}): ${result.stderr.toString() || text}`)
  if (!text.includes(expected.text) || !text.includes(expected.flag))
    throw new Error(`${expected.command} help is missing its description or ${expected.flag}`)
}

const smokeHome = await mkdtemp(path.join(os.tmpdir(), "ycoding-tui-smoke-"))
try {
  const env = {
    ...process.env,
    HOME: smokeHome,
    YCODING_TEST_HOME: smokeHome,
    XDG_CACHE_HOME: path.join(smokeHome, "cache"),
    XDG_CONFIG_HOME: path.join(smokeHome, "config"),
    XDG_DATA_HOME: path.join(smokeHome, "data"),
    XDG_STATE_HOME: path.join(smokeHome, "state"),
    TMPDIR: smokeHome,
    TMP: smokeHome,
    TEMP: smokeHome,
    YCODING_DB: undefined,
    YCODING_PASSWORD: undefined,
    YCODING_CONFIG_DIR: undefined,
    YCODING_CONFIG: undefined,
    YCODING_REMOTE_URL: undefined,
  }
  const result = Bun.spawnSync([binary, "remote", "status"], {
    stdout: "pipe",
    stderr: "pipe",
    env,
  })
  const text = result.stdout.toString()
  if (result.exitCode !== 0)
    throw new Error(`remote status failed (${result.exitCode}): ${result.stderr.toString() || text}`)
  if (!text.includes("Not enrolled")) throw new Error("remote status did not dispatch the remote handler")
  const server = Bun.spawn([binary, "serve", "--stdio", "--port", "0"], {
    // The stdio server owns its lifetime through EOF. Do not inherit a CI runner's stdin:
    // it can remain open after the smoke parent is ready and make the timeout kill a healthy server.
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...env, YCODING_PASSWORD: "tui-artifact-smoke" },
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
} finally {
  await rm(smokeHome, { recursive: true, force: true })
}

console.log(`TUI artifact smoke passed: ${binary}`)
