import { ReservationBudget } from "@ycoding-ai/protocol/v5/connection"
import type { Connection, Decision } from "@ycoding-ai/protocol/v5/connection"

export function takeAsset(
  connection: Connection,
  delivery: Extract<Decision, { type: "bulkComplete"; metadata: object }>,
  owner: ReservationBudget,
) {
  const mime = delivery.metadata.mime!.encoding
  const bytes =
    delivery.data.buffer.byteLength +
    delivery.result.payload.buffer.byteLength +
    (mime.case === "utf16LeUnits" ? mime.value.buffer.byteLength : mime.case === "utf8" ? mime.value.length * 3 : 0) +
    512
  if (!owner.reserve(bytes)) return undefined
  connection.releaseBulk(delivery.transferID)
  let released = false
  return {
    data: delivery.data,
    metadata: delivery.metadata,
    result: delivery.result,
    release() {
      if (released) return
      released = true
      owner.release(bytes)
    },
  }
}
