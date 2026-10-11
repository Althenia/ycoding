import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../../", import.meta.url))

export async function launchEnvironment() {
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
  return {
    directory,
    env: {
      ...process.env,
      BUN_OPTIONS: [process.env.BUN_OPTIONS, `--preload=${inheritedSolidPreload}`].filter(Boolean).join(" "),
      YCODING_CONFIG_DIR: directory,
      YCODING_CONFIG_CONTENT: JSON.stringify({ plugins: [path.join(root, "extensions/meeting/src/plugin.ts")] }),
    },
  }
}

if (import.meta.main) {
  const launch = await launchEnvironment()
  const child = spawn(
    process.execPath,
    ["--conditions=browser", path.join(root, "packages/cli/src/index.ts"), "--standalone", ...process.argv.slice(2)],
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
    await rm(launch.directory, { recursive: true, force: true })
  }
}
