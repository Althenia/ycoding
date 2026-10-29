import { describe, expect, test } from "bun:test"
import { ccaFsWireMethods } from "../src/remote-control/cca-executor-fs-wire"
import { CcaRpcError } from "../src/remote-control/cca-executor-rpc"

const file = "file:///workspace/a.txt"
const sandbox = { permissions: { type: "disabled" }, windowsSandboxLevel: "disabled" }

function invalid(method: keyof typeof ccaFsWireMethods, params: unknown): { code: number; message: string } {
  try {
    ccaFsWireMethods[method].decode(params)
  } catch (error) {
    if (!(error instanceof CcaRpcError)) throw error
    return { code: error.code, message: error.message }
  }
  throw new Error(`${method} accepted ${JSON.stringify(params)}`)
}

describe("cca executor fs wire decoders", () => {
  test("cover exactly the extended upstream filesystem methods", () => {
    expect(Object.keys(ccaFsWireMethods).sort()).toEqual(
      ["fs/close", "fs/copy", "fs/createDirectory", "fs/open", "fs/readBlock", "fs/remove", "fs/walk", "fs/writeBlock"].sort(),
    )
  })

  test("decode well-formed params, keep explicit options, and drop null optionals", () => {
    expect(ccaFsWireMethods["fs/createDirectory"].decode({ path: file })).toEqual({ path: file })
    expect(
      ccaFsWireMethods["fs/createDirectory"].decode({ path: file, recursive: false, followSymlinks: false, sandbox, extra: 1 }),
    ).toEqual({ path: file, recursive: false, followSymlinks: false, sandbox })
    expect(ccaFsWireMethods["fs/createDirectory"].decode({ path: file, recursive: null, sandbox: null })).toEqual({ path: file })
    expect(ccaFsWireMethods["fs/open"].decode({ handleId: "h", path: file })).toEqual({ handleId: "h", path: file, mode: "read" })
    expect(ccaFsWireMethods["fs/open"].decode({ handleId: "", path: file, mode: "replace", sandbox })).toEqual({
      handleId: "",
      path: file,
      mode: "replace",
      sandbox,
    })
    expect(ccaFsWireMethods["fs/readBlock"].decode({ handleId: "h", offset: 0, len: 1048576 })).toEqual({
      handleId: "h",
      offset: 0,
      len: 1048576,
    })
    const write = ccaFsWireMethods["fs/writeBlock"].decode({ handleId: "h", offset: 7, chunk: Buffer.from("hi").toString("base64") })
    expect({ ...write, chunk: Buffer.from(write.chunk).toString("utf8") }).toEqual({ handleId: "h", offset: 7, chunk: "hi" })
    expect(ccaFsWireMethods["fs/writeBlock"].decode({ handleId: "h", offset: 0, chunk: "" }).chunk.byteLength).toBe(0)
    expect(ccaFsWireMethods["fs/close"].decode({ handleId: "h" })).toEqual({ handleId: "h" })
    const options = { maxDepth: 0, maxDirectories: 1, maxEntries: 2, followDirectorySymlinks: true }
    expect(ccaFsWireMethods["fs/walk"].decode({ path: file, options })).toEqual({ path: file, options })
    expect(ccaFsWireMethods["fs/walk"].decode({ path: file, options: { ...options, pruneHiddenDirectories: true } })).toEqual({
      path: file,
      options: { ...options, pruneHiddenDirectories: true },
    })
    expect(ccaFsWireMethods["fs/remove"].decode({ path: file, recursive: false, force: false, followSymlinks: true })).toEqual({
      path: file,
      recursive: false,
      force: false,
      followSymlinks: true,
    })
    expect(ccaFsWireMethods["fs/copy"].decode({ sourcePath: file, destinationPath: "file:///workspace/b", recursive: true })).toEqual({
      sourcePath: file,
      destinationPath: "file:///workspace/b",
      recursive: true,
    })
  })

  test("reject malformed params with -32602 and serde-shaped messages", () => {
    const cases: Array<[keyof typeof ccaFsWireMethods, unknown, string]> = [
      ["fs/open", undefined, "invalid type: null, expected struct WireFsOpenParams"],
      ["fs/open", [], "invalid type: sequence, expected struct WireFsOpenParams"],
      ["fs/open", { path: file }, "missing field `handleId`"],
      ["fs/open", { handleId: 1, path: file }, "invalid type: integer `1`, expected a string"],
      ["fs/open", { handleId: "h", path: file, mode: "append" }, "unknown variant `append`, expected `read` or `replace`"],
      ["fs/open", { handleId: "h", path: file, mode: null }, "invalid type: null, expected string or map"],
      ["fs/open", { handleId: "h", path: "http://x/a" }, "unsupported path URI scheme `http`"],
      ["fs/open", { handleId: "h", path: file, sandbox: "x" }, 'invalid type: string "x", expected struct WireFileSystemSandboxContext'],
      ["fs/readBlock", { handleId: "h", offset: -1, len: 1 }, "invalid value: integer `-1`, expected u64"],
      ["fs/readBlock", { handleId: "h", offset: 0, len: 1.5 }, "invalid type: floating point `1.5`, expected usize"],
      ["fs/readBlock", { handleId: "h", offset: "0", len: 1 }, 'invalid type: string "0", expected u64'],
      ["fs/readBlock", { handleId: "h", offset: 0 }, "missing field `len`"],
      ["fs/writeBlock", { handleId: "h", offset: 0, chunk: "a!==" }, "Invalid symbol 33, offset 1."],
      ["fs/writeBlock", { handleId: "h", offset: 0, chunk: "abc" }, "Invalid padding"],
      ["fs/writeBlock", { handleId: "h", offset: 0, chunk: 5 }, "invalid type: integer `5`, expected a string"],
      ["fs/close", {}, "missing field `handleId`"],
      ["fs/createDirectory", { path: file, recursive: "yes" }, 'invalid type: string "yes", expected a boolean'],
      ["fs/walk", { path: file }, "missing field `options`"],
      ["fs/walk", { path: file, options: { maxDepth: 1, maxDirectories: 1, maxEntries: 1 } }, "missing field `followDirectorySymlinks`"],
      [
        "fs/walk",
        { path: file, options: { maxDepth: 1, maxDirectories: 1, maxEntries: 1, followDirectorySymlinks: false, pruneHiddenDirectories: null } },
        "invalid type: null, expected a boolean",
      ],
      ["fs/walk", { path: file, options: true }, "invalid type: boolean `true`, expected struct WalkOptions"],
      ["fs/remove", { path: file, force: 1 }, "invalid type: integer `1`, expected a boolean"],
      ["fs/copy", { sourcePath: file, destinationPath: file }, "missing field `recursive`"],
      ["fs/copy", { sourcePath: file, destinationPath: file, recursive: null }, "invalid type: null, expected a boolean"],
      ["fs/copy", { destinationPath: file, recursive: true }, "missing field `sourcePath`"],
    ]
    for (const [method, params, message] of cases) {
      expect({ method, params, ...invalid(method, params) }).toEqual({ method, params, code: -32602, message })
    }
  })

  test("reject malformed path URIs with the url-crate and PathUriParseError messages", () => {
    const os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform
    const cases: Array<[string, string]> = [
      ["relative/a.txt", "invalid URI: relative URL without a base"],
      ["", "invalid URI: relative URL without a base"],
      ["file://[::1/a", "invalid URI: invalid IPv6 address"],
      ["file://exa mple/a", "invalid URI: invalid international domain name"],
      ["http://host:99999/a", "invalid URI: invalid port number"],
      ["http://:80/a", "invalid URI: empty host"],
      ["http://1.2.3.256/a", "invalid URI: invalid IPv4 address"],
      ["https://example.test/a", "unsupported path URI scheme `https`"],
      ["file:///workspace/a?x=1", "query parameters are not allowed in path URIs"],
      ["file:///workspace/a?", "query parameters are not allowed in path URIs"],
      ["file:///workspace/a#top", "fragments are not allowed in path URIs"],
      ["file:///workspace/a#", "fragments are not allowed in path URIs"],
      ["file:///workspace/a%00b", `'file:///workspace/a%00b' is invalid on '${os}'`],
    ]
    for (const [path, message] of cases) {
      expect({ path, ...invalid("fs/open", { handleId: "h", path }) }).toEqual({ path, code: -32602, message })
    }
  })

  test("normalize path URIs as the url crate does", () => {
    const cases: Array<[string, string]> = [
      ["file:///workspace/a/../b/./c.txt", "file:///workspace/b/c.txt"],
      ["file:///workspace/%2E%2e/b", "file:///b"],
      ["file://localhost/workspace/a.txt", "file:///workspace/a.txt"],
      ["file:///c:/work/a.txt", "file:///C:/work/a.txt"],
      ["file:///workspace/a%20b.txt", "file:///workspace/a%20b.txt"],
    ]
    for (const [input, expected] of cases) {
      expect(ccaFsWireMethods["fs/open"].decode({ handleId: "h", path: input }).path).toBe(expected)
    }
    expect(ccaFsWireMethods["fs/copy"].decode({ sourcePath: "file:///a/./b", destinationPath: "file:///a/x/../c", recursive: false })).toEqual({
      sourcePath: "file:///a/b",
      destinationPath: "file:///a/c",
      recursive: false,
    })
  })

  test("reject malformed base64 chunks with the base64-crate messages", () => {
    const cases: Array<[string, string]> = [
      ["a!==", "Invalid symbol 33, offset 1."],
      ["abc", "Invalid padding"],
      ["aGk", "Invalid padding"],
      ["a", "Invalid input length: 1"],
      ["aaaaa", "Invalid input length: 5"],
      ["aGl=", "Invalid last symbol 108, offset 2."],
      ["ab=c", "Invalid symbol 61, offset 2."],
      ["=abc", "Invalid symbol 61, offset 0."],
      ["a===", "Invalid symbol 61, offset 1."],
      ["aa==aa==", "Invalid symbol 61, offset 2."],
      ["aaaa!", "Invalid symbol 33, offset 4."],
      ["a\u00e9==", "Invalid symbol 195, offset 1."],
      ["aGVsbG8gd29ybGQ!", "Invalid symbol 33, offset 15."],
    ]
    for (const [chunk, message] of cases) {
      expect({ chunk, ...invalid("fs/writeBlock", { handleId: "h", offset: 0, chunk }) }).toEqual({ chunk, code: -32602, message })
    }
    expect(Buffer.from(ccaFsWireMethods["fs/writeBlock"].decode({ handleId: "h", offset: 0, chunk: "aGk=" }).chunk).toString()).toBe("hi")
  })

  test("report the first field error in request order before missing fields", () => {
    expect(invalid("fs/readBlock", { len: "x", offset: -2 })).toEqual({ code: -32602, message: 'invalid type: string "x", expected usize' })
    expect(invalid("fs/readBlock", { offset: -2, len: "x" })).toEqual({ code: -32602, message: "invalid value: integer `-2`, expected u64" })
  })
})

describe("cca executor fs wire encoders", () => {
  test("encode block reads as base64 and pass other results through", () => {
    expect(ccaFsWireMethods["fs/readBlock"].encode({ chunk: new Uint8Array(Buffer.from("678")), eof: false })).toEqual({
      chunk: Buffer.from("678").toString("base64"),
      eof: false,
    })
    expect(ccaFsWireMethods["fs/readBlock"].encode({ chunk: new Uint8Array(0), eof: true })).toEqual({ chunk: "", eof: true })
    expect(ccaFsWireMethods["fs/open"].encode({ handleId: "h" })).toEqual({ handleId: "h" })
    for (const method of ["fs/createDirectory", "fs/writeBlock", "fs/close", "fs/remove", "fs/copy"] as const) {
      expect(ccaFsWireMethods[method].encode({})).toEqual({})
    }
    const walk = {
      entries: [{ path: file, kind: "file" as const }],
      errors: [{ path: "file:///workspace/x", message: "Permission denied (os error 13)" }],
      truncated: true,
    }
    expect(ccaFsWireMethods["fs/walk"].encode(walk)).toEqual(walk)
  })

  test("round-trip a written chunk through decode and the read encoder", () => {
    const data = new Uint8Array([0, 255, 1, 254, 127])
    const decoded = ccaFsWireMethods["fs/writeBlock"].decode({ handleId: "h", offset: 0, chunk: Buffer.from(data).toString("base64") })
    expect(ccaFsWireMethods["fs/readBlock"].encode({ chunk: decoded.chunk, eof: true })).toEqual({
      chunk: Buffer.from(data).toString("base64"),
      eof: true,
    })
  })
})
