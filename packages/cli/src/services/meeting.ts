import { createHash } from "node:crypto"
import { lstat, readFile, realpath } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export async function meetingDirectory(directory: string, dataHome = process.env.XDG_DATA_HOME) {
  const key = createHash("sha256")
    .update(await realpath(directory))
    .digest("hex")
    .slice(0, 32)
  return path.join(dataHome ?? path.join(os.homedir(), ".local/share"), "ycoding/meeting", key)
}

export async function connectControl(directory: string, dataHome = process.env.XDG_DATA_HOME) {
  const file = path.join(await meetingDirectory(directory, dataHome), "bridge.json")
  const info = await lstat(file)
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > 4096 ||
    (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())))
  )
    throw new Error("Unsafe meeting bridge descriptor")
  const descriptor: unknown = JSON.parse(await readFile(file, "utf8"))
  if (
    typeof descriptor !== "object" ||
    descriptor === null ||
    Object.keys(descriptor).length !== 3 ||
    !("url" in descriptor) ||
    typeof descriptor.url !== "string" ||
    !("token" in descriptor) ||
    typeof descriptor.token !== "string" ||
    !/^[a-f0-9]{64}$/.test(descriptor.token) ||
    !("pid" in descriptor) ||
    typeof descriptor.pid !== "number" ||
    !Number.isSafeInteger(descriptor.pid) ||
    descriptor.pid <= 0
  )
    throw new Error("Invalid meeting bridge descriptor")
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
  )
    throw new Error("Meeting bridge must be a numeric loopback HTTP endpoint")
  const token = descriptor.token
  return async (input: unknown): Promise<unknown> => {
    const body = JSON.stringify(input)
    if (body === undefined || Buffer.byteLength(body) > 1_048_576) throw new Error("Invalid control payload")
    const response = await fetch(`${url.origin}/control`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {
      throw new Error("Bridge request failed or timed out; outcome unknown")
    })
    if (!response.ok) throw new Error(`Bridge control rejected (${response.status})`)
    return response.json().catch(() => {
      throw new Error("Invalid bridge response; outcome unknown")
    })
  }
}
