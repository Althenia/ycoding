import { expect, test } from "bun:test"
import { create, encodeStrict, decodeStrict, BulkPieceSchema } from "@ycoding-ai/protocol/v5"

test("bulk content is arbitrary raw bytes rather than base64 strings", () => {
  const bytes = new Uint8Array([0, 255, 128, 13, 10])
  const piece = create(BulkPieceSchema, { transferId: "transfer", index: 0, offset: 0n, data: bytes })
  expect(decodeStrict(BulkPieceSchema, encodeStrict(BulkPieceSchema, piece)).data).toEqual(bytes)
})
