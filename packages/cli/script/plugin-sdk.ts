export * as PluginSDKAsset from "./plugin-sdk"

import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { isBuiltin } from "node:module"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { checkBundleGraph } from "../../../script/ycoding-workspace"

export async function build(root: string, directory?: string): Promise<{ path: string; digest: string }> {
  const base = path.resolve(directory ?? os.tmpdir())
  await mkdir(base, { recursive: true, mode: 0o700 })
  const temporary = await mkdtemp(path.join(base, "ycoding-plugin-sdk-"))
  const output = path.join(temporary, "plugin-sdk.mjs")
  try {
    const child = Bun.spawn([process.execPath, fileURLToPath(import.meta.url), path.resolve(root), output], {
      cwd: path.resolve(root),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (code !== 0) throw new Error(`Plugin SDK asset build failed (${code}): ${stderr || stdout}`)
    return {
      path: output,
      digest: createHash("sha256")
        .update(await readFile(output))
        .digest("hex"),
    }
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
}

async function bundle(root: string, output: string) {
  const result = await Bun.build({
    entrypoints: [path.join(root, "packages/cli/script/plugin-sdk-entry.ts")],
    target: "node",
    format: "esm",
    packages: "bundle",
    splitting: false,
    minify: true,
    sourcemap: "none",
    metafile: true,
  })
  if (!result.success) throw new Error(result.logs.map(String).join("\n"))
  if (!result.metafile) throw new Error("Plugin SDK asset build produced no audit graph")
  if (result.outputs.length !== 1 || result.outputs[0].kind !== "entry-point")
    throw new Error("Plugin SDK asset must contain one self-contained JavaScript module")
  const outputs = Object.values(result.metafile.outputs)
  const imports = outputs.flatMap((output) => output.imports.map((entry) => entry.path))
  const violations = checkBundleGraph({
    frontend: "plugin-sdk",
    outputs: [
      {
        file: output,
        modules: Object.keys(result.metafile.inputs).map((file) => path.resolve(root, file).split(path.sep).join("/")),
        imports,
      },
    ],
  })
  if (violations.length)
    throw new Error(
      `Plugin SDK asset contains forbidden runtime modules: ${violations.map((entry) => entry.owner).join(", ")}`,
    )
  const external = imports.filter((specifier) => !isBuiltin(specifier))
  if (external.length) throw new Error(`Plugin SDK asset contains unresolved package externals: ${external.join(", ")}`)
  if (outputs.length !== 1 || outputs[0].exports.toSorted().join(",") !== "effect,promise,runtime,tool")
    throw new Error("Plugin SDK asset must export promise, effect, tool, and runtime")
  await writeFile(output, new Uint8Array(await result.outputs[0].arrayBuffer()), { flag: "wx", mode: 0o600 })
}

if (import.meta.main) {
  const root = process.argv[2]
  const output = process.argv[3]
  if (!root || !output) throw new Error("Plugin SDK asset builder requires a workspace root and output path")
  await bundle(path.resolve(root), path.resolve(output))
}
