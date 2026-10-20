import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { RulePath, rule, setupKeepAwake } from "../src/commands/keep-awake-setup"

const cli = path.resolve(import.meta.dir, "../src/tui.ts")

async function setup(options: { platform?: string; user?: string; failAt?: number }) {
  const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "keep-awake-test-"))
  const calls: string[][] = []
  const seen: { content?: string; mode?: number } = {}
  const result = await setupKeepAwake({
    platform: options.platform ?? "darwin",
    user: options.user ?? "alice",
    tmpdir,
    run: async (argv) => {
      calls.push(argv)
      if (calls.length === 1) {
        const file = argv[argv.length - 1]
        seen.content = await Bun.file(file).text()
        seen.mode = (await fs.stat(file)).mode & 0o777
      }
      return calls.length === options.failAt ? 7 : 0
    },
  })
  const left = await fs.readdir(tmpdir)
  await fs.rm(tmpdir, { recursive: true, force: true })
  return { result, calls, seen, left }
}

describe("keep-awake setup", () => {
  test("rule content is exact and the user name is validated", () => {
    expect(rule("a.b_c-1")).toBe(
      "a.b_c-1 ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1\n",
    )
    for (const user of ["", "a b", "a\nb", "a,b", "a$b"]) expect(() => rule(user)).toThrow()
  })

  test("validates, installs, then verifies with exact argv and removes the temp file", async () => {
    const { result, calls, seen, left } = await setup({})
    const tmp = calls[0][calls[0].length - 1]
    expect(calls).toEqual([
      ["/usr/bin/sudo", "/usr/sbin/visudo", "-cf", tmp],
      ["/usr/bin/sudo", "/usr/bin/install", "-m", "0440", "-o", "root", "-g", "wheel", tmp, RulePath],
      ["/usr/bin/sudo", "-n", "-l", "/usr/bin/pmset", "-a", "disablesleep", "1"],
    ])
    expect(seen.content).toBe(rule("alice"))
    expect(seen.mode).toBe(0o600)
    expect(result.code).toBe(0)
    expect(result.message).toContain("sudo rm /etc/sudoers.d/ycoding-keep-awake")
    expect(left).toEqual([])
  })

  test.each([1, 2, 3])("step %i failure exits nonzero, stops, and removes the temp file", async (failAt) => {
    const { result, calls, left } = await setup({ failAt })
    expect(calls).toHaveLength(failAt)
    expect(result.code).toBe(1)
    expect(result.message).toContain("exit 7")
    expect(result.message).not.toContain("\n")
    expect(left).toEqual([])
  })

  test("invalid user name runs nothing", async () => {
    const { result, calls, left } = await setup({ user: "bad user" })
    expect(calls).toEqual([])
    expect(result.code).toBe(1)
    expect(left).toEqual([])
  })

  test("non-darwin is unsupported and runs nothing", async () => {
    const { result, calls } = await setup({ platform: "linux" })
    expect(calls).toEqual([])
    expect(result.code).toBe(1)
    expect(result.message).toContain("macOS")
  })

  test("help lists the command", async () => {
    const proc = Bun.spawn(["bun", cli, "--help"], { stdout: "pipe", stderr: "pipe" })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    expect(out).toContain("keep-awake")
    const sub = Bun.spawn(["bun", cli, "keep-awake", "--help"], { stdout: "pipe", stderr: "pipe" })
    expect(await new Response(sub.stdout).text()).toContain("setup")
  })
})
