import { expect, test } from "bun:test"
import path from "node:path"
import { FrameSchema, decodeStrict, encodeStrict, PeerRole, WireConnection } from "@ycoding-ai/protocol/v5"

const vectors = (
  await Bun.file(path.resolve(import.meta.dir, "../../../protocol/ycoding/v5/testdata/manifest.tsv")).text()
)
  .split("\n")
  .filter(Boolean)
  .map((line) => line.split("\t"))

function vector(name: string) {
  const hex = vectors.find((row) => row[0] === name)?.[4]
  if (hex === undefined) throw new Error(`missing fixture hex: ${name}`)
  return new Uint8Array(Buffer.from(hex, "hex"))
}

async function established() {
  const connection = new WireConnection()
  for (const [name, role] of [
    ["hello", PeerRole.LOCAL_CLIENT],
    ["ready", PeerRole.SERVER],
    ["request", PeerRole.LOCAL_CLIENT],
  ] as const) {
    const bytes = vector(name)
    connection.observe(bytes, role, 0)
  }
  return connection
}

const bytes = new Uint8Array(Buffer.from("0805120565706f6368180220019a01030a0173", "hex"))

test("finite event streams end with a server EVENT-ledger StreamEnd", async () => {
  const frame = decodeStrict(FrameSchema, bytes)
  expect(frame.body.case).toBe("streamEnd")
  expect((await established()).observe(bytes, PeerRole.SERVER, 0).body.case).toBe("streamEnd")
})

test("StreamEnd rejects client direction, wrong ledger and duplicate body", async () => {
  expect(() => new WireConnection().observe(bytes, PeerRole.LOCAL_CLIENT, 0)).toThrow("direction")
  const wrong = bytes.slice()
  wrong[10] = 1
  expect(() => new WireConnection().observe(wrong, PeerRole.SERVER, 0)).toThrow("ledger header")
  expect(() => decodeStrict(FrameSchema, new Uint8Array([...bytes, ...bytes.slice(13)]))).toThrow("duplicate singular")
  const empty = new Uint8Array([...bytes.slice(0, 13), 154, 1, 2, 10, 0])
  expect(() => new WireConnection().observe(empty, PeerRole.SERVER, 0)).toThrow("stream end subscription")
})

test("StreamEnd negative vectors retain their specific rejection reasons", async () => {
  for (const [name, reason, sender] of [
    ["stream-end-client", "direction", PeerRole.LOCAL_CLIENT],
    ["stream-end-duplicate", "duplicate singular", PeerRole.SERVER],
  ] as const) {
    const bytes = vector(name)
    expect(() => new WireConnection().observe(bytes, sender, 0), name).toThrow(reason)
  }
})

test.each([
  [PeerRole.LOCAL_CLIENT, PeerRole.SERVER, PeerRole.SERVER],
  [PeerRole.AGENT, PeerRole.RELAY, PeerRole.AGENT],
  [PeerRole.REMOTE_CLIENT, PeerRole.RELAY, PeerRole.RELAY],
])("finite completion is accepted on the authenticated sender hop %s/%s/%s", async (client, server, sender) => {
  const connection = new WireConnection(client, server)
  const hello = decodeStrict(FrameSchema, vector("hello"))
  const ready = decodeStrict(FrameSchema, vector("ready"))
  if (hello.body.case !== "hello" || ready.body.case !== "ready") throw new Error("missing handshake fixture")
  hello.body.value.role = client
  ready.body.value.role = server
  connection.observe(encodeStrict(FrameSchema, hello), client, 0)
  connection.observe(encodeStrict(FrameSchema, ready), server, 0)
  connection.observe(vector("ping"), client, 0)
  expect(connection.observe(bytes, sender, 0).body.case).toBe("streamEnd")
})
