import { remotePayloadCodecs, SessionLogItemSchema, encodeStrict, decodeStrict } from "@ycoding-ai/remote"
import { readWireMessage, writeWireMessage } from "../src/remote/wire"
import type { RemoteRequestOutcome } from "../src/remote/transport"
import { fixtureResult } from "./relay-double"

export function typedFixtureOutcome(operation: string, outcome: RemoteRequestOutcome): RemoteRequestOutcome {
  if (outcome.status !== "ok" || operation.startsWith("notice.")) return outcome
  if (operation === "session.log") {
    const watermark =
      typeof outcome.value === "object" && outcome.value !== null ? Reflect.get(outcome.value, "watermark") : undefined
    const marker = readWireMessage(
      SessionLogItemSchema,
      decodeStrict(
        SessionLogItemSchema,
        encodeStrict(
          SessionLogItemSchema,
          writeWireMessage(SessionLogItemSchema, {
            type: "log.synced",
            aggregateID: "ses_fixture",
            sourceEpoch: "fixture-source",
            ...(watermark === undefined ? {} : { seq: watermark }),
          }),
        ),
      ),
    )
    if (typeof marker !== "object" || marker === null) throw new Error("Expected a typed log watermark")
    return { status: "ok", value: { watermark: Reflect.get(marker, "seq") } }
  }
  const codec = remotePayloadCodecs.get(operation)
  if (!codec) throw new Error(`Unknown fixture operation: ${operation}`)
  const payload = codec.result.encode(writeWireMessage(codec.result.schema, fixtureResult(operation, outcome.value)))
  return { status: "ok", value: readWireMessage(codec.result.schema, codec.result.decode(payload)) }
}
