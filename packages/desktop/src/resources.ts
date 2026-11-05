import { createHash } from "node:crypto"
import { constants, createReadStream } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { DesktopError } from "./contract"

export async function backendFiles(resources: string) {
  const files: string[] = []
  const walk = async (directory: string) => {
    for (const entry of await fs.readdir(path.join(resources, directory), { withFileTypes: true })) {
      const relative = path.posix.join(directory, entry.name)
      if (entry.isDirectory()) await walk(relative)
      else if (entry.isFile()) files.push(relative)
      else throw new Error("Unsupported bundled backend entry.")
    }
  }
  await walk("backend")
  return files.sort()
}

export async function fileDigest(file: string) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest("hex")
}

function manifest(value: unknown) {
  if (typeof value !== "object" || value === null || Object.keys(value).sort().join() !== "executable,files,version" ||
    !("executable" in value) || value.executable !== "backend/ycoding" ||
    !("version" in value) || typeof value.version !== "string" || !value.version ||
    !("files" in value) || !Array.isArray(value.files)) throw new Error("Invalid bundled backend manifest.")
  const files = new Map<string, string>()
  for (const file of value.files as unknown[]) {
    if (typeof file !== "object" || file === null || Object.keys(file).sort().join() !== "path,sha256" ||
      !("path" in file) || typeof file.path !== "string" || !("sha256" in file) || typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256) || files.has(file.path)) throw new Error("Invalid bundled backend manifest.")
    files.set(file.path, file.sha256)
  }
  if (!files.has(value.executable)) throw new Error("Invalid bundled backend manifest.")
  return { executable: value.executable, version: value.version, files }
}

export async function bundledBackend(resources: string) {
  try {
    const value = manifest(JSON.parse(await fs.readFile(path.join(resources, "backend.json"), "utf8")))
    const root = await fs.realpath(resources)
    const present = await backendFiles(root)
    if (present.length !== value.files.size || present.some((file) => !value.files.has(file))) throw new Error("Bundled backend files differ from the manifest.")
    for (const file of present) if (await fileDigest(path.join(root, file)) !== value.files.get(file)) throw new Error("Bundled backend digest mismatch.")
    const executable = path.join(root, value.executable)
    await fs.access(executable, constants.X_OK)
    return { executable, version: value.version }
  } catch { throw new DesktopError("The bundled backend is missing, non-executable or does not match its bundle manifest. Rebuild the desktop app.") }
}
