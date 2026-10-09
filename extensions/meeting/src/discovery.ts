import { createHash } from "node:crypto"
import { lstat, readFile, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { z } from "zod"

export async function meetingDirectory(directory: string) {
  const key = createHash("sha256")
    .update(await realpath(directory))
    .digest("hex")
    .slice(0, 32)
  return path.join(process.env.XDG_DATA_HOME ?? path.join(homedir(), ".local", "share"), "ycoding", "meeting", key)
}

export function validateDescriptor(value: unknown) {
  const descriptor = z
    .object({ url: z.string(), token: z.string().regex(/^[a-f0-9]{64}$/), pid: z.number().int().positive() })
    .strict()
    .parse(value)
  const url = new URL(descriptor.url)
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("Meeting bridge must be a numeric loopback HTTP endpoint")
  }
  return descriptor
}

export async function connectControl(directory: string) {
  const file = path.join(await meetingDirectory(directory), "bridge.json")
  const info = await lstat(file)
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > 4096 ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid())
  ) {
    throw new Error("Unsafe meeting bridge descriptor")
  }
  const descriptor = validateDescriptor(JSON.parse(await readFile(file, "utf8")))
  return async (input: unknown): Promise<unknown> => {
    const { sendControl } = await import("./bridge-client")
    return sendControl(descriptor.url, descriptor.token, input)
  }
}
