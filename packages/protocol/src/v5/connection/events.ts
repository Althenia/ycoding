import type { DescMessage } from "@bufbuild/protobuf"
import {
  FrameSchema,
  EventBatchSchema,
  EventRecordSchema,
  TypedPayloadSchema,
  DurablePositionSchema,
  ScopeSchema,
  LedgerClass,
  WireLimit,
  ResyncRequiredSchema,
  ControlSchema,
} from "../../generated/v5/index.js"
import type { EventBatch, EventRecord, Scope } from "../../generated/v5/index.js"

const maximum = (1n << 64n) - 1n

export const lateHeaderReservation =
  scalar(FrameSchema, "deliveryOrdinal", maximum) +
  scalar(FrameSchema, "tinyConsumedThrough", maximum) -
  scalar(FrameSchema, "deliveryOrdinal", 1n) -
  scalar(FrameSchema, "tinyConsumedThrough", 0n)

export function eventReservationBytes(batch: EventBatch, epoch: string) {
  return eventFrameBytes(batch, epoch, maximum, maximum)
}

export function eventFrameBytes(batch: EventBatch, epoch: string, ordinal: bigint, tinyReceipt: bigint) {
  if (!batch.scope) throw new Error("event scope")
  const body =
    field(EventBatchSchema, "subscriptionId", utf8Bytes(batch.subscriptionId)) +
    field(EventBatchSchema, "scope", scopeBytes(batch.scope)) +
    field(EventBatchSchema, "sourceEpoch", utf8Bytes(batch.sourceEpoch)) +
    batch.events.reduce((total, record) => total + field(EventBatchSchema, "events", recordBytes(record)), 0)
  return headerBytes(epoch, LedgerClass.EVENT, ordinal, tinyReceipt) + field(FrameSchema, "eventBatch", body)
}

export function resyncReservationBytes(
  scope: Scope,
  sourceEpoch: string,
  messageID: string | undefined,
  epoch: string,
) {
  const body =
    field(ResyncRequiredSchema, "scope", scopeBytes(scope)) +
    field(ResyncRequiredSchema, "sourceEpoch", utf8Bytes(sourceEpoch)) +
    (messageID === undefined ? 0 : field(ResyncRequiredSchema, "messageId", utf8Bytes(messageID)))
  return (
    headerBytes(epoch, LedgerClass.NORMAL, maximum, maximum) +
    field(FrameSchema, "control", field(ControlSchema, "resyncRequired", body))
  )
}

function headerBytes(epoch: string, ledger: LedgerClass, ordinal: bigint, tinyReceipt: bigint) {
  return (
    scalar(FrameSchema, "revision", BigInt(WireLimit.REVISION)) +
    field(FrameSchema, "connectionEpoch", utf8Bytes(epoch)) +
    scalar(FrameSchema, "ledger", BigInt(ledger)) +
    scalar(FrameSchema, "deliveryOrdinal", ordinal) +
    scalar(FrameSchema, "tinyConsumedThrough", tinyReceipt)
  )
}

function recordBytes(record: EventRecord) {
  if (!record.event) throw new Error("event payload")
  const payload =
    field(TypedPayloadSchema, "typeName", utf8Bytes(record.event.typeName)) +
    field(TypedPayloadSchema, "payload", record.event.payload.length)
  const durable = record.durable
    ? field(
        EventRecordSchema,
        "durable",
        field(DurablePositionSchema, "aggregateId", utf8Bytes(record.durable.aggregateId)) +
          scalar(DurablePositionSchema, "sequence", record.durable.sequence) +
          scalar(DurablePositionSchema, "version", BigInt(record.durable.version)),
      )
    : 0
  return (
    field(EventRecordSchema, "eventId", utf8Bytes(record.eventId)) +
    scalar(EventRecordSchema, "createdMs", record.createdMs) +
    durable +
    field(EventRecordSchema, "event", payload)
  )
}

function scopeBytes(scope: Scope) {
  if (scope.target.case === "session") return field(ScopeSchema, "session", utf8Bytes(scope.target.value))
  if (scope.target.case === "global") return field(ScopeSchema, "global", 0)
  throw new Error("event scope")
}

function field(schema: DescMessage, name: string, bytes: number) {
  return (
    varint(BigInt(schema.fields.find((field) => field.localName === name)!.number * 8 + 2)) +
    varint(BigInt(bytes)) +
    bytes
  )
}

function scalar(schema: DescMessage, name: string, value: bigint) {
  return varint(BigInt(schema.fields.find((field) => field.localName === name)!.number * 8)) + varint(value)
}

function varint(value: bigint) {
  return Math.ceil(BigInt.asUintN(64, value).toString(2).length / 7)
}

function utf8Bytes(value: string) {
  let bytes = 0
  for (const character of value) {
    const point = character.codePointAt(0)!
    bytes += point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4
  }
  return bytes
}
