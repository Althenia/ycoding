import { expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"

test.skipIf(process.platform === "win32").each(["managed", "standalone"] as const)(
  "%s source launch hands its entrypoint to the backend without shell parsing",
  async (mode) => {
    const directory = await mkdtemp(path.join(import.meta.dirname, ".frontend-launch-"))
    const source = path.join(directory, "source entry; literal.ts")
    const backend = path.join(directory, "runtime fixture")
    const caller = path.resolve(
      import.meta.dirname,
      mode === "managed" ? "../src/server-process.ts" : "../src/services/standalone.ts",
    )
    try {
      await writeFile(
        backend,
        `#!${process.execPath}
const args = process.argv.slice(2)
const executable = args[args.indexOf("--frontend-executable") + 1]
const index = args.indexOf("--frontend-arguments")
const prefix = index < 0 ? [] : JSON.parse(args[index + 1])
const child = Bun.spawn([executable, ...prefix, "plugin-host"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000 })
const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
if (code !== 0) throw new Error("Frontend relaunch failed: " + stderr)
const report = { args, child: stdout.trim() }
${
  mode === "standalone"
    ? `const url = new URL("http://127.0.0.1:1")
url.searchParams.set("report", JSON.stringify(report))
console.log(JSON.stringify({ url: url.href }))
await Bun.stdin.text()`
    : `console.log(JSON.stringify(report))`
}
`,
      )
      await chmod(backend, 0o700)
      await writeFile(
        source,
        `import { Effect } from "effect"
import { ${mode === "managed" ? "ServerProcess" : "Standalone"} } from ${JSON.stringify(caller)}
if (process.argv[2] === "plugin-host") {
  console.log("source entrypoint reached")
} else {
  ${
    mode === "managed"
      ? `await Effect.runPromise(Effect.scoped(ServerProcess.run({ mode: "stdio", port: 0 })))`
      : `const endpoint = await Effect.runPromise(Effect.scoped(Standalone.start({ command: [${JSON.stringify(backend)}] })))
  console.log(endpoint.url)`
  }
}
`,
      )
      const child = Bun.spawn([process.execPath, source], {
        cwd: directory,
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          XDG_CONFIG_HOME: path.join(directory, "config"),
          XDG_DATA_HOME: path.join(directory, "data"),
          XDG_CACHE_HOME: path.join(directory, "cache"),
          XDG_STATE_HOME: path.join(directory, "state"),
          TMPDIR: directory,
          YCODING_RUNTIME_EXECUTABLE: backend,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10000,
      })
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        expect(code, stderr).toBe(0)
        const report = JSON.parse(mode === "managed" ? stdout : new URL(stdout.trim()).searchParams.get("report")!)
        expect(report.child).toBe("source entrypoint reached")
        expect(report.args[report.args.indexOf("--frontend-executable") + 1]).toBe(process.execPath)
        expect(JSON.parse(report.args[report.args.indexOf("--frontend-arguments") + 1])).toEqual([source])
      } finally {
        child.kill()
        await child.exited
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  15000,
)

test("frontend handoff retains source flags and keeps compiled frontends argument-free", async () => {
  const { frontendLaunchArguments } = await import("../src/frontend-launch")
  for (const executable of ["/compiled/ycoding", "/compiled/ycoding-node"]) {
    expect(frontendLaunchArguments([executable])).toEqual(["--frontend-executable", executable])
  }
  for (const command of [
    ["/runtime/bun", "/source/entry with spaces;literal.ts"],
    ["/runtime/node", "--experimental-ffi", "--conditions=browser", "/source/entry.mjs"],
  ]) {
    expect(frontendLaunchArguments(command)).toEqual([
      "--frontend-executable",
      command[0],
      "--frontend-arguments",
      JSON.stringify(command.slice(1)),
    ])
  }
  expect(() => frontendLaunchArguments([])).toThrow("frontend executable")
})
