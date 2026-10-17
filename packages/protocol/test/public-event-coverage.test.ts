import { expect, test } from "bun:test"
import { enumNumbers, messageTags } from "./wire-allocation.js"
import { EventManifest } from "@ycoding-ai/schema/event-manifest"
import { SessionEvent } from "@ycoding-ai/schema/session-event"
import { messages } from "../src/generated/v5/contract.js"
import { operations, publicEvents } from "../src/generated/v5/index.js"
import { publicEventContract, publicEventProto } from "./public-event-contract.js"
import path from "node:path"

test("REQ-WIRE-001/005 public EventBatch membership equals ServerDefinitions, not internal history", async () => {
  expect(publicEvents.map((event) => [event.name, event.durable]).sort()).toEqual(
    EventManifest.ServerDefinitions.map((event) => [event.type, event.durability === "durable"]).sort(),
  )
  expect(publicEvents).toHaveLength(116)
  expect(publicEvents.filter((event) => event.durable)).toHaveLength(58)
  for (const name of [
    "server.connected",
    "log.synced",
    "session.profile.bound",
    "session.usage.recorded",
    "session.provider.request.recorded",
    "session.compaction.replaced",
    "mcp.tools.changed",
    "lsp.updated",
  ])
    expect(
      publicEvents.some((event) => event.name === name),
      name,
    ).toBe(false)
  expect(operations.find((operation) => operation.diagnosticName === "event.subscribe")!.eventTypes).toEqual([
    "ycoding.v5.PublicEvent",
  ])
  expect(operations.find((operation) => operation.diagnosticName === "session.log")!.eventTypes).toEqual([
    "ycoding.v5.SessionLogItem",
  ])
  expect(await Bun.file(path.resolve(import.meta.dir, "../../../protocol/ycoding/v5/events.proto")).text()).toBe(
    publicEventProto(),
  )
})

test("REQ-WIRE-005 public durable branches reuse exact SessionLogItem shapes; ephemerals cannot carry durable positions", () => {
  const log = messages["ycoding.v5.SessionLogItem"].fields
  expect(log).toHaveLength(59)
  for (const event of publicEvents) {
    const envelope = messages[event.type as keyof typeof messages]
    expect(envelope, event.name).toBeDefined()
    expect(
      envelope.fields.some((field) => field.name === "durable"),
      event.name,
    ).toBe(event.durable)
    if (event.durable)
      expect(
        log.some((field) => field.target === event.type),
        event.name,
      ).toBe(true)
  }
  expect(publicEventContract().messages.get("PublicEvent")!.fields).toHaveLength(EventManifest.ServerDefinitions.length)
  expect(
    publicEvents.filter((event) => SessionEvent.Definitions.some((definition) => definition.type === event.name)),
  ).toHaveLength(66)
})

test("REQ-WIRE-005 every public event field retains its source type, tag and presence", () => {
  const primitives: Record<string, number> = { bool: 8, double: 1, int64: 3, uint64: 4, string: 9, bytes: 12 }
  const contract = publicEventContract()
  const declarations: Readonly<
    Record<
      string,
      {
        oneofs: number
        fields: readonly {
          tag: number
          name: string
          type: number
          required: boolean
          repeated: boolean
          target?: string
        }[]
      }
    >
  > = messages
  for (const [name, message] of contract.messages) {
    const actual = declarations[`ycoding.v5.${name}`]
    expect(actual, name).toBeDefined()
    expect(actual.oneofs, name).toBe(message.oneof ? 1 : 0)
    expect(
      actual.fields.map((field) => [
        field.tag,
        field.name,
        field.type,
        field.required,
        field.repeated,
        field.target || undefined,
      ]),
      name,
    ).toEqual(
      message.fields.map((field, index) => [
        messageTags(name, message.fields)[index],
        field.name,
        primitives[field.type] ?? (contract.enums.has(field.type) ? 14 : 11),
        field.presence === "required",
        field.presence === "repeated",
        primitives[field.type] ? undefined : `ycoding.v5.${field.type}`,
      ]),
    )
  }
})
