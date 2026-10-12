import { Schema } from "effect"
import { SessionMessage } from "../../src/session/message"

const decode = Schema.decodeUnknownSync(SessionMessage.Info)
const encode = Schema.encodeSync(SessionMessage.Info)

export function observationMessageData(input: unknown) {
  const { id: _id, type: _type, ...data } = encode(decode(input))
  if (!Schema.is(Schema.Json)(data)) throw new TypeError("Observation message data must be JSON")
  return data
}
