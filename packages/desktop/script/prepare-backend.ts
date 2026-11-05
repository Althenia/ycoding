import fs from "node:fs/promises"
import path from "node:path"
import { backendFiles, fileDigest } from "../src/resources"
import { assertLocalArtifactSigning } from "./signing-preflight"

export async function prepareBackend(output: string) {
  await assertLocalArtifactSigning()
  const desktop = path.resolve(import.meta.dir, "..")
  const root = path.resolve(desktop, "../..")
  try { await fs.access(output); throw new Error("Backend build output already exists. Use a fresh directory.") }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error }
  const build = Bun.spawn([process.execPath, "run", "script/build.ts", "--single", `--outdir=${output}`], { cwd: path.join(root, "packages/cli"), stdout: "inherit", stderr: "inherit" })
  if (await build.exited !== 0) throw new Error("The owning CLI backend build failed.")
  const native = path.join(output, `cli-${process.platform}-${process.arch}`, "bin")
  const metadata: unknown = JSON.parse(await fs.readFile(path.join(output, `cli-${process.platform}-${process.arch}`, "package.json"), "utf8"))
  const value = typeof metadata === "object" && metadata !== null && "version" in metadata && typeof metadata.version === "string" && metadata.version ? metadata.version : undefined
  if (!value) throw new Error("The bundled CLI metadata did not report a version.")
  const resources = path.join(desktop, "src-tauri/runtime")
  await fs.rm(resources, { recursive: true, force: true })
  await fs.mkdir(resources, { recursive: true })
  await fs.cp(native, path.join(resources, "backend"), { recursive: true })
  const files: { path: string; sha256: string }[] = []
  for (const file of await backendFiles(resources)) files.push({ path: file, sha256: await fileDigest(path.join(resources, file)) })
  await fs.writeFile(path.join(resources, "backend.json"), JSON.stringify({ executable: "backend/ycoding", version: value, files }, null, 2) + "\n")
  return { resources, version: value, files: files.length }
}

if (import.meta.main) {
  const output = process.argv.find((arg) => arg.startsWith("--outdir="))?.slice(9)
  if (!output) throw new Error("Supply --outdir=<fresh-output-directory> for the owning CLI build.")
  console.log(JSON.stringify(await prepareBackend(path.resolve(output))))
}
