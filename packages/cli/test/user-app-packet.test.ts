import { expect, test } from "bun:test"
import { chmod, readFile, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { fakePacket } from "./fixture/user-app-packet"

const modulePath = path.join(import.meta.dirname, "../src/user-app-packet.ts")
const load = async () => {
  const module: typeof import("../src/user-app-packet") | undefined = await import(modulePath).catch(() => undefined)
  expect(module?.readPacket).toBeFunction()
  if (!module) throw new Error("The packet module is unavailable")
  return module
}

test("packaging writer emits the exact fake packet consumed by the ordinary main loader", async () => {
  const packet = await fakePacket()
  try {
    const buildPath = path.join(import.meta.dirname, "../script/user-app-package.ts")
    const builder: typeof import("../script/user-app-package") | undefined = await import(buildPath).catch(
      () => undefined,
    )
    expect(builder?.writePacket).toBeFunction()
    if (!builder) throw new Error("The packet writer is unavailable")
    await rm(packet.url)
    await builder.writePacket(packet.directory, {
      version: packet.manifest.version,
      channel: packet.manifest.channel,
      os: packet.manifest.os,
      arch: packet.manifest.arch,
      frontend: packet.files.frontend.file,
      runtime: {
        file: packet.files.runtime.file,
        sha256: packet.manifest.runtime.sha256,
        payloadSha256: packet.manifest.runtime.payloadSha256,
      },
    })
    expect(JSON.parse(await readFile(packet.url, "utf8"))).toEqual(packet.manifest)
    const module = await load()
    expect((await module.readPacket(packet.url)).version).toBe(packet.manifest.version)
  } finally {
    await rm(packet.directory, { recursive: true, force: true })
  }
})

test("packaged synthetic packet binds its actual module, declarations, frontend and compressed native bytes", async () => {
  const packet = await fakePacket()
  try {
    const module = await load()
    const result = await module.readPacket(packet.url)
    expect(result.frontend).toBe(path.join(packet.directory, packet.files.frontend.file))
    expect(result.version).toBe(packet.manifest.version)
    expect(result.channel).toBe(packet.manifest.channel)
    expect(result.runtime.payload).toEqual(
      new Uint8Array(await readFile(path.join(packet.directory, packet.files.runtime.file))),
    )
  } finally {
    await rm(packet.directory, { recursive: true, force: true })
  }
})

test.each([
  "missing",
  "json",
  "version",
  "channel",
  "os",
  "arch",
  "revision",
  "digest",
  "frontend-sha",
  "module-sha",
  "types-sha",
  "payload-sha",
  "runtime-sha",
  "traversal",
  "symlink",
  "nonexecutable",
])("packaged synthetic packet rejects %s without exposing paths or raw errors", async (fault) => {
  const packet = await fakePacket()
  try {
    if (fault === "missing") await rm(packet.url)
    if (fault === "json") await writeFile(packet.url, "synthetic-secret malformed")
    if (fault === "version") packet.manifest.version += "-different"
    if (fault === "channel") packet.manifest.channel += "-different"
    if (fault === "os") packet.manifest.os = "synthetic-os"
    if (fault === "arch") packet.manifest.arch = "synthetic-arch"
    if (fault === "revision") packet.manifest.wireRevision = 4
    if (fault === "digest") packet.manifest.contractDigest = "0".repeat(64)
    if (fault === "frontend-sha") packet.manifest.frontend.sha256 = "0".repeat(64)
    if (fault === "module-sha") packet.manifest.module.sha256 = "0".repeat(64)
    if (fault === "types-sha") packet.manifest.declarations.sha256 = "0".repeat(64)
    if (fault === "payload-sha") packet.manifest.runtime.payloadSha256 = "0".repeat(64)
    if (fault === "runtime-sha") packet.manifest.runtime.sha256 = "0".repeat(64)
    if (fault === "traversal") packet.manifest.frontend.file = "../synthetic-secret"
    if (fault === "symlink") {
      const frontend = path.join(packet.directory, packet.files.frontend.file)
      await rm(frontend)
      await symlink(path.join(packet.directory, packet.files.module.file), frontend)
    }
    if (fault === "nonexecutable") await chmod(path.join(packet.directory, packet.files.frontend.file), 0o600)
    if (fault !== "missing" && fault !== "json") await packet.save()
    const module = await load()
    const error = await module.readPacket(packet.url).catch((error: unknown) => error)
    expect(error).toMatchObject({
      name: "UserAppError",
      code: "artifact",
      message: "The installed user-app artifact is invalid.",
    })
    expect(JSON.stringify(Object.getOwnPropertyDescriptors(error))).not.toContain(packet.directory)
    expect(error).not.toHaveProperty("cause")
    expect(error).not.toHaveProperty("stack")
  } finally {
    await rm(packet.directory, { recursive: true, force: true })
  }
})
