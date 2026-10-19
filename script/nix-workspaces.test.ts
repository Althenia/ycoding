import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")

test("Nix packages and CI support Linux and Apple Silicon macOS only", async () => {
  const flake = await Bun.file(path.join(root, "flake.nix")).text()
  const nodeModules = await Bun.file(path.join(root, "nix/node_modules.nix")).text()
  const evalWorkflow = await Bun.file(path.join(root, ".github/workflows/nix-eval.yml")).text()
  const hashesWorkflow = await Bun.file(path.join(root, ".github/workflows/nix-hashes.yml")).text()
  const supported = ["x86_64-linux", "aarch64-linux", "aarch64-darwin"]
  const values = [
    /systems\s*=\s*\[([\s\S]*?)\];/.exec(flake)?.[1],
    /meta\.platforms\s*=\s*\[([\s\S]*?)\];/.exec(nodeModules)?.[1],
    /SYSTEMS="([^"]+)"/.exec(evalWorkflow)?.[1],
    [...hashesWorkflow.matchAll(/^\s*- system: (\S+)/gm)].map((match) => match[1]).join(" "),
    /for SYSTEM in ([^;]+); do/.exec(hashesWorkflow)?.[1],
  ]
  expect(values.every((value) => value !== undefined)).toBe(true)
  for (const value of values) {
    const systems = value!.match(/(?:aarch64|x86_64)-(?:linux|darwin)/g) ?? []
    expect(systems.toSorted()).toEqual(supported.toSorted())
  }
})

test("the Nix dependency source resolves the unchanged frozen workspace graph", async () => {
  const source = await Bun.file(path.join(root, "nix/node_modules.nix")).text()
  const union = /lib\.fileset\.unions\s*\[([^\]]+)\]/.exec(source)?.[1]
  if (!union) throw new Error("Nix dependency source has no declared fileset union")
  const inputs = [...union.matchAll(/^\s*\.\.\/(\S+)(?:\s+#.*)?\s*$/gm)].map((match) => match[1]!)
  const included = (file: string) => inputs.some((input) => file === input || file.startsWith(`${input}/`))
  const manifest: { workspaces: { packages: string[] } } = await Bun.file(path.join(root, "package.json")).json()
  const files = [
    "package.json",
    "bun.lock",
    ...manifest.workspaces.packages.map((workspace) => `${workspace}/package.json`),
  ]
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-nix-workspaces-"))
  try {
    for (const file of files.filter(included)) {
      await mkdir(path.dirname(path.join(directory, file)), { recursive: true })
      await cp(path.join(root, file), path.join(directory, file))
    }
    if (included("patches")) await cp(path.join(root, "patches"), path.join(directory, "patches"), { recursive: true })
    const missing = await Promise.all(
      files.map(async (file) => ((await Bun.file(path.join(directory, file)).exists()) ? [] : [file])),
    )
    expect(missing.flat()).toEqual([])
    const child = Bun.spawn(
      [
        process.execPath,
        "install",
        `--cpu=${process.arch}`,
        `--os=${process.platform}`,
        "--filter",
        "!./",
        "--filter",
        "./packages/cli",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--no-progress",
        "--lockfile-only",
        "--offline",
      ],
      {
        cwd: directory,
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          BUN_INSTALL_CACHE_DIR: path.join(directory, "cache"),
          NO_COLOR: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 20_000,
      },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, `${stdout}\n${stderr}`).toBe(0)
    for (const file of files)
      expect(await Bun.file(path.join(directory, file)).text(), file).toBe(await Bun.file(path.join(root, file)).text())
    expect(existsSync(path.join(directory, "node_modules"))).toBe(false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
