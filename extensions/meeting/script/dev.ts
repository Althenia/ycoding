import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createInterface } from "node:readline"

const root = fileURLToPath(new URL("../../../", import.meta.url))

export async function launchEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  if (/\s/.test(tmpdir())) throw new Error("Set TMPDIR to a directory without whitespace before launching")
  const directory = await mkdtemp(path.join(tmpdir(), "ycoding-meeting-dev-"))
  await writeFile(
    path.join(directory, "cli.json"),
    JSON.stringify({ plugins: [path.join(root, "extensions/meeting/src/tui.tsx")] }),
    { mode: 0o600 },
  )
  const inheritedSolidPreload = path.join(directory, "solid-preload-proxy.js")
  await writeFile(inheritedSolidPreload, `import ${JSON.stringify(import.meta.resolve("@opentui/solid/preload"))}\n`, {
    mode: 0o600,
  })
  const env: NodeJS.ProcessEnv & { YCODING_PASSWORD: string } = {
    ...environment,
    BUN_OPTIONS: [environment.BUN_OPTIONS, `--preload=${inheritedSolidPreload}`].filter(Boolean).join(" "),
    YCODING_CONFIG_DIR: directory,
    YCODING_CHANNEL: environment.YCODING_CHANNEL === "beta" ? "beta" : "local",
    YCODING_PASSWORD: randomBytes(32).toString("hex"),
  }
  return { directory, env }
}

export async function startMeetingRuntime(input: { directory?: string; env?: NodeJS.ProcessEnv } = {}) {
  const launch = await launchEnvironment(input.env)
  const child = spawn(
    launch.env.YCODING_RUNTIME_EXECUTABLE ??
      path.join(root, "rust/target/debug", process.platform === "win32" ? "ycoding-runtime.exe" : "ycoding-runtime"),
    ["--stdio", "--port", "0", "--meeting"],
    {
      cwd: input.directory ?? process.cwd(),
      env: launch.env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  )
  let diagnostics = ""
  child.stderr.on("data", (chunk) => {
    diagnostics = (diagnostics + String(chunk)).slice(-8192)
  })
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()))
  const stop = async () => {
    child.stdin.end()
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000)
    await exited
    clearTimeout(timer)
    await rm(launch.directory, { recursive: true, force: true })
  }
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Meeting runtime did not start: ${diagnostics}`)), 60000)
    const lines = createInterface({ input: child.stdout })
    lines.once("line", (line) => {
      clearTimeout(timer)
      lines.close()
      child.stdout.resume()
      resolve(line)
    })
    child.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once("close", () => {
      clearTimeout(timer)
      reject(new Error(`Meeting runtime exited before readiness: ${diagnostics}`))
    })
  })
    .then((ready) => {
      const endpoint: unknown = JSON.parse(ready)
      if (
        !endpoint ||
        typeof endpoint !== "object" ||
        !("url" in endpoint) ||
        typeof endpoint.url !== "string" ||
        !/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint.url)
      )
        throw new Error("Meeting runtime returned invalid readiness")
      return endpoint.url
    })
    .catch(async (error: unknown) => {
      await stop()
      throw error
    })
  return { ...launch, url, stop }
}

if (import.meta.main) {
  const launch = await startMeetingRuntime()
  const child = spawn(
    process.execPath,
    [
      "--conditions=browser",
      path.join(root, "packages/cli/src/index.ts"),
      "--server",
      launch.url,
      ...process.argv.slice(2),
    ],
    { cwd: process.cwd(), stdio: "inherit", env: launch.env },
  )
  const interrupt = () => child.kill("SIGINT")
  process.on("SIGINT", interrupt)
  process.on("SIGTERM", interrupt)
  try {
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => resolve(code ?? 1))
    })
  } finally {
    process.removeListener("SIGINT", interrupt)
    process.removeListener("SIGTERM", interrupt)
    await launch.stop()
  }
}
