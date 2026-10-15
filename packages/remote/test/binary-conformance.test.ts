import { expect, test } from "bun:test"
import path from "node:path"
import {
  CONTRACT_DIGEST,
  schemas,
  create,
  clearField,
  toBinary,
  decodeStrict,
  encodeStrict,
  validateBinary,
  LosslessStringSchema,
  FrameSchema,
  ValueSchema,
  ValueListSchema,
  ClearableUint64Schema,
  encodeLossless,
  decodeLossless,
  WireConnection,
  PeerRole,
  WireLimit,
  StatusSchema,
  CompletionsSchema,
  SubscriptionSnapshotSchema,
  NoticesAddedSchema,
  NoticesRemovedSchema,
  NoticesPresentSchema,
  AttentionDetailSchema,
  AlertDetailSchema,
  BlockedSchema,
  CompletionSchema,
  operations,
  operationIDsByRole,
  publicEvents,
} from "@ycoding-ai/protocol/v5"

test("canonical control collection metadata enforces each current RemoteLimits N/N+1", () => {
  for (const count of [500, 501]) {
    const ids = Array.from({ length: count }, (_, index) => `s${index}`)
    const cases = [
      create(StatusSchema, { running: ids }),
      create(StatusSchema, { attention: ids }),
      create(StatusSchema, { outstanding: { items: ids } }),
      create(StatusSchema, { failed: { items: ids } }),
      create(StatusSchema, { details: { items: ids.map((sessionId) => ({ sessionId })) } }),
    ]
    for (const value of cases) {
      const bytes = toBinary(StatusSchema, value)
      if (count === 500) expect(() => decodeStrict(StatusSchema, bytes)).not.toThrow()
      if (count === 501) expect(() => decodeStrict(StatusSchema, bytes)).toThrow("collection limit")
    }
  }
  for (const count of [200, 201]) {
    const value = create(CompletionsSchema, {
      items: Array.from({ length: count }, (_, index) => ({
        id: `e${index}`,
        sequence: 1n,
        createdMs: 0n,
        sessionId: `s${index}`,
      })),
      more: false,
    })
    if (count === 200) expect(() => encodeStrict(CompletionsSchema, value)).not.toThrow()
    if (count === 201) expect(() => encodeStrict(CompletionsSchema, value)).toThrow("collection limit")
  }
  for (const count of [64, 65]) {
    const value = create(SubscriptionSnapshotSchema, {
      clientId: "c",
      sessionIds: Array.from({ length: count }, (_, index) => `s${index}`),
    })
    if (count === 64) expect(() => encodeStrict(SubscriptionSnapshotSchema, value)).not.toThrow()
    if (count === 65) expect(() => encodeStrict(SubscriptionSnapshotSchema, value)).toThrow("collection limit")
  }
  for (const count of [100, 101]) {
    const ids = Array.from({ length: count }, (_, index) => `n${index}`)
    const values = [
      [
        NoticesAddedSchema,
        create(NoticesAddedSchema, {
          notices: ids.map((id) => ({ id, category: 1, sessionId: "s", createdMs: 0n })),
          total: BigInt(count),
        }),
      ],
      [NoticesRemovedSchema, create(NoticesRemovedSchema, { ids, total: BigInt(count) })],
      [
        NoticesPresentSchema,
        create(NoticesPresentSchema, {
          items: ids.map(() => ({ kind: { case: "offline" as const, value: { atMs: 1n } } })),
        }),
      ],
    ] as const
    for (const [schema, value] of values) {
      if (count === 100) expect(() => encodeStrict(schema, value)).not.toThrow()
      if (count === 101) expect(() => encodeStrict(schema, value)).toThrow("collection limit")
    }
  }
})

test("alert titles preserve 120-code-point, lossless and trim/control/bidi constraints", () => {
  for (const text of ["😀".repeat(120), "\ud800".repeat(120), "title", "inside\ufeffvalue"]) {
    expect(() =>
      encodeStrict(BlockedSchema, create(BlockedSchema, { sessionId: "s", title: encodeLossless(text) })),
    ).not.toThrow()
  }
  for (const text of [
    "😀".repeat(121),
    "\ud800".repeat(121),
    "",
    " title",
    "title ",
    "\ufefftitle",
    "title\ufeff",
    "a\u0000b",
    "a\u0085b",
    "a\u202eb",
    "a\u2067b",
  ]) {
    expect(() =>
      encodeStrict(BlockedSchema, create(BlockedSchema, { sessionId: "s", title: encodeLossless(text) })),
    ).toThrow("title constraint")
  }
  for (const [schema, value] of [
    [AttentionDetailSchema, create(AttentionDetailSchema, { sessionId: "s", title: encodeLossless(" ") })],
    [AlertDetailSchema, create(AlertDetailSchema, { title: encodeLossless(" ") })],
    [
      CompletionSchema,
      create(CompletionSchema, { id: "e", sequence: 1n, createdMs: 0n, sessionId: "s", title: encodeLossless(" ") }),
    ],
  ] as const)
    expect(() => encodeStrict(schema, value)).toThrow("title constraint")
})

const fixtures = path.resolve(import.meta.dir, "../../../protocol/ycoding/v5/testdata")
const vectors = (await Bun.file(path.join(fixtures, "manifest.tsv")).text())
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [name, type, outcome, sender, hex] = line.split("\t")
    if (!name || !type || !outcome || sender === undefined || hex === undefined)
      throw new Error("invalid vector manifest row: missing hex column")
    return { name, type, valid: outcome === "valid", sender: Number(sender) as PeerRole, hex }
  })
const vector = async (name: string) => {
  const fixture = vectors.find((fixture) => fixture.name === name)
  if (!fixture) throw new Error(`missing fixture: ${name}`)
  return new Uint8Array(Buffer.from(fixture.hex, "hex"))
}

for (const fixture of vectors) {
  test(`independent ${fixture.valid ? "golden" : "negative"}: ${fixture.name}`, async () => {
    const bytes = await vector(fixture.name)
    const schema = schemas.find((schema) => schema.typeName === fixture.type)
    if (!schema) throw new Error(`missing fixture schema: ${fixture.type}`)
    if (fixture.valid) {
      const value = decodeStrict(schema, bytes)
      expect(encodeStrict(schema, value)).toEqual(bytes)
      return
    }
    if (fixture.sender) {
      expect(() => new WireConnection().observe(bytes, fixture.sender, 0)).toThrow()
      return
    }
    expect(() => validateBinary(fixture.type, bytes)).toThrow()
  })
}

test("duplicate singular command is rejected", () => {
  expect(() => decodeStrict(LosslessStringSchema, Uint8Array.of(10, 0, 10, 0))).toThrow()
})

test("unknown command field is rejected", () => {
  expect(() => decodeStrict(LosslessStringSchema, Uint8Array.of(10, 0, 24, 1))).toThrow()
})

test("canonical codecs preserve exact JS units and use scalar UTF-8 only when possible", async () => {
  for (const [name, value] of [
    ["empty-string", ""],
    ["scalar-string", "A\ufeff😀"],
    ["lone-high", "\ud800"],
    ["lone-low", "\udc00"],
    ["mixed-units", "A\ufffe\udbff\udfff\ud800"],
  ] as const) {
    const encoded = encodeLossless(value)
    expect(encodeStrict(LosslessStringSchema, encoded)).toEqual(await vector(name))
    expect(decodeLossless(encoded)).toBe(value)
  }
  expect(() => decodeLossless(encodeLossless("😀"), 1)).toThrow("string unit limit")
})

test("presence, explicit clears, exact uint64 and negative zero survive", async () => {
  expect(decodeStrict(ClearableUint64Schema, await vector("bigint")).state).toEqual({
    case: "value",
    value: 18446744073709551615n,
  })
  const bytes = encodeStrict(ValueSchema, create(ValueSchema, { kind: { case: "number", value: -0 } }))
  const decoded = decodeStrict(ValueSchema, bytes)
  expect(decoded.kind.case === "number" && Object.is(decoded.kind.value, -0)).toBe(true)
})

async function connected(client = PeerRole.LOCAL_CLIENT, server = PeerRole.SERVER) {
  const state = new WireConnection(client, server)
  const hello = decodeStrict(FrameSchema, await vector("hello"))
  if (hello.body.case === "hello") hello.body.value.role = client
  const ready = decodeStrict(FrameSchema, await vector("ready"))
  if (ready.body.case === "ready") ready.body.value.role = server
  state.observe(toBinary(FrameSchema, hello), client, 0)
  state.observe(toBinary(FrameSchema, ready), server, 1)
  state.observe(await vector("ping"), client, 2)
  return state
}

test("handshake establishes epochs and rejects repeated/stale/missing/wrong-direction frames without corrupting state", async () => {
  const state = await connected()
  expect(() => state.observe(awaitBytes.hello, PeerRole.LOCAL_CLIENT, 3)).toThrow()
  for (const name of [
    "request",
    "result",
    "error",
    "events",
    "bulk-start",
    "bulk-piece",
    "bulk-end",
    "bulk-error",
    "ping",
    "pong",
    "cancel",
    "credit",
    "priority",
    "inventory_invalidated",
    "status",
    "completions",
    "blocked",
    "resync_required",
    "failure",
  ]) {
    const fixture = vectors.find((fixture) => fixture.name === name)
    if (!fixture) throw new Error(`missing fixture: ${name}`)
    const bytes = await vector(name)
    expect(state.observe(bytes, fixture.sender, 3).revision).toBe(5)
    const frame = decodeStrict(FrameSchema, bytes)
    frame.connectionEpoch = "stale"
    expect(() => state.observe(toBinary(FrameSchema, frame), fixture.sender, 4)).toThrow("connection epoch")
    clearField(frame, FrameSchema.field.connectionEpoch)
    expect(() => state.observe(toBinary(FrameSchema, frame), fixture.sender, 4)).toThrow()
  }
  expect(() => state.observe(awaitBytes.request, PeerRole.SERVER, 4)).toThrow("direction")
  const remote = await connected(PeerRole.REMOTE_CLIENT, PeerRole.RELAY)
  expect(remote.observe(await vector("notice"), PeerRole.RELAY, 3).revision).toBe(5)
  const agent = await connected(PeerRole.AGENT, PeerRole.RELAY)
  expect(agent.observe(await vector("subscription_snapshot"), PeerRole.RELAY, 3).revision).toBe(5)
})
const awaitBytes = { hello: await vector("hello"), request: await vector("request") }

test("handshake rejects digest/revision/window mismatch and enforces both 5-second deadlines", async () => {
  for (const mutate of [
    (frame: ReturnType<typeof create<typeof FrameSchema>>) => {
      frame.revision = 6
    },
    (frame: ReturnType<typeof create<typeof FrameSchema>>) => {
      if (frame.body.case !== "hello") throw new Error("fixture")
      const byte = frame.body.value.contractDigest[0]
      if (byte === undefined) throw new Error("missing fixture digest")
      frame.body.value.contractDigest[0] = byte ^ 1
    },
    (frame: ReturnType<typeof create<typeof FrameSchema>>) => {
      if (frame.body.case !== "hello" || !frame.body.value.receiveWindows) throw new Error("fixture")
      frame.body.value.receiveWindows.normalBytes = 1048577n
    },
  ]) {
    const frame = decodeStrict(FrameSchema, await vector("hello"))
    mutate(frame)
    expect(() => new WireConnection().observe(toBinary(FrameSchema, frame), PeerRole.LOCAL_CLIENT, 0)).toThrow()
  }
  const state = new WireConnection()
  state.observe(await vector("hello"), PeerRole.LOCAL_CLIENT, 0)
  const ready = await vector("ready")
  expect(() => state.observe(ready, PeerRole.SERVER, 5000)).toThrow("handshake timeout")
  const confirm = new WireConnection()
  confirm.observe(await vector("hello"), PeerRole.LOCAL_CLIENT, 0)
  confirm.observe(ready, PeerRole.SERVER, 1)
  const ping = await vector("ping")
  expect(() => confirm.observe(ping, PeerRole.LOCAL_CLIENT, 5001)).toThrow("handshake timeout")
  expect(CONTRACT_DIGEST).toHaveLength(64)
})

test("depth and field-count exact boundaries remain accepted", () => {
  let value = create(ValueSchema, { kind: { case: "null", value: {} } })
  for (let index = 1; index < 64; index++)
    value = create(ValueSchema, { kind: { case: "list", value: { items: [value] } } })
  expect(() => encodeStrict(ValueSchema, value)).not.toThrow()
  value = create(ValueSchema, { kind: { case: "list", value: { items: [value] } } })
  expect(() => encodeStrict(ValueSchema, value)).toThrow("depth limit")
  const list = create(ValueListSchema, {
    items: Array.from({ length: 32768 }, () => ({ kind: { case: "null" as const, value: {} } })),
  })
  expect(() => encodeStrict(ValueListSchema, list)).not.toThrow()
})

test("inline/chunk/event/complete-frame byte bounds reject N+1 before dispatch", async () => {
  const state = await connected()
  const request = decodeStrict(FrameSchema, await vector("request"))
  if (request.body.case !== "request") throw new Error("fixture")
  for (const count of [WireLimit.INLINE_BODY_BYTES - 1, WireLimit.INLINE_BODY_BYTES]) {
    request.body.value.payload = new Uint8Array(count)
    expect(state.observe(toBinary(FrameSchema, request), PeerRole.LOCAL_CLIENT, 3).revision).toBe(5)
  }
  request.body.value.payload = new Uint8Array(WireLimit.INLINE_BODY_BYTES + 1)
  expect(() => state.observe(toBinary(FrameSchema, request), PeerRole.LOCAL_CLIENT, 3)).toThrow("request bounds")
  const piece = decodeStrict(FrameSchema, await vector("bulk-piece"))
  if (piece.body.case !== "bulkPiece") throw new Error("fixture")
  piece.body.value.data = new Uint8Array(WireLimit.BULK_PIECE_BYTES)
  expect(state.observe(toBinary(FrameSchema, piece), PeerRole.SERVER, 3).revision).toBe(5)
  piece.body.value.data = new Uint8Array(WireLimit.BULK_PIECE_BYTES + 1)
  expect(() => state.observe(toBinary(FrameSchema, piece), PeerRole.SERVER, 3)).toThrow("bulk piece bounds")
  expect(() => state.observe(new Uint8Array(WireLimit.CLIENT_FRAME_BYTES + 1), PeerRole.LOCAL_CLIENT, 3)).toThrow(
    "frame byte limit",
  )
  expect(() => state.observe(new Uint8Array(WireLimit.SERVER_FRAME_BYTES + 1), PeerRole.SERVER, 3)).toThrow(
    "frame byte limit",
  )
  const events = decodeStrict(FrameSchema, await vector("events"))
  if (events.body.case !== "eventBatch") throw new Error("fixture")
  const record = events.body.value.events[0]
  if (!record) throw new Error("missing fixture event")
  events.body.value.events = Array.from({ length: 64 }, () => record)
  expect(state.observe(toBinary(FrameSchema, events), PeerRole.SERVER, 3).revision).toBe(5)
  events.body.value.events.push(record)
  expect(() => state.observe(toBinary(FrameSchema, events), PeerRole.SERVER, 3)).toThrow("event batch bounds")
})

test("handshake, tiny control, event bytes, bulk announcement/end and all frame headers obey their exact bounds", async () => {
  const hello = decodeStrict(FrameSchema, await vector("hello"))
  if (hello.body.case !== "hello") throw new Error("fixture")
  hello.body.value.contractDigest = new Uint8Array(WireLimit.HANDSHAKE_BYTES)
  const oversizedHello = toBinary(FrameSchema, hello)
  expect(() => new WireConnection().observe(oversizedHello, PeerRole.LOCAL_CLIENT, 0)).toThrow("handshake byte limit")
  const state = await connected()
  const tiny = decodeStrict(FrameSchema, await vector("ping"))
  tiny.connectionEpoch = "x".repeat(WireLimit.TINY_FRAME_BYTES)
  expect(() => state.observe(toBinary(FrameSchema, tiny), PeerRole.LOCAL_CLIENT, 3)).toThrow("tiny byte limit")
  const missingLedger = decodeStrict(FrameSchema, await vector("request"))
  clearField(missingLedger, FrameSchema.field.ledger)
  expect(() => state.observe(toBinary(FrameSchema, missingLedger), PeerRole.LOCAL_CLIENT, 3)).toThrow("ledger header")
  missingLedger.ledger = 1
  missingLedger.deliveryOrdinal = 0n
  expect(() => state.observe(toBinary(FrameSchema, missingLedger), PeerRole.LOCAL_CLIENT, 3)).toThrow("ledger header")
  const start = decodeStrict(FrameSchema, await vector("bulk-start"))
  if (start.body.case !== "bulkStart") throw new Error("fixture")
  start.body.value.byteCount = BigInt(WireLimit.BULK_MESSAGE_BYTES)
  start.body.value.chunkCount = WireLimit.BULK_PIECES
  expect(state.observe(toBinary(FrameSchema, start), PeerRole.SERVER, 3).revision).toBe(5)
  start.body.value.byteCount++
  expect(() => state.observe(toBinary(FrameSchema, start), PeerRole.SERVER, 3)).toThrow("bulk announcement bounds")
  start.body.value.byteCount--
  start.body.value.chunkCount++
  expect(() => state.observe(toBinary(FrameSchema, start), PeerRole.SERVER, 3)).toThrow("bulk announcement bounds")
  const end = decodeStrict(FrameSchema, await vector("bulk-end"))
  if (end.body.case !== "bulkEnd") throw new Error("fixture")
  end.body.value.byteCount = BigInt(WireLimit.BULK_MESSAGE_BYTES) + 1n
  expect(() => state.observe(toBinary(FrameSchema, end), PeerRole.SERVER, 3)).toThrow("bulk end bounds")
  const event = decodeStrict(FrameSchema, await vector("events"))
  if (event.body.case !== "eventBatch") throw new Error("fixture")
  const payload = event.body.value.events[0]?.event
  if (!payload) throw new Error("missing fixture event payload")
  for (const delta of [-1, 0, 1]) {
    const size = WireLimit.EVENT_BATCH_BYTES + delta
    payload.payload = new Uint8Array(size - 128)
    payload.payload = new Uint8Array(payload.payload.length + size - toBinary(FrameSchema, event).length)
    const encoded = toBinary(FrameSchema, event)
    expect(encoded.length).toBe(size)
    if (delta <= 0) expect(state.observe(encoded, PeerRole.SERVER, 3).revision).toBe(5)
    if (delta > 0) expect(() => state.observe(encoded, PeerRole.SERVER, 3)).toThrow("event batch bounds")
  }
})

test("TEST-027 descriptor membership is exhaustive for operations, fields, oneofs and events", () => {
  expect(operations).toHaveLength(222)
  expect(new Set(operations.map((operation) => operation.operationId)).size).toBe(222)
  expect(new Set(operations.map((operation) => operation.diagnosticName)).size).toBe(222)
  const typeNames = new Set(schemas.map((schema) => schema.typeName))
  expect(typeNames.size).toBe(schemas.length)
  for (const operation of operations) {
    for (const type of [operation.requestType, operation.resultType, ...operation.errorTypes])
      expect(typeNames.has(type), `${operation.diagnosticName} references missing schema ${type}`).toBe(true)
    expect(operation.roles.length).toBeGreaterThan(0)
  }
  expect(operationIDsByRole[PeerRole.LOCAL_CLIENT]).toHaveLength(204)
  expect(operationIDsByRole[PeerRole.REMOTE_CLIENT]).toHaveLength(70)
  expect(operationIDsByRole[PeerRole.RELAY]).toHaveLength(66)
  expect(operations.filter((operation) => operation.diagnosticName.startsWith("notice."))).toHaveLength(4)
  for (const schema of schemas) {
    const numbers = schema.fields.map((field) => field.number)
    expect(new Set(numbers).size, `${schema.typeName} has a duplicate field number`).toBe(numbers.length)
  }
  const fieldSnapshot: Record<string, string[]> = {
    "ycoding.v5.Frame": [
      "1:revision",
      "2:connection_epoch",
      "3:ledger",
      "4:delivery_ordinal",
      "5:tiny_consumed_through",
      "10:hello",
      "11:ready",
      "12:request",
      "13:result",
      "14:event_batch",
      "15:control",
      "16:bulk_start",
      "17:bulk_piece",
      "18:bulk_end",
      "19:stream_end",
    ],
    "ycoding.v5.Request": ["1:request_id", "2:operation_id", "3:scope", "4:payload"],
    "ycoding.v5.Result": ["1:request_id", "2:operation_id", "3:settlement", "4:success", "5:error", "6:asset_metadata"],
    "ycoding.v5.EventBatch": ["1:subscription_id", "2:scope", "3:source_epoch", "4:events"],
    "ycoding.v5.BulkStart": [
      "1:request_id",
      "2:transfer_id",
      "3:operation_id",
      "4:type_name",
      "5:content_kind",
      "6:byte_count",
      "7:chunk_count",
    ],
    "ycoding.v5.Value": ["1:null", "2:boolean", "3:number", "4:string", "5:bytes", "6:list", "7:object"],
    "ycoding.v5.Scope": ["1:machine", "2:location", "3:session", "4:form", "5:workspace", "6:global", "7:global_form"],
    "ycoding.v5.Hello": ["1:revision", "2:contract_digest", "3:role", "4:receive_windows"],
  }
  for (const [typeName, expected] of Object.entries(fieldSnapshot)) {
    const schema = schemas.find((candidate) => candidate.typeName === typeName)
    if (!schema) throw new Error(`missing schema ${typeName}`)
    expect(schema.fields.map((field) => `${field.number}:${field.name}`)).toEqual(expected)
  }
  const frame = schemas.find((candidate) => candidate.typeName === "ycoding.v5.Frame")
  expect(frame?.oneofs.map((oneof) => oneof.name)).toEqual(["body"])
  expect(new Set(publicEvents.map((event) => `${event.name}:${event.tag}`)).size).toBe(publicEvents.length)
  const declaredEvents = new Set<string>(publicEvents.map((event) => event.type))
  for (const operation of operations)
    for (const event of operation.eventTypes)
      expect(
        declaredEvents.has(event) || event === "ycoding.v5.PublicEvent" || event === "ycoding.v5.SessionLogItem",
        `${operation.diagnosticName} references undeclared event ${event}`,
      ).toBe(true)
})

test("TEST-030 TS generation twice in scratch copies is byte identical", async () => {
  const { cp, mkdtemp, readdir, rm, symlink } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const root = path.resolve(import.meta.dir, "../../..")
  const runs: Record<string, string>[] = []
  for (let run = 0; run < 2; run++) {
    const scratch = await mkdtemp(path.join(tmpdir(), "ycoding-v5-generation-"))
    try {
      await cp(path.join(root, "protocol"), path.join(scratch, "protocol"), { recursive: true })
      await cp(path.join(root, "packages/protocol/src"), path.join(scratch, "packages/protocol/src"), {
        recursive: true,
      })
      await symlink(path.join(root, "node_modules"), path.join(scratch, "node_modules"), "dir")
      await symlink(
        path.join(root, "packages/protocol/node_modules"),
        path.join(scratch, "packages/protocol/node_modules"),
        "dir",
      )
      const generated = Bun.spawnSync(["bun", path.join(scratch, "packages/protocol/src/v5/generate.ts")], {
        stdout: "pipe",
        stderr: "pipe",
      })
      if (generated.exitCode !== 0) throw new Error(`generator failed: ${new TextDecoder().decode(generated.stderr)}`)
      const output: Record<string, string> = {}
      const collect = async (directory: string) => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name)
          if (entry.isDirectory()) await collect(file)
          else
            output[path.relative(path.join(scratch, "packages/protocol/src/generated/v5"), file)] =
              new Bun.CryptoHasher("sha256").update(await Bun.file(file).arrayBuffer()).digest("hex")
        }
      }
      await collect(path.join(scratch, "packages/protocol/src/generated/v5"))
      runs.push(output)
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }
  expect(Object.keys(runs[0] ?? {}).length).toBeGreaterThan(0)
  expect(runs[1]).toEqual(runs[0])
}, 120_000)
