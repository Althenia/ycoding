import fs from "node:fs/promises"
import path from "node:path"
import { backendFiles, fileDigest } from "../src/resources"
import { assertLocalArtifactSigning } from "./signing-preflight"

export async function prepareBackend(
  desktop = path.resolve(import.meta.dir, ".."),
  run: (command: readonly string[], cwd: string) => Promise<number> = (command, cwd) => Bun.spawn([...command], { cwd, stdout: "inherit", stderr: "inherit" }).exited,
) {
  await assertLocalArtifactSigning(process.env, desktop)
  const root = path.resolve(desktop, "../..")
  const cli = path.join(root, "packages/cli")
  const output = path.join(cli, "dist")
  const resources = path.join(desktop, "runtime")
  try { await fs.lstat(output); throw new Error("CLI build output already exists. Preserve it before building.") }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error }
  try { await fs.lstat(resources); throw new Error("Desktop runtime already exists. Preserve it before building.") }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error }
  const command = [process.execPath, "run", "script/build.ts", "--single"]
  const buildSource = path.join(cli, "script/build.ts")
  const buildSourceSha256 = await fileDigest(buildSource)
  if (await run(command, cli) !== 0) throw new Error("The owning CLI backend build failed.")
  if (await fileDigest(buildSource) !== buildSourceSha256) throw new Error("The CLI backend build source changed.")
  const native = path.join(output, `cli-${process.platform}-${process.arch}`, "bin")
  const packageFile = path.join(output, `cli-${process.platform}-${process.arch}`, "package.json")
  const metadata: unknown = JSON.parse(await fs.readFile(packageFile, "utf8"))
  const value = typeof metadata === "object" && metadata !== null && "version" in metadata && typeof metadata.version === "string" && metadata.version ? metadata.version : undefined
  if (!value) throw new Error("The bundled CLI metadata did not report a version.")
  await fs.mkdir(resources)
  await fs.cp(native, path.join(resources, "backend"), { recursive: true })
  const files: { path: string; sha256: string }[] = []
  for (const file of await backendFiles(resources)) files.push({ path: file, sha256: await fileDigest(path.join(resources, file)) })
  await fs.writeFile(path.join(resources, "backend.json"), JSON.stringify({ executable: "backend/ycoding", version: value, files }, null, 2) + "\n")
  return { resources, version: value, files: files.length, producer: { cwd: cli, argv: command, status: 0 as const, buildSource: { path: buildSource, sha256: buildSourceSha256 }, package: { path: packageFile, sha256: await fileDigest(packageFile) }, executable: { path: path.join(resources, "backend/ycoding"), sha256: await fileDigest(path.join(resources, "backend/ycoding")) }, manifest: { path: path.join(resources, "backend.json"), sha256: await fileDigest(path.join(resources, "backend.json")) } } }
}

if (import.meta.main) {
  if (process.argv.length !== 2) throw new Error("Backend preparation does not accept arguments.")
  console.log(JSON.stringify(await prepareBackend()))
}
