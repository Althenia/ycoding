import { Buffer } from "node:buffer"
import type { TypedPayload } from "@ycoding-ai/protocol/v5"
import {
  decodeStrict,
  decodeLossless,
  fs_read_ResultSchema,
  session_attachment_read_ResultSchema,
} from "@ycoding-ai/protocol/v5"
import { V5ClientError } from "./error.js"

export function assetResult(
  completion: { data: Uint8Array; result?: TypedPayload } | undefined,
  operation: string,
): unknown {
  if (!completion?.result)
    throw new V5ClientError("unsupported", operation, "Asset metadata is unsupported until contract")
  if (operation === "fs.read") {
    const metadata = decodeStrict(fs_read_ResultSchema, completion.result.payload).data
    if (!metadata || metadata.byteCount !== BigInt(completion.data.length))
      throw new V5ClientError("protocol", operation, "Asset metadata does not match content")
    return completion.data
  }
  const metadata = decodeStrict(session_attachment_read_ResultSchema, completion.result.payload).data
  if (!metadata?.mime || metadata.bytes !== BigInt(completion.data.length))
    throw new V5ClientError("protocol", operation, "Asset metadata does not match content")
  return {
    mime: decodeLossless(metadata.mime),
    bytes: completion.data.length,
    data: Buffer.from(completion.data.buffer, completion.data.byteOffset, completion.data.byteLength).toString(
      "base64",
    ),
  }
}
