import { createHash } from "node:crypto"
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import { brotliCompressSync } from "node:zlib"
import { CONTRACT_DIGEST } from "@ycoding-ai/protocol/v5"
import { InstallationChannel, InstallationVersion } from "../../src/version"

export const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

export async function fakePacket() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "ycoding-user-app-packet-")))
  const files = {
    frontend: {
      file: process.platform === "win32" ? "frontend/ycoding.exe" : "frontend/ycoding",
      bytes: Buffer.from("synthetic frontend"),
    },
    module: { file: "server-process.mjs", bytes: Buffer.from("export const syntheticPacket = true\n") },
    declarations: { file: "server-process.d.ts", bytes: Buffer.from("export declare const syntheticPacket: true\n") },
    runtime: {
      file: "assets/runtime/ycoding-runtime",
      bytes: brotliCompressSync(Buffer.from("synthetic native runtime")),
    },
  }
  await Promise.all(
    Object.values(files).map(async ({ file, bytes }) => {
      await mkdir(path.dirname(path.join(directory, file)), { recursive: true })
      await writeFile(path.join(directory, file), bytes, { mode: 0o700 })
    }),
  )
  const manifest = {
    version: InstallationVersion,
    channel: InstallationChannel,
    os: `${process.platform}`,
    arch: `${process.arch}`,
    wireRevision: 5,
    contractDigest: CONTRACT_DIGEST,
    frontend: { file: files.frontend.file, sha256: hash(files.frontend.bytes) },
    module: { file: files.module.file, sha256: hash(files.module.bytes) },
    declarations: { file: files.declarations.file, sha256: hash(files.declarations.bytes) },
    runtime: {
      file: files.runtime.file,
      sha256: hash(Buffer.from("synthetic native runtime")),
      payloadSha256: hash(files.runtime.bytes),
    },
  }
  const url = pathToFileURL(path.join(directory, "user-app.packet.json"))
  const save = () => writeFile(url, JSON.stringify(manifest))
  await save()
  return { directory, manifest, files, url, save }
}
