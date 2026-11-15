import { expect, spyOn, test } from "bun:test"
import { createHash, generateKeyPairSync, verify } from "node:crypto"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as fs from "node:fs/promises"
import { BrowserExtension } from "@ycoding-ai/core/browser/extension"
import { chromeCrxFile, chromeID, chromeZip, createChromeCrx, hasSignedChromeExtension, signChromeExtension, verifyChromeCrx } from "../script/chrome-crx"
import { installLocalBuild } from "../script/install-local"
import { chromeCrxFixture } from "./fixtures/chrome-crx"

function protobuf(bytes: Buffer) {
  let offset = 0
  const integer = () => {
    let value = 0
    let shift = 0
    while (offset < bytes.length) {
      const byte = bytes[offset++]
      value += (byte & 127) * 2 ** shift
      if (byte < 128) return value
      shift += 7
    }
    throw new Error("Truncated protobuf")
  }
  const result = new Map<number, Buffer>()
  while (offset < bytes.length) {
    const tag = integer()
    expect(tag % 8).toBe(2)
    const size = integer()
    result.set(Math.floor(tag / 8), bytes.subarray(offset, offset + size))
    offset += size
  }
  return result
}

test("encodes Chromium CRX3 signed data with RSA-SHA256 and the SPKI identity", () => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const publicKey = pair.publicKey.export({ type: "spki", format: "der" })
  const privateKey = Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "pem" }))
  const archive = chromeZip([["manifest.json", Buffer.from('{"name":"Synthetic"}')]])
  const crx = createChromeCrx(archive, privateKey, publicKey)
  expect(crx.subarray(0, 4).toString()).toBe("Cr24")
  expect(crx.readUInt32LE(4)).toBe(3)
  const end = 12 + crx.readUInt32LE(8)
  const header = protobuf(crx.subarray(12, end))
  const proof = protobuf(header.get(2)!)
  const signedData = header.get(10000)!
  const identity = createHash("sha256").update(publicKey).digest().subarray(0, 16)
  expect(protobuf(signedData).get(1)!.equals(identity)).toBe(true)
  expect(proof.get(1)!.equals(publicKey)).toBe(true)
  const size = Buffer.alloc(4)
  size.writeUInt32LE(signedData.length)
  expect(verify("RSA-SHA256", Buffer.concat([Buffer.from("CRX3 SignedData\0"), size, signedData, crx.subarray(end)]), pair.publicKey, proof.get(2)!)).toBe(true)
  expect(crx.subarray(end).equals(archive)).toBe(true)
  expect(verifyChromeCrx(crx, publicKey).id).toBe(chromeID(publicKey))
})

test("rejects wrong signing keys, altered signatures, truncated headers and altered archives", () => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const publicKey = pair.publicKey.export({ type: "spki", format: "der" })
  const privateKey = Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "pem" }))
  const wrong = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "der" })
  const archive = chromeZip([["manifest.json", Buffer.from("synthetic")]])
  expect(() => createChromeCrx(archive, privateKey, wrong)).toThrow("Chrome package")
  const crx = createChromeCrx(archive, privateKey, publicKey)
  const signature = protobuf(protobuf(crx.subarray(12, 12 + crx.readUInt32LE(8))).get(2)!).get(2)!
  const changedSignature = Buffer.from(crx)
  changedSignature[crx.indexOf(signature)] ^= 1
  const changedArchive = Buffer.from(crx)
  changedArchive[changedArchive.length - 1] ^= 1
  for (const changed of [crx.subarray(0, 11), changedSignature, changedArchive]) {
    expect(() => verifyChromeCrx(changed, publicKey)).toThrow("Chrome package")
  }
  const header = Buffer.from(crx)
  header.writeUInt32LE(0xffffffff, 8)
  expect(() => verifyChromeCrx(header, publicKey)).toThrow("Chrome package")
  expect(() => verifyChromeCrx(crx, wrong)).toThrow("Chrome package")
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  expect(() => createChromeCrx(archive, Buffer.from(ec.privateKey.export({ type: "pkcs8", format: "pem" })), ec.publicKey.export({ type: "spki", format: "der" }))).toThrow("Chrome package")
})

test("binds the signing identity to the manifest public SPKI", async () => {
  const manifest: { key: string } = await Bun.file(path.join(import.meta.dir, "../../../extensions/chrome/manifest.json")).json()
  expect(chromeID(Buffer.from(manifest.key, "base64"))).toBe("pplfpnheaokgnhbgjnoboepjlmdnkeda")
})

test("signs only the exact unpacked files and rejects later content changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-crx-"))
  try {
    const fixture = await chromeCrxFixture(root)
    await signChromeExtension(root, fixture.privateKey)
    expect(await hasSignedChromeExtension(root)).toBe(true)
    expect((await readdir(root)).sort()).toEqual(["ycoding", BrowserExtension.directory, chromeCrxFile].sort())
    await writeFile(path.join(root, BrowserExtension.directory, "service-worker.js"), "changed")
    await expect(hasSignedChromeExtension(root)).rejects.toThrow("Chrome package")
    await expect(signChromeExtension(root, fixture.privateKey)).rejects.toThrow("EEXIST")
    await writeFile(path.join(root, BrowserExtension.directory, "unexpected.js"), "unexpected")
    await expect(signChromeExtension(root, fixture.privateKey)).rejects.toThrow("Chrome package")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("restores the previous signed install when CRX replacement fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-crx-rollback-"))
  try {
    const destination = path.join(root, "installed")
    const first = path.join(root, "first")
    const second = path.join(root, "second")
    const fixture = await chromeCrxFixture(first, "1")
    await chromeCrxFixture(second, "2", fixture.keys)
    await signChromeExtension(first, fixture.privateKey)
    await signChromeExtension(second, fixture.privateKey)
    await installLocalBuild({ source: first, destination, platform: "linux" })
    const rename = fs.rename
    let failed = false
    const replacement = spyOn(fs, "rename").mockImplementation(async (source, target) => {
      if (!failed && String(source).includes(".install-") && String(target) === path.join(destination, chromeCrxFile)) {
        failed = true
        throw new Error("CRX replacement failed")
      }
      return rename(source, target)
    })
    try {
      await expect(installLocalBuild({ source: second, destination, platform: "linux" })).rejects.toThrow("CRX replacement failed")
    } finally { replacement.mockRestore() }
    expect(await hasSignedChromeExtension(destination)).toBe(true)
    expect(await readFile(path.join(destination, "ycoding"), "utf8")).toBe("synthetic executable 1")
    expect((await readdir(destination)).sort()).toEqual(["ycoding", BrowserExtension.directory, chromeCrxFile].sort())
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("installs and updates a signed CRX sibling with its executable and unpacked extension", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-crx-install-"))
  try {
    const destination = path.join(root, "installed")
    const first = path.join(root, "first")
    const second = path.join(root, "second")
    const fixture = await chromeCrxFixture(first, "1")
    await chromeCrxFixture(second, "2", fixture.keys)
    await signChromeExtension(first, fixture.privateKey)
    await signChromeExtension(second, fixture.privateKey)
    for (const source of [first, second]) {
      const installed = await installLocalBuild({ source, destination, platform: "linux" })
      expect(installed).toContain(path.join(destination, chromeCrxFile))
      expect(await hasSignedChromeExtension(destination)).toBe(true)
      expect((await readFile(path.join(destination, chromeCrxFile))).equals(await readFile(path.join(source, chromeCrxFile)))).toBe(true)
    }
    expect(await readFile(path.join(destination, "ycoding"), "utf8")).toBe("synthetic executable 2")
    await rm(path.join(second, chromeCrxFile))
    await expect(installLocalBuild({ source: second, destination, platform: "linux" })).rejects.toThrow("Signed Chrome package required")
    expect(await hasSignedChromeExtension(destination)).toBe(true)
  } finally { await rm(root, { recursive: true, force: true }) }
})
