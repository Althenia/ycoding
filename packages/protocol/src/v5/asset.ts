import type { DescMessage, MessageShape } from "@bufbuild/protobuf"
import { create } from "@bufbuild/protobuf"
import {
  AssetMetadataResultSchema,
  fs_read_ResultSchema,
  session_attachment_read_ResultSchema,
  WireLimit,
} from "../generated/v5/index.js"
import type { AssetMetadataResult } from "../generated/v5/index.js"
import { encodeStrict, decodeStrict, decodeLossless } from "./validate.js"
import { validAssetMime } from "./mime.js"

export function encodeAssetMetadata<M extends DescMessage>(schema: M, metadata: MessageShape<M>) {
  const payload = encodeStrict(schema, metadata)
  const fields = assetFields(schema.typeName, payload)
  const result = create(AssetMetadataResultSchema, {
    metadata: { typeName: schema.typeName, payload },
    mime: fields.mime,
    byteCount: fields.byteCount,
  })
  encodeStrict(AssetMetadataResultSchema, result)
  return result
}

export function validateAssetMetadata(value: AssetMetadataResult, typeName: string, opaque = false) {
  if (
    !value.metadata ||
    value.metadata.typeName !== typeName ||
    value.metadata.payload.length > WireLimit.INLINE_BODY_BYTES ||
    !value.mime ||
    !validAssetMime(decodeLossless(value.mime)) ||
    value.byteCount > BigInt(WireLimit.BULK_MESSAGE_BYTES)
  )
    throw new Error("asset metadata")
  if (opaque) return
  const fields = assetFields(typeName, value.metadata.payload)
  if (fields.byteCount !== value.byteCount || decodeLossless(fields.mime!) !== decodeLossless(value.mime))
    throw new Error("asset metadata mismatch")
}

function assetFields(typeName: string, payload: Uint8Array) {
  if (typeName === fs_read_ResultSchema.typeName) {
    const value = decodeStrict(fs_read_ResultSchema, payload)
    return { mime: value.data!.mime, byteCount: value.data!.byteCount }
  }
  if (typeName === session_attachment_read_ResultSchema.typeName) {
    const value = decodeStrict(session_attachment_read_ResultSchema, payload)
    return { mime: value.data!.mime, byteCount: value.data!.bytes }
  }
  throw new Error("unknown asset metadata type")
}
