import { expect, mock, test } from "bun:test"
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { readPacket } from "../src/user-app-packet"
import { fakePacket } from "./fixture/user-app-packet"

const compilerPath = path.join(import.meta.dirname, "../script/user-app-compiler.ts")
let realCompilationReached = 0
const forbiddenCompilation = () => {
  realCompilationReached++
  throw new Error("Real module compilation is forbidden in this fixture")
}
mock.module(compilerPath, () => ({ compileUserAppModule: forbiddenCompilation }))
const { compileUserAppModule } = await import("../script/user-app-compiler")
expect(compileUserAppModule).toBe(forbiddenCompilation)
const { buildUserAppPackage, userAppPackageMetadata } = await import("../script/user-app-package")

const host = { os: process.platform, arch: process.arch }
const hostTarget = `${host.os}-${host.arch}`

test("CLI metadata binds emitted module declarations while TUI metadata exposes no absent library", () => {
  expect(userAppPackageMetadata(true)).toEqual({
    type: "module",
    exports: {
      "./server-process": { types: "./lib/server-process.d.ts", import: "./lib/server-process.mjs" },
    },
  })
  expect(userAppPackageMetadata(false)).toEqual({})
})
const emit = async (input: { readonly directory: string }) => {
  await writeFile(path.join(input.directory, "server-process.mjs"), "export const synthetic = true\n")
}

async function fixture() {
  const packet = await fakePacket()
  const packageDirectory = path.join(packet.directory, "package")
  await mkdir(packageDirectory)
  const assemble = async (
    name: string,
    selected: { os: string; arch: string },
    selection: { requested?: string; targets: readonly { os: string; arch: string }[] },
  ) => {
    const artifact = path.join(packet.directory, name)
    await mkdir(artifact)
    const frontend = path.join(artifact, "synthetic-frontend")
    await writeFile(frontend, `synthetic frontend ${name}`)
    const input = {
      directory: path.join(artifact, "lib"),
      packageDirectory,
      frontend,
      os: selected.os,
      arch: selected.arch,
      version: packet.manifest.version,
      channel: packet.manifest.channel,
      runtimeAsset: {
        path: path.join(packet.directory, packet.files.runtime.file),
        sha256: packet.manifest.runtime.sha256,
        payloadSha256: packet.manifest.runtime.payloadSha256,
      },
      pluginSDKAsset: {
        path: path.join(packet.directory, packet.files.module.file),
        digest: packet.manifest.module.sha256,
      },
      selection,
    }
    await buildUserAppPackage(input, emit)
    return { directory: input.directory, input }
  }
  return { packet, packageDirectory, assemble }
}

test("implicit host packaging retains its bound artifact without creating a shared root mirror", async () => {
  const current = await fixture()
  try {
    const artifact = await current.assemble("implicit-host", host, { targets: [host] })
    expect((await readPacket(pathToFileURL(path.join(artifact.directory, "user-app.packet.json")))).version).toBe(
      current.packet.manifest.version,
    )
    await expect(stat(path.join(current.packageDirectory, "lib"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(realCompilationReached).toBe(0)
  } finally {
    await rm(current.packet.directory, { recursive: true, force: true })
  }
})

test("a multi-target plan keeps distinct complete packets and never collides in the shared root", async () => {
  const current = await fixture()
  try {
    const other = { os: process.platform, arch: "synthetic-other-arch" }
    const selection = { requested: hostTarget, targets: [host, other] }
    const first = await current.assemble("first-target", host, selection)
    const firstManifest = await readFile(path.join(first.directory, "user-app.packet.json"), "utf8")
    const second = await current.assemble("second-target", other, selection)
    expect(await readFile(path.join(first.directory, "user-app.packet.json"), "utf8")).toBe(firstManifest)
    expect(JSON.parse(firstManifest)).toMatchObject(host)
    expect(JSON.parse(await readFile(path.join(second.directory, "user-app.packet.json"), "utf8"))).toMatchObject(other)
    expect(await readFile(path.join(first.directory, "frontend/synthetic-frontend"), "utf8")).toBe(
      "synthetic frontend first-target",
    )
    expect(await readFile(path.join(second.directory, "frontend/synthetic-frontend"), "utf8")).toBe(
      "synthetic frontend second-target",
    )
    await expect(stat(path.join(current.packageDirectory, "lib"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(realCompilationReached).toBe(0)
  } finally {
    await rm(current.packet.directory, { recursive: true, force: true })
  }
})

test("explicit host-only packaging mirrors the exact bound packet and preserves an existing target", async () => {
  const current = await fixture()
  try {
    const artifact = await current.assemble("selected-host", host, { requested: hostTarget, targets: [host] })
    const source = await readFile(path.join(artifact.directory, "user-app.packet.json"), "utf8")
    const mirrored = path.join(current.packageDirectory, "lib/user-app.packet.json")
    expect(await readFile(mirrored, "utf8")).toBe(source)
    expect((await readPacket(pathToFileURL(mirrored))).frontend).toEqual([
      path.join(current.packageDirectory, "lib/frontend/synthetic-frontend"),
    ])
    await expect(buildUserAppPackage(artifact.input, emit)).rejects.toMatchObject({ code: "EEXIST" })
    expect(await readFile(path.join(artifact.directory, "user-app.packet.json"), "utf8")).toBe(source)
    expect(realCompilationReached).toBe(0)
  } finally {
    await rm(current.packet.directory, { recursive: true, force: true })
  }
})

test("a non-host packet cannot claim the single selected host's root mirror", async () => {
  const current = await fixture()
  try {
    const other = { os: process.platform, arch: "synthetic-other-arch" }
    const artifact = await current.assemble("non-host", other, { requested: hostTarget, targets: [host] })
    expect(JSON.parse(await readFile(path.join(artifact.directory, "user-app.packet.json"), "utf8"))).toMatchObject(
      other,
    )
    await expect(
      readPacket(pathToFileURL(path.join(artifact.directory, "user-app.packet.json"))),
    ).rejects.toMatchObject({ code: "artifact" })
    await expect(stat(path.join(current.packageDirectory, "lib"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(realCompilationReached).toBe(0)
  } finally {
    await rm(current.packet.directory, { recursive: true, force: true })
  }
})

test("explicit host-only packaging refuses to overwrite an existing shared root", async () => {
  const current = await fixture()
  try {
    const root = path.join(current.packageDirectory, "lib")
    await mkdir(root)
    await writeFile(path.join(root, "ownership-marker"), "synthetic existing output")
    await expect(
      current.assemble("protected-host", host, { requested: hostTarget, targets: [host] }),
    ).rejects.toMatchObject({ code: "EEXIST" })
    expect(await readFile(path.join(root, "ownership-marker"), "utf8")).toBe("synthetic existing output")
    await expect(stat(path.join(root, "user-app.packet.json"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(realCompilationReached).toBe(0)
  } finally {
    await rm(current.packet.directory, { recursive: true, force: true })
  }
})
