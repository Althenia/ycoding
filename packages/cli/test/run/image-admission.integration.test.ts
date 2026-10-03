import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { crc32, deflateSync } from "node:zlib"
import { YCoding } from "@ycoding-ai/client/promise"
import { auth, createSession, startServer } from "../remote-harness"

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

test.each(["file", "data"] as const)(
  "admits a large valid PNG through %s input and returns a managed attachment",
  async (kind) => {
    expect(image.byteLength).toBeGreaterThan(7 * 1024 * 1024)
    expect(image.byteLength).toBeLessThan(20 * 1024 * 1024)
    const scratch = path.resolve(import.meta.dir, "../../../../.cache/tmp")
    await mkdir(scratch, { recursive: true })
    const directory = await mkdtemp(path.join(scratch, "large-image-flow-"))
    await writeFile(path.join(directory, "large.png"), image)
    const server = await startServer(directory)
    const client = YCoding.make({ baseUrl: server.base, headers: { authorization: auth } })
    const sessionID = `ses_large_image_${kind}`
    try {
      await createSession(server, sessionID, directory)
      const admitted = await client.session.prompt({
        sessionID,
        id: `msg_large_image_${kind}`,
        text: "Inspect this image.",
        resume: false,
        files: [
          {
            name: "large.png",
            uri:
              kind === "file"
                ? pathToFileURL(path.join(directory, "large.png")).href
                : `data:image/png;base64,${image.toString("base64")}`,
          },
        ],
      })
      const file = admitted.data.files?.[0]
      expect(file).toMatchObject({ name: "large.png", mime: "image/png", content: { type: "managed" } })
      expect(file?.content.bytes).toBeLessThan(image.byteLength)
      expect(await client.session.pending.list({ sessionID })).toMatchObject([{ id: admitted.id }])
      const read = await server.request(`/api/session/${sessionID}/attachment/${file!.content.digest}`)
      expect(read.status).toBe(200)
      const stored = await read.json()
      expect(stored.mime).toBe("image/png")
      expect(Buffer.from(stored.data, "base64").readUInt32BE(16)).toBe(1320)
      expect(Buffer.from(stored.data, "base64").readUInt32BE(20)).toBe(1536)
    } finally {
      await server.close()
      await rm(directory, { recursive: true, force: true })
    }
  },
  30000,
)

function pngChunk(type: string, content: Buffer) {
  const payload = Buffer.concat([Buffer.from(type), content])
  const chunk = Buffer.alloc(content.length + 12)
  chunk.writeUInt32BE(content.length, 0)
  payload.copy(chunk, 4)
  chunk.writeUInt32BE(crc32(payload), chunk.length - 4)
  return chunk
}
