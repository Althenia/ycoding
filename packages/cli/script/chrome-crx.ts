import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto"
import { lstat, readFile, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { crc32 } from "node:zlib"
import { BrowserExtension } from "@ycoding-ai/core/browser/extension"

export const chromeCrxFile = `${BrowserExtension.directory}.crx`
const maximumArchive = 64 * 1024 * 1024
const signatureContext = Buffer.from("CRX3 SignedData\0")

const invalid = () => new Error("Invalid signed Chrome package")

function uint32(value: number) {
  const result = Buffer.alloc(4)
  result.writeUInt32LE(value)
  return result
}

function varint(value: number) {
  const bytes: number[] = []
  do {
    bytes.push((value & 127) | (value > 127 ? 128 : 0))
    value >>>= 7
  } while (value)
  return Buffer.from(bytes)
}

function field(number: number, bytes: Uint8Array) {
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes])
}

function fields(bytes: Buffer) {
  let offset = 0
  const read = () => {
    let value = 0
    for (let index = 0; index < 5; index++) {
      if (offset >= bytes.length) throw invalid()
      const byte = bytes[offset++]
      value += (byte & 127) * 2 ** (7 * index)
      if (byte < 128) return value
    }
    throw invalid()
  }
  const result = new Map<number, Buffer>()
  while (offset < bytes.length) {
    const tag = read()
    const size = read()
    const number = Math.floor(tag / 8)
    if (tag % 8 !== 2 || !number || result.has(number) || offset + size > bytes.length) throw invalid()
    result.set(number, bytes.subarray(offset, offset + size))
    offset += size
  }
  return result
}

export function chromeID(publicKey: Uint8Array) {
  return createHash("sha256").update(publicKey).digest().subarray(0, 16)
    .toString("hex").replace(/[0-9a-f]/g, (value) => String.fromCharCode(97 + Number.parseInt(value, 16)))
}

export function createChromeCrx(archive: Uint8Array, privateKey: Uint8Array, expectedPublicKey: Uint8Array) {
  if (!archive.length || archive.length > maximumArchive) throw invalid()
  const key = (() => {
    try { return createPrivateKey(Buffer.from(privateKey)) } catch { throw invalid() }
  })()
  if (key.asymmetricKeyType !== "rsa") throw invalid()
  const publicKey = createPublicKey(key).export({ format: "der", type: "spki" })
  if (!publicKey.equals(Buffer.from(expectedPublicKey))) throw invalid()
  const signedData = field(1, createHash("sha256").update(publicKey).digest().subarray(0, 16))
  const signature = sign("RSA-SHA256", Buffer.concat([signatureContext, uint32(signedData.length), signedData, archive]), key)
  const proof = Buffer.concat([field(1, publicKey), field(2, signature)])
  const header = Buffer.concat([field(2, proof), field(10000, signedData)])
  return Buffer.concat([Buffer.from("Cr24"), uint32(3), uint32(header.length), header, archive])
}

export function verifyChromeCrx(bytes: Uint8Array, expectedPublicKey: Uint8Array) {
  try {
    const crx = Buffer.from(bytes)
    if (crx.length < 12 || crx.length > maximumArchive + 1024 * 1024 || crx.toString("ascii", 0, 4) !== "Cr24" || crx.readUInt32LE(4) !== 3) throw invalid()
    const size = crx.readUInt32LE(8)
    if (size > 1024 * 1024 || size + 12 >= crx.length) throw invalid()
    const header = fields(crx.subarray(12, 12 + size))
    if (header.size !== 2 || !header.has(2) || !header.has(10000)) throw invalid()
    const proof = fields(header.get(2)!)
    const signedData = header.get(10000)!
    const signed = fields(signedData)
    if (proof.size !== 2 || !proof.has(1) || !proof.has(2) || signed.size !== 1 || !signed.has(1)) throw invalid()
    const publicKey = proof.get(1)!
    const identity = signed.get(1)!
    if (!publicKey.equals(Buffer.from(expectedPublicKey)) || identity.length !== 16 ||
      !identity.equals(createHash("sha256").update(publicKey).digest().subarray(0, 16))) throw invalid()
    const archive = crx.subarray(12 + size)
    const key = createPublicKey({ key: publicKey, format: "der", type: "spki" })
    if (key.asymmetricKeyType !== "rsa" || !verify("RSA-SHA256", Buffer.concat([signatureContext, uint32(signedData.length), signedData, archive]), key, proof.get(2)!)) throw invalid()
    return { archive, publicKey, id: chromeID(publicKey) }
  } catch {
    throw invalid()
  }
}

export function chromeZip(entries: ReadonlyArray<readonly [string, Uint8Array]>) {
  const local: Buffer[] = []
  const directory: Buffer[] = []
  let offset = 0
  for (const [name, data] of entries) {
    const filename = Buffer.from(name)
    if (data.length > maximumArchive || offset + data.length > maximumArchive) throw invalid()
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x800, 6)
    header.writeUInt16LE(33, 12)
    header.writeUInt32LE(crc32(data), 14)
    header.writeUInt32LE(data.length, 18)
    header.writeUInt32LE(data.length, 22)
    header.writeUInt16LE(filename.length, 26)
    local.push(header, filename, Buffer.from(data))
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50)
    central.writeUInt16LE(20, 4)
    header.copy(central, 6, 4, 28)
    central.writeUInt32LE(offset, 42)
    directory.push(central, filename)
    offset += header.length + filename.length + data.length
  }
  const central = Buffer.concat(directory)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, central, end])
}

async function extensionContents(root: string) {
  const names = (await readdir(root, { recursive: true })).map((name) => name.split(path.sep).join("/")).sort()
  if (JSON.stringify(names) !== JSON.stringify(["icons", ...BrowserExtension.files].sort())) throw invalid()
  const icons = await lstat(path.join(root, "icons"))
  if (!icons.isDirectory() || icons.isSymbolicLink()) throw invalid()
  const entries = await Promise.all(BrowserExtension.files.map(async (name): Promise<readonly [string, Buffer]> => {
    const file = path.join(root, name)
    const metadata = await lstat(file)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumArchive) throw invalid()
    return [name, await readFile(file)]
  }))
  const manifest: unknown = JSON.parse(entries.find(([name]) => name === "manifest.json")![1].toString())
  if (typeof manifest !== "object" || manifest === null || !("key" in manifest) || typeof manifest.key !== "string") throw invalid()
  return { archive: chromeZip(entries), publicKey: Buffer.from(manifest.key, "base64") }
}

export async function signChromeExtension(binDirectory: string, privateKey: Uint8Array) {
  const { archive, publicKey } = await extensionContents(path.join(binDirectory, BrowserExtension.directory))
  const crx = createChromeCrx(archive, privateKey, publicKey)
  verifyChromeCrx(crx, publicKey)
  await writeFile(path.join(binDirectory, chromeCrxFile), crx, { flag: "wx", mode: 0o644 })
}

export async function hasSignedChromeExtension(binDirectory: string) {
  return verifyChromeExtensionPackage(path.join(binDirectory, chromeCrxFile), path.join(binDirectory, BrowserExtension.directory))
}

export async function verifyChromeExtensionPackage(file: string, extensionDirectory: string) {
  const metadata = await lstat(file).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw error
  })
  if (!metadata) return false
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumArchive + 1024 * 1024) throw invalid()
  const { archive, publicKey } = await extensionContents(extensionDirectory)
  if (!verifyChromeCrx(await readFile(file), publicKey).archive.equals(archive)) throw invalid()
  return true
}

if (import.meta.main) {
  const chunks: Buffer[] = []
  let key: Buffer | undefined
  try {
    if (process.argv.length !== 3) throw invalid()
    let size = 0
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk)
      chunks.push(bytes)
      size += bytes.length
      if (size > 64 * 1024) throw invalid()
    }
    key = Buffer.concat(chunks)
    await signChromeExtension(path.resolve(process.argv[2]), key)
    console.log("completed")
  } catch {
    console.log("consumer-failed")
    process.exitCode = 1
  } finally {
    key?.fill(0)
    for (const chunk of chunks) chunk.fill(0)
  }
}
