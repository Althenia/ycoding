import { constants } from "node:fs"
import { access, lstat, readFile, realpath } from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { brotliDecompressSync } from "node:zlib"
import { Schema } from "effect"
import { CONTRACT_DIGEST } from "@ycoding-ai/protocol/v5"
import { InstallationChannel, InstallationVersion } from "./version"

declare const YCODING_USER_APP_PACKET: string

const messages = Object.freeze({
  artifact: "The installed user-app artifact is invalid.",
  configuration: "The user-app configuration is invalid.",
  authentication: "The selected server rejected authentication.",
  version: "The selected server version is incompatible.",
  contract: "The selected server has an incompatible contract.",
  identity: "The selected server identity changed.",
  cancelled: "Opening the user-app connection was cancelled.",
  unavailable: "The selected server is unavailable.",
  shutdown: "The user-app connection did not shut down cleanly.",
})

export class UserAppError extends Error {
  override readonly name = "UserAppError"
  constructor(readonly code: keyof typeof messages) {
    super(messages[code])
    delete this.stack
  }
}

const File = Schema.Struct({ file: Schema.String, sha256: Schema.String })
const Manifest = Schema.Struct({
  version: Schema.String,
  channel: Schema.String,
  os: Schema.String,
  arch: Schema.String,
  wireRevision: Schema.Literal(5),
  contractDigest: Schema.String,
  frontend: File,
  module: File,
  declarations: File,
  runtime: Schema.Struct({ file: Schema.String, sha256: Schema.String, payloadSha256: Schema.String }),
})
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

export async function readPacket(url: URL) {
  try {
    const manifest = decode(await readFile(url, "utf8"))
    if (
      manifest.version !== InstallationVersion ||
      manifest.channel !== InstallationChannel ||
      manifest.os !== process.platform ||
      manifest.arch !== process.arch ||
      manifest.contractDigest !== CONTRACT_DIGEST
    )
      throw new UserAppError("artifact")
    const directory = await realpath(fileURLToPath(new URL("./", url)))
    const verify = async (entry: { readonly file: string; readonly sha256: string }) => {
      if (
        entry.file.includes("\\") ||
        entry.file.includes("\0") ||
        path.isAbsolute(entry.file) ||
        entry.file.split("/").some((part) => part === "" || part === "." || part === "..")
      )
        throw new UserAppError("artifact")
      const filename = path.join(directory, entry.file)
      const info = await lstat(filename)
      const resolved = await realpath(filename)
      if (!info.isFile() || !resolved.startsWith(directory + path.sep)) throw new UserAppError("artifact")
      const bytes = await readFile(resolved)
      if (hash(bytes) !== entry.sha256) throw new UserAppError("artifact")
      return { filename: resolved, bytes }
    }
    const [frontend, , , runtime] = await Promise.all([
      verify(manifest.frontend),
      verify(manifest.module),
      verify(manifest.declarations),
      verify({ file: manifest.runtime.file, sha256: manifest.runtime.payloadSha256 }),
    ])
    await access(frontend.filename, constants.X_OK)
    if (hash(brotliDecompressSync(runtime.bytes)) !== manifest.runtime.sha256) throw new UserAppError("artifact")
    return {
      version: manifest.version,
      channel: manifest.channel,
      frontend: frontend.filename,
      runtime: { payload: new Uint8Array(runtime.bytes), sha256: manifest.runtime.sha256 },
    }
  } catch {
    throw new UserAppError("artifact")
  }
}

export function loadUserAppPacket() {
  if (typeof YCODING_USER_APP_PACKET !== "string") throw new UserAppError("artifact")
  return readPacket(new URL(YCODING_USER_APP_PACKET, import.meta.url))
}
