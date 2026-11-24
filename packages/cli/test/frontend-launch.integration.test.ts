import { expect, test } from "bun:test"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const native = process.env.YCODING_RUNTIME_EXECUTABLE

async function checkRuntime(native: string, directory: string, command: string[], assetOwner?: string) {
  if (!native || !path.isAbsolute(native)) throw new Error("Bind YCODING_RUNTIME_EXECUTABLE to the built Rust runtime")
  const child = Bun.spawn([...command, "serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: directory,
    env: {
      PATH: process.env.PATH,
      HOME: directory,
      USERPROFILE: directory,
      APPDATA: path.join(directory, "config"),
      LOCALAPPDATA: path.join(directory, "data"),
      XDG_CONFIG_HOME: path.join(directory, "config"),
      XDG_DATA_HOME: path.join(directory, "data"),
      XDG_CACHE_HOME: path.join(directory, "cache"),
      XDG_STATE_HOME: path.join(directory, "state"),
      YCODING_RUNTIME_EXECUTABLE: native,
      YCODING_DB: ":memory:",
      YCODING_DISABLE_MODELS_FETCH: "1",
      YCODING_CONFIG_PROJECT_DISABLE: "1",
      YCODING_PASSWORD: "synthetic-frontend-launch",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  })
  const stderr = new Response(child.stderr).text()
  const output = child.stdout.pipeThrough(new TextDecoderStream()).getReader()
  try {
    let stdout = ""
    while (!stdout.includes("\n")) {
      const chunk = await output.read()
      if (chunk.done) throw new Error(`CLI exited (${await child.exited}) before readiness: ${await stderr}`)
      stdout += chunk.value
    }
    const ready: unknown = JSON.parse(stdout.split("\n", 1)[0])
    if (typeof ready !== "object" || ready === null || !("url" in ready) || typeof ready.url !== "string")
      throw new Error("CLI readiness did not contain a URL")
    const { url } = ready
    expect(new URL(url).hostname).toBe("127.0.0.1")
    const response = await fetch(new URL("/api/health", url), {
      headers: { Authorization: `Basic ${btoa("ycoding:synthetic-frontend-launch")}` },
      signal: AbortSignal.timeout(5_000),
    })
    expect(response.ok).toBe(true)
    const health: unknown = await response.json()
    if (typeof health !== "object" || health === null || !("pid" in health) || typeof health.pid !== "number")
      throw new Error("Runtime health did not contain a PID")
    expect("healthy" in health && health.healthy).toBe(true)
    const pid = health.pid
    expect(pid).not.toBe(child.pid)
    if (process.platform !== "win32") {
      const processInfo = Bun.spawnSync(["ps", "-ww", "-p", String(pid), "-o", "command="], { stderr: "pipe" })
      expect(processInfo.exitCode, `Runtime PID ${pid}: ${processInfo.stderr.toString().trim()}`).toBe(0)
      const args = processInfo.stdout.toString().trim()
      expect(args).toStartWith(`${native} serve `)
      expect(args).not.toContain("--frontend-arguments")
      if (assetOwner) expect(args).toContain(`--frontend-executable ${assetOwner}`)
      else expect(args).not.toContain("--frontend-executable")
    }
    await child.stdin.end()
    expect(await child.exited, await stderr).toBe(0)
  } finally {
    if (child.exitCode === null) child.kill()
    await child.exited
    await output.cancel()
  }
}

const entry = path.resolve(import.meta.dirname, "../src/index.ts")

test.skipIf(!native)("source CLI serves requests through the isolated Rust runtime", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ycoding-source-launch-"))
  try {
    await checkRuntime(native!, directory, [process.execPath, entry])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 35_000)

test.skipIf(!native)("compiled CLI serves requests and identifies its executable as the asset owner", async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "ycoding-compiled-launch-")))
  const frontend = path.join(directory, process.platform === "win32" ? "ycoding.exe" : "ycoding")
  try {
    const result = await Bun.build({
      entrypoints: [entry],
      tsconfig: path.resolve(import.meta.dirname, "../tsconfig.json"),
      plugins: [createSolidTransformPlugin()],
      external: ["node-gyp"],
      compile: { outfile: frontend },
    })
    expect(result.success, result.logs.map(String).join("\n")).toBe(true)
    await checkRuntime(native!, directory, [frontend], frontend)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 90_000)

test("only installed frontends supply native asset metadata", async () => {
  const { frontendAssetArguments } = await import("../src/frontend-launch")
  for (const executable of ["/installed/ycoding", "/installed/ycoding-node", "/installed/ycoding.exe"]) {
    expect(frontendAssetArguments(executable)).toEqual(["--frontend-executable", executable])
  }
  for (const executable of ["/runtime/bun", "/runtime/node", "/runtime/nodejs", "/runtime/node.exe"]) {
    expect(frontendAssetArguments(executable)).toEqual([])
  }
})
