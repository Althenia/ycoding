import { lstat, mkdtemp, readdir, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { sourceFingerprint, sourceRevision } from "./export"

const roots = new Map<string, { dev: number; ino: number }>()

export async function createBaselineRoot() {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "ycoding-rust-baseline-"))
  const stat = await lstat(root)
  roots.set(root, { dev: stat.dev, ino: stat.ino })
  return root
}

export async function produceBaseline(root: string) {
  const owned = roots.get(root)
  if (!owned) throw new Error("Baseline root must be a fresh harness-created temp directory")
  const stat = await lstat(root)
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.dev !== owned.dev ||
    stat.ino !== owned.ino ||
    (await realpath(root)) !== root ||
    (await readdir(root)).length !== 0
  )
    throw new Error("Baseline root must be an unchanged empty fresh temp directory")
  roots.delete(root)
  const repository = path.resolve(import.meta.dir, "../..")
  const [revision, source] = await Promise.all([sourceRevision(repository), sourceFingerprint(repository)])
  const worker = Bun.spawn(
    [process.execPath, "run", path.join(repository, "packages/core/test/rust-baseline/worker.ts"), root],
    {
      cwd: path.join(repository, "packages/core"),
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: path.join(root, "home"),
        LANG: "C.UTF-8",
        TZ: "UTC",
        TMPDIR: await realpath(tmpdir()),
        YCODING_BASELINE_SOURCE_REVISION: revision,
        YCODING_BASELINE_SOURCE_DIGEST: source.sha256,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000,
    },
  )
  const [stdout, stderr, exit] = await Promise.all([
    new Response(worker.stdout).text(),
    new Response(worker.stderr).text(),
    worker.exited,
  ])
  if (exit !== 0) throw new Error(`Baseline producer exited ${exit}: ${stderr}\n${stdout}`)
  if (!(await Bun.file(path.join(root, "provenance.json")).exists()))
    throw new Error("Baseline producer did not settle its provenance")
  return { root, sourceRevision: revision, sourceFingerprint: source.sha256 }
}

if (import.meta.main) {
  if (process.argv.length !== 2)
    throw new Error("No root arguments are accepted; the harness allocates its own fresh temp directory")
  console.log((await produceBaseline(await createBaselineRoot())).root)
}
