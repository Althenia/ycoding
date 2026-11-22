import { createHash } from "node:crypto"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { resolvePaths } from "../../cli/src/paths"
import { profile } from "../src/backend-confinement"

type Runtime = { readonly bytes: Buffer; readonly sha256: string }
type StagedRuntime = { readonly executable: string; readonly cache: string; readonly ancestors: readonly string[] }

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

export async function readRuntime(source: string, sha256: string, frontend: string): Promise<Runtime> {
  if (!/^[a-f0-9]{64}$/.test(sha256) || !path.isAbsolute(source) || await fs.realpath(source) !== source)
    throw new Error("Use the reviewed canonical native runtime and its expected SHA-256.")
  const file = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o111) === 0 || (info.mode & 0o222) !== 0)
      throw new Error("The native runtime input must be an owned, read-only executable regular file.")
    const bytes = await file.readFile()
    if (digest(bytes) !== sha256 || !(await fs.readFile(frontend)).includes(Buffer.from(sha256)))
      throw new Error("The native runtime does not match the reviewed digest in the packaged CLI.")
    return { bytes, sha256 }
  } finally {
    await file.close()
  }
}

export async function stageRuntime(owned: string, env: NodeJS.ProcessEnv, version: string, runtime: Runtime): Promise<StagedRuntime> {
  const bin = resolvePaths(env, "latest").bin
  if (env.XDG_CACHE_HOME !== path.join(owned, "cache") || path.relative(owned, bin) !== "cache/ycoding/bin")
    throw new Error("The runtime must use the normal cache path inside the owned fixture.")
  const cache = path.join(bin, "runtime")
  const encodedVersion = encodeURIComponent(version)
  if (!encodedVersion || encodedVersion === "." || encodedVersion === "..") throw new Error("Invalid native runtime version.")
  const executable = path.join(cache, encodedVersion, runtime.sha256, "ycoding-runtime")
  const ancestors = [owned, env.XDG_CACHE_HOME, path.dirname(bin), bin]
  await fs.mkdir(path.dirname(executable), { recursive: true, mode: 0o700 })
  if (await fs.realpath(path.dirname(executable)) !== path.dirname(executable))
    throw new Error("The owned runtime cache must not traverse links.")
  await fs.writeFile(executable, runtime.bytes, { flag: "wx", mode: 0o500 })
  const info = await fs.lstat(executable)
  if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o500 || digest(await fs.readFile(executable)) !== runtime.sha256)
    throw new Error("The staged runtime is not the private, read-only executable that was reviewed.")
  return { executable, cache, ancestors }
}

export function runtimeProfile(input: Parameters<typeof profile>[0], runtime: StagedRuntime): string {
  const base = profile({ ...input, tools: [...(input.tools ?? []), runtime.executable] })
  const literals = runtime.ancestors.map((entry) => `(literal ${JSON.stringify(entry)})`).join(" ")
  return `${base}\n(deny file-write* (subpath ${JSON.stringify(runtime.cache)}) ${literals})\n(deny file-link)`
}
