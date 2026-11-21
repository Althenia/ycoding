import { expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { crc32, deflateSync } from "node:zlib"
import { make } from "../src/v5/index.js"
import { Service } from "../src/promise/service.js"
import { fixture } from "../../../rust/crates/runtime/tests/support/launcher-client"

test.each([0, 65536, 65537, 512 * 1024 + 9])(
  "managed attachment read preserves %i bytes and the live Rust connection",
  (length) => checkManagedAttachment(Buffer.alloc(length, 255), "fixture.bin"),
  120_000,
)

test("a large image outside the Session directory is admitted by local file URI and reads back byte-exact", async () => {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(512, 0)
  header.writeUInt32BE(512, 4)
  header[8] = 8
  header[9] = 6
  const image = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.alloc((512 * 4 + 1) * 512), { level: 0 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ])
  expect(image.byteLength).toBeGreaterThanOrEqual(512 * 1024)
  await checkManagedAttachment(image, "large image #%25.png", true, "image/png")
}, 120_000)

async function checkManagedAttachment(bytes: Buffer, name: string, outsideSession = false, mime?: string) {
  const binary = process.env.YCODING_TEST_RUST_RUNTIME
  if (!binary) throw new Error("YCODING_TEST_RUST_RUNTIME must name the built Rust runtime")
  const runtime = await fixture(binary)
  try {
    const directory = await mkdtemp(path.join(runtime.configDir, "attachment-"))
    const file = path.join(outsideSession ? runtime.configDir : directory, name)
    await writeFile(file, bytes)
    const endpoint = await Service.ensure({ file: runtime.file, command: runtime.command("attachments-v5") })
    const client = make({ endpoint, location: { directory } })
    try {
      const session = await client.session.create({ location: { directory } })
      const uri = pathToFileURL(file).href
      if (outsideSession) {
        expect(path.relative(directory, file).startsWith("..")).toBe(true)
        expect(uri).toStartWith("file:///")
        expect(uri).toContain("large%20image%20%23%2525.png")
      }
      const admitted = await client.session.prompt({
        sessionID: session.id,
        id: "msg_attachment_reference",
        text: "Retain this attachment without starting model execution.",
        resume: false,
        files: [{ uri, name }],
      })
      const attachment = admitted.data.files?.[0]
      expect(attachment?.content.type).toBe("managed")
      if (attachment?.content.type !== "managed") throw new Error("Expected a managed attachment")
      expect(attachment.content.bytes).toBe(bytes.length)
      expect(attachment.name).toBe(name)
      if (mime) expect(attachment.mime).toBe(mime)
      expect(await client.session.pending.list({ sessionID: session.id })).toMatchObject([{ id: admitted.id }])
      const epoch = client.transport.connectionEpoch
      for (let repeat = 0; repeat < 3; repeat++) {
        const read = await client.session.attachment.read({ sessionID: session.id, digest: attachment.content.digest })
        expect(read.bytes).toBe(bytes.length)
        if (mime) expect(read.mime).toBe(mime)
        expect(Buffer.from(read.data, "base64").equals(bytes)).toBe(true)
        expect((await client.health.get()).healthy).toBe(true)
        expect(client.transport.connectionEpoch).toBe(epoch)
        expect(client.transport.state).toBe("established")
      }
    } finally {
      client.transport.close()
      expect(client.transport.retainedBytes).toBe(0)
    }
  } finally {
    await runtime.dispose()
  }
}

function pngChunk(type: string, data: Buffer) {
  const payload = Buffer.concat([Buffer.from(type), data])
  const chunk = Buffer.alloc(data.length + 12)
  chunk.writeUInt32BE(data.length, 0)
  payload.copy(chunk, 4)
  chunk.writeUInt32BE(crc32(payload), chunk.length - 4)
  return chunk
}
