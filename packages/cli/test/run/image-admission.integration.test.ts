import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { crc32, deflateSync } from "node:zlib"
import { YCoding } from "@ycoding-ai/client/v5"
import { createSession, startServer } from "../remote-harness"
import { prepareRunFile } from "../../src/run/run"

const header = Buffer.alloc(13)
header.writeUInt32BE(1320, 0)
header.writeUInt32BE(1536, 4)
header[8] = 8
header[9] = 6
const image = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  pngChunk("IHDR", header),
  pngChunk("IDAT", deflateSync(Buffer.alloc((1320 * 4 + 1) * 1536), { level: 0 })),
  pngChunk("IEND", Buffer.alloc(0)),
])

test("admits a large CLI PNG by file reference and returns a readable managed attachment", async () => {
  expect(image.byteLength).toBeGreaterThan(7 * 1024 * 1024)
  expect(image.byteLength).toBeLessThan(20 * 1024 * 1024)
  const scratch = path.resolve(import.meta.dir, "../../../../.cache/tmp")
  await mkdir(scratch, { recursive: true })
  const directory = await mkdtemp(path.join(scratch, "large-image-flow-"))
  const source = path.join(directory, "large image #%.png")
  await writeFile(source, image)
  const prepared = await prepareRunFile(path.basename(source), directory)
  expect(prepared.url).toBe(pathToFileURL(source).href)
  expect(prepared.url.startsWith("file://")).toBe(true)
  expect(prepared.url).not.toContain("data:")
  const server = await startServer(directory)
  const client = YCoding.make({ endpoint: server.endpoint })
  const sessionID = "ses_large_image_file"
  const messageID = "msg_large_image_file"
  let admissionConfirmed = false
  try {
    await createSession(server, sessionID, directory)
    const admitted = await client.session.prompt({
      sessionID,
      id: messageID,
      text: "Inspect this image.",
      resume: false,
      files: [
        {
          name: prepared.filename,
          uri: prepared.url,
        },
      ],
    })
    admissionConfirmed = true
    expect(await Bun.file(source).exists()).toBe(true)
    const file = admitted.data.files?.[0]
    expect(file).toMatchObject({ name: prepared.filename, mime: "image/png", content: { type: "managed" } })
    expect(file?.content.bytes).toBeLessThan(image.byteLength)
    expect(await client.session.pending.list({ sessionID })).toMatchObject([{ id: admitted.id }])
    const stored = await client.session.attachment.read({ sessionID, digest: file!.content.digest })
    expect(stored.mime).toBe("image/png")
    expect(Buffer.from(stored.data, "base64").readUInt32BE(16)).toBe(1320)
    expect(Buffer.from(stored.data, "base64").readUInt32BE(20)).toBe(1536)
  } finally {
    if (!admissionConfirmed)
      admissionConfirmed = await client.session.pending
        .list({ sessionID })
        .then((pending) => pending.some((row) => row.id === messageID))
        .catch(() => false)
    client.transport.close()
    await server.close()
    if (admissionConfirmed) await rm(directory, { recursive: true, force: true })
  }
}, 30000)

function pngChunk(type: string, content: Buffer) {
  const payload = Buffer.concat([Buffer.from(type), content])
  const chunk = Buffer.alloc(content.length + 12)
  chunk.writeUInt32BE(content.length, 0)
  payload.copy(chunk, 4)
  chunk.writeUInt32BE(crc32(payload), chunk.length - 4)
  return chunk
}
