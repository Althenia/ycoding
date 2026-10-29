import type { CcaFsExtended } from "@ycoding-ai/core/cca/fs-extended"
import { urlParseErrorText } from "@ycoding-ai/core/cca/http"
import { CcaRpcError } from "./cca-executor-rpc"

export interface CcaFsWireMethod<P, R> {
  readonly decode: (params: unknown) => P
  readonly encode: (result: R) => unknown
}

export interface CcaFsWireMethods {
  readonly "fs/createDirectory": CcaFsWireMethod<CcaFsExtended.CreateDirectoryParams, CcaFsExtended.EmptyResult>
  readonly "fs/open": CcaFsWireMethod<CcaFsExtended.OpenParams, CcaFsExtended.OpenResult>
  readonly "fs/readBlock": CcaFsWireMethod<CcaFsExtended.ReadBlockParams, CcaFsExtended.ReadBlockResult>
  readonly "fs/writeBlock": CcaFsWireMethod<CcaFsExtended.WriteBlockParams, CcaFsExtended.EmptyResult>
  readonly "fs/close": CcaFsWireMethod<CcaFsExtended.CloseParams, CcaFsExtended.EmptyResult>
  readonly "fs/walk": CcaFsWireMethod<CcaFsExtended.WalkParams, CcaFsExtended.WalkResult>
  readonly "fs/remove": CcaFsWireMethod<CcaFsExtended.RemoveParams, CcaFsExtended.EmptyResult>
  readonly "fs/copy": CcaFsWireMethod<CcaFsExtended.CopyParams, CcaFsExtended.EmptyResult>
}

type FieldType = "string" | "path" | "u64" | "usize" | "bool" | "bytes" | "sandbox" | "mode" | "walkOptions"

interface Field {
  readonly name: string
  readonly type: FieldType
  readonly presence: "required" | "nullable" | "omittable" | { readonly default: unknown }
}

const U64_LIMIT = 2 ** 64
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
const PAD = 0x3d
const OS_NAME = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform

const invalidParams = (message: string) => new CcaRpcError(-32602, message)

function unexpected(value: unknown): string {
  if (typeof value === "boolean") return `boolean \`${value}\``
  if (typeof value === "number") {
    return Number.isInteger(value) && Math.abs(value) < U64_LIMIT ? `integer \`${value}\`` : `floating point \`${value}\``
  }
  if (typeof value === "string") return `string ${JSON.stringify(value)}`
  if (Array.isArray(value)) return "sequence"
  return "map"
}

function invalidType(value: unknown, expected: string): CcaRpcError {
  return invalidParams(`invalid type: ${value === null || value === undefined ? "null" : unexpected(value)}, expected ${expected}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function unsigned(value: unknown, expected: "u64" | "usize"): number {
  if (typeof value !== "number" || !Number.isInteger(value) || Math.abs(value) > U64_LIMIT) throw invalidType(value, expected)
  if (value < 0) throw invalidParams(`invalid value: integer \`${value}\`, expected ${expected}`)
  return value
}

export function decodeCcaBase64(value: string): Uint8Array {
  const bytes = Buffer.from(value, "utf8")
  const morsel = (byte: number) => BASE64_ALPHABET.indexOf(String.fromCharCode(byte))
  const invalidByte = (index: number) => invalidParams(`Invalid symbol ${bytes[index]}, offset ${index}.`)
  const remainder = bytes.length % 4
  if (remainder === 1 && bytes[bytes.length - 1] !== PAD && morsel(bytes[bytes.length - 1]) === -1) {
    throw invalidByte(bytes.length - 1)
  }
  const suffixStart = Math.max(0, bytes.length - remainder - (remainder === 0 ? 4 : 0))
  for (let index = 0; index < suffixStart; index++) {
    if (morsel(bytes[index]) === -1) throw invalidByte(index)
  }
  const morsels: number[] = []
  let firstPad: number | undefined
  for (let index = suffixStart; index < bytes.length; index++) {
    if (bytes[index] === PAD) {
      if (index - suffixStart < 2) throw invalidByte(index)
      firstPad ??= index
      continue
    }
    if (firstPad !== undefined) throw invalidByte(firstPad)
    if (morsel(bytes[index]) === -1) throw invalidByte(index)
    morsels.push(morsel(bytes[index]))
  }
  if (bytes.length > 0 && morsels.length < 2) throw invalidParams(`Invalid input length: ${suffixStart + morsels.length}`)
  const pads = firstPad === undefined ? 0 : bytes.length - firstPad
  if ((pads + morsels.length) % 4 !== 0) throw invalidParams("Invalid padding")
  const trailingBits = morsels.length === 2 ? morsels[1] & 0x0f : morsels.length === 3 ? morsels[2] & 0x03 : 0
  if (trailingBits !== 0) {
    const index = suffixStart + morsels.length - 1
    throw invalidParams(`Invalid last symbol ${bytes[index]}, offset ${index}.`)
  }
  return new Uint8Array(Buffer.from(value, "base64"))
}

function base64(value: unknown): Uint8Array {
  if (typeof value !== "string") throw invalidType(value, "a string")
  return decodeCcaBase64(value)
}

function hasNullByte(pathname: string): boolean {
  return /%00/.test(pathname) && !/^\/%00\/bad\/path\/[A-Za-z0-9_-]+$/.test(pathname)
}

function pathUri(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw invalidParams(`invalid URI: ${urlParseErrorText(value)}`)
  }
  if (url.protocol !== "file:") throw invalidParams(`unsupported path URI scheme \`${url.protocol.slice(0, -1)}\``)
  const href = url.href
  const hashIndex = href.indexOf("#")
  if (href.slice(0, hashIndex === -1 ? undefined : hashIndex).includes("?")) {
    throw invalidParams("query parameters are not allowed in path URIs")
  }
  if (hashIndex !== -1) throw invalidParams("fragments are not allowed in path URIs")
  if (hasNullByte(url.pathname)) throw invalidParams(`'${href}' is invalid on '${OS_NAME}'`)
  if (url.host === "") url.pathname = url.pathname.replace(/^(\/*)([a-z])(:|%3[Aa])(?=\/|$)/, (_, slashes: string, drive: string, colon: string) => `${slashes}${drive.toUpperCase()}${colon}`)
  return url.href
}

function decodeValue(type: FieldType, value: unknown): unknown {
  switch (type) {
    case "string":
      if (typeof value !== "string") throw invalidType(value, "a string")
      return value
    case "path":
      if (typeof value !== "string") throw invalidType(value, "a string")
      return pathUri(value)
    case "u64":
    case "usize":
      return unsigned(value, type)
    case "bool":
      if (typeof value !== "boolean") throw invalidType(value, "a boolean")
      return value
    case "bytes":
      return base64(value)
    case "sandbox":
      if (!isRecord(value)) throw invalidType(value, "struct WireFileSystemSandboxContext")
      return value
    case "mode":
      if (typeof value !== "string") throw invalidType(value, "string or map")
      if (value !== "read" && value !== "replace") {
        throw invalidParams(`unknown variant \`${value}\`, expected \`read\` or \`replace\``)
      }
      return value
    default:
      return decodeStruct("WalkOptions", walkOptionFields, value)
  }
}

function decodeStruct(name: string, fields: readonly Field[], value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw invalidType(value, `struct ${name}`)
  const decoded: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    const field = fields.find((item) => item.name === key)
    if (field === undefined) continue
    const item = value[key]
    if (field.presence === "nullable" && item === null) continue
    decoded[key] = decodeValue(field.type, item)
  }
  for (const field of fields) {
    if (Object.hasOwn(value, field.name)) continue
    if (field.presence === "required") throw invalidParams(`missing field \`${field.name}\``)
    if (typeof field.presence === "object") decoded[field.name] = field.presence.default
  }
  return decoded
}

const required = (name: string, type: FieldType): Field => ({ name, type, presence: "required" })
const optional = (name: string, type: FieldType): Field => ({ name, type, presence: "nullable" })
const sandbox = optional("sandbox", "sandbox")

const walkOptionFields: readonly Field[] = [
  required("maxDepth", "usize"),
  required("maxDirectories", "usize"),
  required("maxEntries", "usize"),
  required("followDirectorySymlinks", "bool"),
  { name: "pruneHiddenDirectories", type: "bool", presence: "omittable" },
]

function method<P, R>(name: string, fields: readonly Field[], encode: (result: R) => unknown = (result) => result): CcaFsWireMethod<P, R> {
  return {
    decode: (params) => decodeStruct(name, fields, params) as P,
    encode,
  }
}

export const ccaFsWireMethods: CcaFsWireMethods = {
  "fs/createDirectory": method("WireFsCreateDirectoryParams", [
    required("path", "path"),
    optional("recursive", "bool"),
    optional("followSymlinks", "bool"),
    sandbox,
  ]),
  "fs/open": method("WireFsOpenParams", [
    required("handleId", "string"),
    required("path", "path"),
    { name: "mode", type: "mode", presence: { default: "read" } },
    sandbox,
  ]),
  "fs/readBlock": method<CcaFsExtended.ReadBlockParams, CcaFsExtended.ReadBlockResult>(
    "FsReadBlockParams",
    [required("handleId", "string"), required("offset", "u64"), required("len", "usize")],
    (result) => ({ chunk: Buffer.from(result.chunk.buffer, result.chunk.byteOffset, result.chunk.byteLength).toString("base64"), eof: result.eof }),
  ),
  "fs/writeBlock": method("FsWriteBlockParams", [
    required("handleId", "string"),
    required("offset", "u64"),
    required("chunk", "bytes"),
  ]),
  "fs/close": method("FsCloseParams", [required("handleId", "string")]),
  "fs/walk": method("WireFsWalkParams", [required("path", "path"), required("options", "walkOptions"), sandbox]),
  "fs/remove": method("WireFsRemoveParams", [
    required("path", "path"),
    optional("recursive", "bool"),
    optional("force", "bool"),
    optional("followSymlinks", "bool"),
    sandbox,
  ]),
  "fs/copy": method("WireFsCopyParams", [
    required("sourcePath", "path"),
    required("destinationPath", "path"),
    required("recursive", "bool"),
    sandbox,
  ]),
}
