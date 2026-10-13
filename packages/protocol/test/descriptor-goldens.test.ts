import { expect, test } from "bun:test"
import path from "node:path"
import {
  WireConnection,
  PeerRole,
  create,
  encodeLossless,
  encodeStrict,
  decodeStrict,
  ProviderUsage_Source,
  ProviderUsage_SourceSchema,
  ProviderUsage_SnapshotSchema,
  ProviderUsage_Status,
  ProviderUsage_Stability,
} from "../src/v5/index.js"
import { ProviderUsage } from "@ycoding-ai/schema/provider-usage"
import { Schema } from "effect"

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

test("Muse response-stream source appends ordinal six and preserves existing source ordinals", () => {
  expect(ProviderUsage_SourceSchema.values.map((value) => [value.name, value.number])).toEqual([
    ["PROVIDERUSAGE_SOURCE_PROVIDER_API", 1],
    ["PROVIDERUSAGE_SOURCE_LOCAL_CLIENT_RPC", 2],
    ["PROVIDERUSAGE_SOURCE_RESPONSE_HEADERS", 3],
    ["PROVIDERUSAGE_SOURCE_PROVIDER_INTERNAL_API", 4],
    ["PROVIDERUSAGE_SOURCE_LOCAL_SESSION", 5],
    ["PROVIDERUSAGE_SOURCE_RESPONSE_STREAM", 6],
  ])
  expect(Schema.decodeUnknownSync(ProviderUsage.Source)("response_stream")).toBe("response_stream")
  const snapshot = create(ProviderUsage_SnapshotSchema, {
    providerID: encodeLossless("muse"),
    label: encodeLossless("Muse (Meta)"),
    status: ProviderUsage_Status.PROVIDERUSAGE_STATUS_AVAILABLE,
    source: ProviderUsage_Source.PROVIDERUSAGE_SOURCE_RESPONSE_STREAM,
    stability: ProviderUsage_Stability.PROVIDERUSAGE_STABILITY_OBSERVED,
    updatedAt: 0n,
    windows: { items: [] },
  })
  const bytes = encodeStrict(ProviderUsage_SnapshotSchema, snapshot)
  expect(decodeStrict(ProviderUsage_SnapshotSchema, bytes).source).toBe(6)
  expect(encodeStrict(ProviderUsage_SnapshotSchema, decodeStrict(ProviderUsage_SnapshotSchema, bytes))).toEqual(bytes)
})
