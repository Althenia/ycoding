import { expect, test } from "bun:test"
import path from "node:path"
import { WireConnection, PeerRole } from "../src/v5/index.js"

test("digest-bearing negative goldens retain their specific rejection reasons", async () => {
  const vectors = (
    await Bun.file(path.resolve(import.meta.dir, "../../../protocol/ycoding/v5/testdata/manifest.tsv")).text()
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"))
  for (const [name, reason] of [
    ["both-frame-bodies", "duplicate oneof"],
    ["concatenated-frame", "duplicate singular"],
    ["duplicate-command", "duplicate singular"],
    ["hello-epoch", "Hello epoch"],
    ["hello-ledger", "handshake ledger"],
    ["unknown-command", "unknown field"],
  ]) {
    const hex = vectors.find((row) => row[0] === name)?.[4]
    if (hex === undefined) throw new Error(`missing fixture hex: ${name}`)
    const bytes = new Uint8Array(Buffer.from(hex, "hex"))
    expect(() => new WireConnection().observe(bytes, PeerRole.LOCAL_CLIENT, 0)).toThrow(reason)
  }
})
