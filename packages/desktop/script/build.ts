import fs from "node:fs/promises"
import path from "node:path"
import { nodeFiles, metadataCommand, orchestrate, parseMetadata, type Boundary } from "./build-preflight"
import { prepareBackend } from "./prepare-backend"
import { assertLocalArtifactSigning } from "./signing-preflight"

async function main() {
  const desktop = path.resolve(import.meta.dir, "..")
  if (process.platform !== "darwin") throw new Error("The native desktop app build currently requires macOS.")
  const boundary: Boundary = {
    files: nodeFiles,
    assertSigning: () => assertLocalArtifactSigning(),
    metadata: async () => {
      const child = Bun.spawn([...metadataCommand], { cwd: path.join(desktop, "src-tauri"), stdout: "pipe", stderr: "inherit" })
      const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
      if (code !== 0) throw new Error("Cargo did not report package metadata offline and locked.")
      return parseMetadata(text)
    },
    lock: async (file, token) => {
      try {
        await fs.writeFile(file, token, { flag: "wx" })
      } catch {
        throw new Error("The Cargo target already has a desktop build lock, or its directory is unavailable. Refusing; nothing was removed.")
      }
    },
    unlock: async (file, token) => {
      if (await fs.readFile(file, "utf8") !== token) throw new Error("The desktop build lock is not owned by this invocation; it was left in place.")
      await fs.rm(file)
    },
    mkdir: (target) => fs.mkdir(target),
    mkdirs: async (target) => { await fs.mkdir(target, { recursive: true }) },
    copy: (from, to) => fs.cp(from, to, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false }),
    write: (target, text) => fs.writeFile(target, text, { flag: "wx" }),
    prepare: (output) => prepareBackend(output),
    tauri: async (command) => Bun.spawn([...command], { cwd: desktop, stdout: "inherit", stderr: "inherit" }).exited,
  }
  console.log(JSON.stringify(await orchestrate(boundary, { argv: process.argv.slice(2), desktop, execPath: process.execPath })))
}

if (import.meta.main) await main()
