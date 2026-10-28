import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { AttachmentReadError, MAX_ATTACHMENT_BYTES, resolveLocalAttachments } from "../../src/prompt/attachment"

const xlsxMime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
const workbookName = "GISX_Renewal_Report Specification List_V.3.0_Draft.xlsx"
let root: string

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ycoding-tui-attachment-"))
})
afterAll(() => rm(root, { recursive: true, force: true }))

function decode(uri: string) {
  const match = /^data:([^;,]*);base64,(.*)$/s.exec(uri)
  if (!match) throw new Error(`Not a base64 data URL: ${uri.slice(0, 40)}`)
  return { mime: match[1], bytes: Buffer.from(match[2], "base64") }
}

test("reads a workbook with spaces and dots on the client and sends its bytes as a data URL", async () => {
  const file = path.join(root, workbookName)
  const bytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(8 * 1024 * 1024, 0xa7)])
  await writeFile(file, bytes)
  const mention = { start: 0, end: 9, text: "[Excel 1]" }

  const [resolved] = (await resolveLocalAttachments([{ uri: pathToFileURL(file).href, name: workbookName, mention, local: true as const }]))!

  expect(resolved.name).toBe(workbookName)
  expect(resolved.mention).toEqual(mention)
  const data = decode(resolved.uri)
  expect(data.mime).toBe(xlsxMime)
  expect(data.bytes.equals(bytes)).toBe(true)
})

test("names a file from its path when the attachment has no display name", async () => {
  const file = path.join(root, "notes v1.2.txt")
  await writeFile(file, "hello\n")

  const [resolved] = (await resolveLocalAttachments([{ uri: pathToFileURL(file).href, local: true as const }]))!

  expect(resolved.name).toBe("notes v1.2.txt")
  expect(decode(resolved.uri)).toMatchObject({ mime: "text/plain" })
})

test("passes data, managed, and remote URIs through unchanged and preserves order", async () => {
  const file = path.join(root, "order.txt")
  await writeFile(file, "x")
  const files = [
    { uri: "data:text/plain;base64,aGk=", name: "a" },
    { uri: pathToFileURL(file).href, name: "b", local: true as const },
    { uri: `ycoding-attachment://sha256/${"a".repeat(64)}`, name: "c" },
  ]

  const resolved = (await resolveLocalAttachments(files))!

  expect(resolved.map((item) => item.name)).toEqual(["a", "b", "c"])
  expect(resolved[0]).toEqual(files[0])
  expect(resolved[2]).toEqual(files[2])
  expect(resolved[1]!.uri.startsWith("data:")).toBe(true)
  expect(resolved[1]).not.toHaveProperty("local")
  expect(await resolveLocalAttachments(undefined)).toBeUndefined()
})

test("rejects a file above the limit locally without reading it", async () => {
  const file = path.join(root, "Too Big V.1.xlsx")
  await writeFile(file, "")
  await truncate(file, MAX_ATTACHMENT_BYTES + 1)

  const error = await resolveLocalAttachments([{ uri: pathToFileURL(file).href, name: "Too Big V.1.xlsx", local: true as const }]).catch(
    (cause: unknown) => cause,
  )

  expect(error).toBeInstanceOf(AttachmentReadError)
  expect((error as Error).message).toBe("Too Big V.1.xlsx is larger than the 20 MiB attachment limit")
})

test("accepts a file of exactly the limit", async () => {
  const file = path.join(root, "exact.bin")
  await writeFile(file, "")
  await truncate(file, MAX_ATTACHMENT_BYTES)

  const [resolved] = (await resolveLocalAttachments([{ uri: pathToFileURL(file).href, local: true as const }]))!

  expect(decode(resolved.uri).bytes.byteLength).toBe(MAX_ATTACHMENT_BYTES)
})

test("rejects a missing file with its name", async () => {
  const file = path.join(root, "Missing File V.1.xlsx")

  const error = await resolveLocalAttachments([{ uri: pathToFileURL(file).href, local: true as const }]).catch((cause: unknown) => cause)

  expect(error).toBeInstanceOf(AttachmentReadError)
  expect((error as Error).message).toBe(`Unable to read ${file}: ENOENT`)
})

test("applies a text line range on the client", async () => {
  const file = path.join(root, "lines.ts")
  await writeFile(file, "one\ntwo\nthree\nfour\nfive\n")
  const ranged = (query: string) => ({ uri: `${pathToFileURL(file).href}${query}`, name: `lines.ts${query}`, local: true as const })

  const [window, open, invalid] = (await resolveLocalAttachments([
    ranged("?start=2&end=3"),
    ranged("?start=4"),
    ranged("?start=0&end=x"),
  ]))!

  expect(decode(window.uri).bytes.toString("utf8")).toBe("two\nthree")
  expect(decode(open.uri).bytes.toString("utf8")).toBe("four\nfive\n")
  expect(decode(invalid.uri).bytes.toString("utf8")).toBe("one\ntwo\nthree\nfour\nfive\n")
  expect(window.name).toBe("lines.ts?start=2&end=3")
})

test("ignores a line range on binary content", async () => {
  const file = path.join(root, "range.bin")
  const bytes = Buffer.from([0, 1, 2, 10, 3, 10, 4])
  await writeFile(file, bytes)

  const [resolved] = (await resolveLocalAttachments([{ uri: `${pathToFileURL(file).href}?start=2&end=2`, local: true as const }]))!

  expect(decode(resolved.uri).bytes.equals(bytes)).toBe(true)
})

test("lists a directory the way the service did", async () => {
  const directory = path.join(root, "listing dir")
  await mkdir(path.join(directory, "zeta"), { recursive: true })
  await mkdir(path.join(directory, "alpha"))
  await writeFile(path.join(directory, "b.txt"), "b")
  await writeFile(path.join(directory, "a.txt"), "a")

  const [resolved] = (await resolveLocalAttachments([{ uri: pathToFileURL(directory).href, local: true as const }]))!

  const data = decode(resolved.uri)
  expect(data.mime).toBe("application/x-directory")
  expect(data.bytes.toString("utf8")).toBe(`alpha${path.sep}\nzeta${path.sep}\na.txt\nb.txt`)
  expect(resolved.name).toBe("listing dir")
})

test("leaves a service-side file mention as a path for the service to resolve", async () => {
  const mention = { uri: "file:///srv/project/src/main.ts?start=1&end=2", name: "src/main.ts#1-2" }

  const [resolved] = (await resolveLocalAttachments([mention]))!

  expect(resolved).toEqual(mention)
})
