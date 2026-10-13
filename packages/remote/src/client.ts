import { Connection } from "@ycoding-ai/protocol/v5/connection"
import type { Options } from "@ycoding-ai/protocol/v5/connection"
import {
  PeerRole,
  PublicEventSchema,
  SessionLogItemSchema,
  ScopeSchema,
  schemas,
  encodeStrict,
  decodeStrict,
} from "@ycoding-ai/protocol/v5"
import type { TypedPayload, Scope } from "@ycoding-ai/protocol/v5"
import { remoteDescriptors, remoteEventTypes } from "./binary"

export type RemoteConnectionOptions = Pick<Options, "now" | "budgets" | "reservation">
export type RemotePayload = Parameters<typeof encodeStrict>[1]

export function createRemoteConnection(options: RemoteConnectionOptions) {
  return new Connection({
    role: PeerRole.REMOTE_CLIENT,
    peer: PeerRole.RELAY,
    operations: remoteDescriptors,
    eventTypes: remoteEventTypes,
    now: options.now,
    budgets: options.budgets,
    reservation: options.reservation,
  })
}

export const remotePayloadCodecs: ReadonlyMap<
  string,
  {
    operation: (typeof remoteDescriptors)[number]
    request: ReturnType<typeof payloadCodec>
    result: ReturnType<typeof payloadCodec>
    errors: ReadonlyMap<string, ReturnType<typeof payloadCodec>>
  }
> = new Map(
  remoteDescriptors.map((operation) => [
    operation.diagnosticName,
    {
      operation,
      request: payloadCodec(operation.requestType),
      result: payloadCodec(operation.resultType),
      errors: new Map(operation.errorTypes.map((type) => [type, payloadCodec(type)])),
    },
  ]),
)

export function encodeRemoteRequest(operation: string, message: RemotePayload) {
  const codec = remotePayloadCodecs.get(operation)
  if (!codec) throw new Error("Unknown remote operation")
  return codec.request.encode(message)
}

export function decodeRemoteResult<T extends (typeof schemas)[number]>(
  operation: string,
  payload: TypedPayload,
  schema: T,
): ReturnType<typeof decodeStrict<T>>
export function decodeRemoteResult(operation: string, payload: TypedPayload): RemotePayload
export function decodeRemoteResult(operation: string, payload: TypedPayload, schema?: (typeof schemas)[number]) {
  const codec = remotePayloadCodecs.get(operation)
  if (!codec) throw new Error("Unknown remote operation")
  const selected = payload.typeName === codec.result.schema.typeName ? codec.result : codec.errors.get(payload.typeName)
  if (!selected || (schema && schema.typeName !== payload.typeName))
    throw new Error("Remote result type does not match its operation")
  return decodeStrict(schema ?? selected.schema, payload.payload)
}

export function decodeRemoteEvent(payload: TypedPayload) {
  if (payload.typeName === PublicEventSchema.typeName) return decodeStrict(PublicEventSchema, payload.payload)
  if (payload.typeName === SessionLogItemSchema.typeName) return decodeStrict(SessionLogItemSchema, payload.payload)
  throw new Error("Unknown remote event type")
}

export function encodeRemoteScope(scope: Scope) {
  return encodeStrict(ScopeSchema, scope)
}

export function decodeRemoteScope(bytes: Uint8Array) {
  return decodeStrict(ScopeSchema, bytes)
}

function payloadCodec(typeName: string) {
  const schema = schemas.find((schema) => schema.typeName === typeName)
  if (!schema) throw new Error("Missing generated remote payload schema")
  return {
    schema,
    encode(message: RemotePayload) {
      if (message.$typeName !== schema.typeName) throw new Error("Remote payload type does not match its schema")
      return encodeStrict(schema, message)
    },
    decode(bytes: Uint8Array) {
      return decodeStrict(schema, bytes)
    },
  }
}
