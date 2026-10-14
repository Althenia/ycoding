import { remotePayloadCodecs } from "@ycoding-ai/remote"
import { readWireMessage, writeWireMessage } from "../src/remote/wire"
import type { RemoteRequestOutcome } from "../src/remote/transport"
import { fixtureResult } from "./relay-double"

export function typedFixtureOutcome(operation: string, outcome: RemoteRequestOutcome): RemoteRequestOutcome {
  if (outcome.status !== "ok" || operation.startsWith("notice.")) return outcome
  const codec = remotePayloadCodecs.get(operation)
  if (!codec) throw new Error(`Unknown fixture operation: ${operation}`)
  const payload = codec.result.encode(writeWireMessage(codec.result.schema, fixtureResult(operation, outcome.value)))
  return { status: "ok", value: readWireMessage(codec.result.schema, codec.result.decode(payload)) }
}
