#!/usr/bin/env bun

import path from "node:path"
import { BUN_BINARY, platformBinary } from "../src/binary"

const dir = path.resolve(import.meta.dirname, "..")
const outdir = path.resolve(
  dir,
  process.argv.find((arg) => arg.startsWith("--dir="))?.slice("--dir=".length) ?? "dist",
)
const platform = process.platform === "win32" ? "windows" : process.platform
const executable = platformBinary(BUN_BINARY)
const binary = path.join(outdir, `tui-${platform}-${process.arch}`, "bin", executable)

if (!(await Bun.file(binary).exists())) throw new Error(`TUI artifact not found: ${binary}`)

const help = Bun.spawnSync([binary, "--help"], { stdout: "pipe", stderr: "pipe" })
const helpText = help.stdout.toString()
const helpError = help.stderr.toString()
if (help.exitCode !== 0) throw new Error(`TUI help failed (${help.exitCode}): ${helpError || helpText}`)
if (!helpText.includes("YCoding TUI")) throw new Error("TUI help is missing the product description")
for (const command of ["run", "update"]) {
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
]) {
  const result = Bun.spawnSync([binary, expected.command, "--help"], { stdout: "pipe", stderr: "pipe" })
  const text = result.stdout.toString()
  if (result.exitCode !== 0)
    throw new Error(`${expected.command} help failed (${result.exitCode}): ${result.stderr.toString() || text}`)
  if (!text.includes(expected.text) || !text.includes(expected.flag))
    throw new Error(`${expected.command} help is missing its description or ${expected.flag}`)
}

const server = Bun.spawn([binary, "serve", "--stdio", "--port", "0"], {
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env, YCODING_PASSWORD: "tui-artifact-smoke" },
})
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
