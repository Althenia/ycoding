import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import {
  create,
  encodeStrict,
  decodeStrict,
  encodeLossless,
  LedgerClass,
  session_todo_list_ResultSchema,
  ConnectorNoticePageSchema,
  ControlSchema,
  BulkStartSchema,
  BulkPieceSchema,
  BulkEndSchema,
  ContentKind,
  ScopeSchema,
  ResultSchema,
  operations,
  event_subscribe_RequestSchema,
  event_subscribe_ResultSchema,
} from "../../../packages/protocol/src/v5"
import type { Frame } from "../../../packages/protocol/src/v5"
import { frameReservation } from "../../../packages/remote/src/index"
import { harness } from "./support/relay"
import { httpBulkFixture } from "./support/http-bulk"
import { createNoticeStorage } from "./notice-storage"

test.each(["message", "asset"] as const)("%s HTTP bulk settles exactly once on its owning socket", async (kind) => {
  const f = await httpBulkFixture(kind)
  expect(f.response.status).toBe(200)
  for (let index = 0; index < Math.ceil(f.data.length / 65536); index++) await f.piece(index)
  await f.end("success")
  await expect(f.reading).resolves.toEqual({ transferID: expect.any(String), bytes: BigInt(f.data.length) })
  f.h.receive("browser")
  const incoming = f.h.collected.get("browser")!
  const decisions = incoming.flatMap((entry) => entry.decisions)
  expect(incoming.filter((entry) => entry.frame?.body.case === "bulkEnd")).toHaveLength(1)
  expect(decisions.filter((entry) => entry.type === "settled")).toEqual([
    expect.objectContaining({ requestID: f.requestID, status: "success" }),
  ])
  const completed = decisions.filter((entry) => entry.type === "bulkComplete")
  expect(completed).toHaveLength(1)
  expect(completed[0]!.data).toEqual(f.data)
  expect(f.h.receive("unrelated").flatMap((entry) => entry.decisions)).toEqual([])
  expect(f.h.close).toEqual([])
  f.browser.releaseBulk(completed[0]!.transferID)
  f.h.relay.closeDevice()
  expect(f.h.relay.reservation.used).toBe(0)
})

test.each(["failure", "truncation"] as const)("message HTTP bulk %s cannot settle successfully", async (kind) => {
  const f = await httpBulkFixture("message")
  await f.piece(0)
  if (kind === "failure") await f.end(f.failure, 65536)
  if (kind === "truncation") f.h.relay.detach("agent")
  await expect(f.reading).rejects.toThrow()
  f.h.receive("browser")
  const decisions = [...f.decisions, ...f.h.collected.get("browser")!.flatMap((entry) => entry.decisions)]
  expect(decisions.filter((entry) => entry.type === "settled")).toEqual([
    expect.objectContaining({ requestID: f.requestID, status: "unknown" }),
  ])
  expect(decisions.some((entry) => entry.type === "bulkComplete")).toBe(false)
  f.h.relay.closeDevice()
  expect(f.h.relay.reservation.used).toBe(0)
})

test("a subscription without an authenticated backend epoch fails closed instead of borrowing Ready", async () => {
  const h = await harness()
  const agent = await h.attach("agent", "agent")
  const client = await h.attach("client")
  const scope = create(ScopeSchema, { target: { case: "session", value: "ses_1" } })
  const operation = operations.find((item) => item.diagnosticName === "event.subscribe")!
  client.request(
    operation.operationId,
    scope,
    encodeStrict(event_subscribe_RequestSchema, create(event_subscribe_RequestSchema, { scope })),
    512,
    0,
  )
  await h.send("client")
  const input = h
    .receive("agent")
    .flatMap((item) => item.decisions)
    .find((item) => item.type === "dispatch")!
  if (input.type !== "dispatch") throw new Error("missing dispatch")
  agent.enqueue(
    {
      case: "result",
      value: create(ResultSchema, {
        requestId: input.requestID,
        operationId: operation.operationId,
        settlement: operation.settlement,
        outcome: {
          case: "success",
          value: {
            typeName: operation.resultType,
            payload: encodeStrict(
              event_subscribe_ResultSchema,
              create(event_subscribe_ResultSchema, { subscriptionId: encodeLossless("accepted") }),
            ),
          },
        },
      }),
    },
    512,
    0,
  )
  await h.send("agent")
  expect(h.close).toContainEqual({ id: "client", code: 1012, reason: "EPOCH" })
  expect(
    h
      .receive("client")
      .flatMap((item) => item.decisions)
      .some((item) => item.type === "settled" && item.status === "success"),
  ).toBe(false)
})

test("remote subscription payloads cannot select a different Session than their authenticated outer scope", async () => {
  const h = await harness()
  await h.attach("agent", "agent")
  const client = await h.attach("client")
  const operation = operations.find((item) => item.diagnosticName === "event.subscribe")!
  client.request(
    operation.operationId,
    create(ScopeSchema, { target: { case: "session", value: "ses_1" } }),
    encodeStrict(
      event_subscribe_RequestSchema,
      create(event_subscribe_RequestSchema, { scope: { target: { case: "session", value: "ses_other" } } }),
    ),
    512,
    0,
  )
  await h.send("client")
  expect(h.close).toContainEqual({ id: "client", code: 4403, reason: "DIRECTION" })
  expect(
    h
      .receive("agent")
      .flatMap((item) => item.decisions)
      .some((item) => item.type === "dispatch"),
  ).toBe(false)
})

test("opaque RPC correlation is per browser, and upstream input waits for downstream consumption", async () => {
  const h = await harness()
  const agent = await h.attach("agent", "agent")
  const first = await h.attach("first")
  const second = await h.attach("second")
  expect(h.request(first)).toBe("1")
  expect(h.request(second)).toBe("1")
  await h.send("first")
  await h.send("second")
  const frames = h.receive("agent")
  const requests = frames.flatMap((entry) => entry.decisions).filter((item) => item.type === "dispatch")
  expect(requests.map((item) => item.requestID)).toEqual(["1", "2"])
  expect(requests[0]!.request.payload).toEqual(requests[1]!.request.payload)
  expect(h.relay.connection("first")!.ledger(LedgerClass.NORMAL).receivedBytes).toBeGreaterThan(0)
  const charge = h.relay.connection("agent")!.ledger(LedgerClass.NORMAL).handedBytes
  expect(charge).toBeGreaterThan(0)
  agent.consume(LedgerClass.NORMAL, frames[0]!.frame!.deliveryOrdinal, 0)
  expect(h.relay.connection("agent")!.ledger(LedgerClass.NORMAL).handedBytes).toBe(charge)
  h.at(25)
  agent.advance(25)
  await h.send("agent")
  expect(h.relay.connection("first")!.ledger(LedgerClass.NORMAL).receivedBytes).toBe(0)
  expect(h.relay.connection("second")!.ledger(LedgerClass.NORMAL).receivedBytes).toBeGreaterThan(0)
  for (const dispatch of requests) agent.enqueue(h.result(dispatch), 512, 25)
  await h.send("agent")
  expect(h.receive("first").flatMap((entry) => entry.decisions)).toContainEqual(
    expect.objectContaining({ type: "settled", requestID: "1", status: "success" }),
  )
  expect(h.receive("second").flatMap((entry) => entry.decisions)).toContainEqual(
    expect.objectContaining({ type: "settled", requestID: "1", status: "success" }),
  )
  expect(h.relay.connection("agent")!.ledger(LedgerClass.NORMAL).receivedBytes).toBeGreaterThan(0)
})

test("owner/device isolation fails before receiving any application frame", async () => {
  const h = await harness()
  await h.attach("agent", "agent")
  await h.attach("foreign", "client", { ownerID: "other" })
  await h.attach("device", "client", { deviceID: "other" })
  expect(h.close).toEqual([
    { id: "foreign", code: 4403, reason: "DIRECTION" },
    { id: "device", code: 4403, reason: "DIRECTION" },
  ])
})

test("reviewed relay peer count and metadata reservations reject the sixty-fifth browser", async () => {
  const h = await harness()
  for (let index = 0; index < 64; index++) await h.attach(`browser-${index}`, "client", {}, undefined, false)
  expect(h.close).toEqual([])
  expect(h.relay.reservation.used).toBe(64 * 1024)
  await h.attach("overflow", "client", {}, undefined, false)
  expect(h.close).toEqual([{ id: "overflow", code: 1009, reason: "LIMIT" }])
  expect(h.relay.reservation.used).toBe(64 * 1024)
  h.relay.closeDevice()
  expect(h.relay.reservation.used).toBe(0)
})

test("reviewed push count window and asynchronous reservation ownership remain bounded", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const delivered: { category: string; overflow?: number }[] = []
  const h = await harness({
    notifyPush: async (_owner, event) => {
      delivered.push(event)
      await gate
      return []
    },
  })
  let agentID = "agent"
  let agent = await h.attach(agentID, "agent")
  const blocked = async (index: number) => {
    const body: Frame["body"] = {
      case: "control",
      value: create(ControlSchema, {
        kind: { case: "blocked", value: { sessionId: `ses_${index}` } },
      }),
    }
    agent.enqueue(body, frameReservation(body), h.now())
    await h.send(agentID)
  }
  for (let index = 0; index < 22; index++) await blocked(index)
  expect(delivered).toHaveLength(21)
  expect(delivered.slice(0, 20).every((event) => event.overflow === undefined)).toBe(true)
  expect(delivered[20]!.overflow).toBe(1)
  const retained = h.relay.reservation.used
  release()
  await h.relay.settleDeliveries()
  expect(retained - h.relay.reservation.used).toBe(21 * 32 * 1024)
  h.relay.detach(agentID)
  h.at(59_999)
  agentID = "renewed"
  agent = await h.attach(agentID, "agent")
  await blocked(22)
  await h.relay.settleDeliveries()
  expect(delivered).toHaveLength(21)
  h.at(60_000)
  await blocked(23)
  await h.relay.settleDeliveries()
  expect(delivered).toHaveLength(22)
  expect(delivered[21]!.overflow).toBeUndefined()
  h.relay.closeDevice()
  expect(h.relay.reservation.used).toBe(0)
})

test("notices are relay-local typed RPCs and survive reconstruction without restored ledgers", async () => {
  const h = await harness()
  await h.attach("agent", "agent")
  const browser = await h.attach("browser")
  h.notices.append([{ category: "agent-completed", sessionID: "ses_1", createdAt: 1 }])
  const id = h.request(browser, "notice.subscribe")
  await h.send("browser")
  const result = h
    .receive("browser")
    .flatMap((entry) => entry.decisions)
    .find((item) => item.type === "settled")!
  expect(result.type).toBe("settled")
  if (result.type !== "settled") throw new Error("result")
  const page = decodeStrict(ConnectorNoticePageSchema, result.payload!.payload)
  expect(page.notice!.kind.case).toBe("added")
  if (page.notice!.kind.case === "added") expect(page.notice!.kind.value.notices[0]!.id).toBe("ntc_1")
  expect(result.requestID).toBe(id)
  expect(
    h
      .receive("agent")
      .flatMap((entry) => entry.decisions)
      .some((item) => item.type === "dispatch"),
  ).toBe(false)
  await h.relay.restore([
    {
      connectionID: "restored",
      role: "client",
      ownerID: "owner",
      deviceID: "device",
      browserSessionID: "browser",
      credentialExpiresAt: 1_000_000,
    },
  ])
  expect(h.close.at(-1)).toEqual({ id: "restored", code: 1012, reason: "EPOCH" })
  expect(h.notices.page().total).toBe(1)
})

test("agent disconnection closes transmitted pending work as unknown and reconnect does not replay", async () => {
  const h = await harness()
  await h.attach("agent", "agent")
  const browser = await h.attach("browser")
  const requestID = h.request(browser)
  await h.send("browser")
  await h.relay.agentClosed({
    connectionID: "agent",
    role: "agent",
    ownerID: "owner",
    deviceID: "device",
    browserSessionID: "agent",
    credentialExpiresAt: 1_000_000,
  })
  expect(h.close).toContainEqual({ id: "browser", code: 1012, reason: "EPOCH" })
  expect(browser.restart(0)).toContainEqual(expect.objectContaining({ type: "settled", requestID, status: "unknown" }))
  await h.attach("replacement", "agent")
  expect(
    h
      .receive("replacement")
      .flatMap((entry) => entry.decisions)
      .some((item) => item.type === "dispatch"),
  ).toBe(false)
})

test("typed bulk is forwarded without endpoint reassembly and stays charged through recipient credit", async () => {
  const h = await harness()
  const agent = await h.attach("agent", "agent")
  const browser = await h.attach("browser")
  h.request(browser)
  await h.send("browser")
  const request = h
    .receive("agent")
    .flatMap((entry) => entry.decisions)
    .find((item) => item.type === "dispatch")!
  if (request.type !== "dispatch") throw new Error("request")
  const payload = encodeStrict(
    session_todo_list_ResultSchema,
    create(session_todo_list_ResultSchema, { data: { items: [] } }),
  )
  const start = create(BulkStartSchema, {
    requestId: request.requestID,
    transferId: "bulk",
    operationId: request.operation.operationId,
    typeName: request.operation.resultType,
    contentKind: ContentKind.TYPED_MESSAGE,
    byteCount: BigInt(payload.length),
    chunkCount: 1,
  })
  for (const body of [
    { case: "bulkStart", value: start },
    { case: "bulkPiece", value: create(BulkPieceSchema, { transferId: "bulk", index: 0, offset: 0n, data: payload }) },
    {
      case: "bulkEnd",
      value: create(BulkEndSchema, {
        transferId: "bulk",
        byteCount: BigInt(payload.length),
        outcome: { case: "success", value: {} },
      }),
    },
  ] as Frame["body"][]) {
    agent.enqueue(body, frameReservation(body), h.now())
    await h.send("agent")
    if (body.case === "bulkStart") {
      h.receive("browser")
      h.at(25)
      browser.advance(25)
      await h.send("browser")
    }
  }
  expect(h.relay.connection("agent")!.bulkRetainedBytes).toBe(0)
  const received = h.receive("browser").flatMap((entry) => entry.decisions)
  expect(received).toContainEqual(expect.objectContaining({ type: "bulkComplete", data: payload }))
  expect(h.relay.connection("browser")!.ledger(LedgerClass.BULK).handedBytes).toBeGreaterThan(0)
  expect(h.relay.connection("agent")!.ledger(LedgerClass.BULK).receivedBytes).toBeGreaterThan(0)
  h.at(50)
  browser.advance(50)
  await h.send("browser")
  expect(h.relay.connection("agent")!.ledger(LedgerClass.BULK).receivedBytes).toBe(0)
})

test.each(["status", "inventoryInvalidated"] as const)(
  "TEST-034 %s fanout retains charge until every authorized recipient consumes it",
  async (kind) => {
    const h = await harness()
    const agent = await h.attach("agent", "agent")
    const first = await h.attach("first")
    const second = await h.attach("second")
    const body: Frame["body"] = {
      case: "control",
      value: create(ControlSchema, {
        kind:
          kind === "status"
            ? { case: "status", value: { running: ["ses_1"], attention: [] } }
            : { case: "inventoryInvalidated", value: {} },
      }),
    }
    agent.enqueue(body, frameReservation(body), 0)
    await h.send("agent")
    const one = h.receive("first").find((item) => item.frame?.ledger === LedgerClass.NORMAL)!.frame!
    const two = h.receive("second").find((item) => item.frame?.ledger === LedgerClass.NORMAL)!.frame!
    const handed = h.relay.connection("first")!.ledger(LedgerClass.NORMAL).handedBytes
    expect(handed).toBeGreaterThan(0)
    expect(h.relay.connection("first")!.ledger(LedgerClass.NORMAL).queuedBytes).toBe(0)
    expect(h.relay.connection("second")!.ledger(LedgerClass.NORMAL).handedBytes).toBe(handed)
    first.consume(LedgerClass.NORMAL, one.deliveryOrdinal, 0)
    h.at(25)
    first.advance(25)
    await h.send("first")
    expect(h.relay.connection("first")!.ledger(LedgerClass.NORMAL).handedBytes).toBe(0)
    expect(h.relay.connection("second")!.ledger(LedgerClass.NORMAL).handedBytes).toBe(handed)
    expect(h.relay.connection("agent")!.ledger(LedgerClass.NORMAL).receivedBytes).toBeGreaterThan(0)
    second.consume(LedgerClass.NORMAL, two.deliveryOrdinal, 25)
    h.at(50)
    second.advance(50)
    await h.send("second")
    expect(h.relay.connection("agent")!.ledger(LedgerClass.NORMAL).receivedBytes).toBe(0)
    expect(h.close).toEqual([])
    h.relay.closeDevice()
    expect(h.relay.reservation.used).toBe(0)
  },
)

test("TEST-035 completion rollback preserves high-water and suppresses notices and push across reconstruction", async () => {
  const database = new Database(":memory:")
  const storage = createNoticeStorage(database)
  let rejectCommit = false
  const pushes: string[] = []
  const h = await harness({
    noticeStorage: {
      ...storage,
      transactionSync: (operation) =>
        database.transaction(() => {
          const result = operation()
          if (rejectCommit) throw new Error("fixture completion commit rejected")
          return result
        })(),
    },
    notifyPush: async (_, event) => {
      pushes.push("sessionID" in event ? event.sessionID : event.category)
      return []
    },
  })
  const completion = (sequence: bigint): Frame["body"] => ({
    case: "control",
    value: create(ControlSchema, {
      kind: {
        case: "completions",
        value: {
          items: [{ id: `receipt-${sequence}`, sequence, sessionId: "ses_1", createdMs: sequence }],
          more: false,
        },
      },
    }),
  })
  try {
    const agent = await h.attach("agent", "agent")
    await h.attach("browser")
    agent.enqueue(completion(1n), frameReservation(completion(1n)), h.now())
    await h.send("agent")
    expect(storage.kv.get<number>("completion:ses_1")).toBe(1)
    expect(storage.kv.get<boolean>("completionSync")).toBe(true)
    expect(h.notices.page().total).toBe(0)
    expect(pushes).toEqual([])
    rejectCommit = true
    agent.enqueue(completion(2n), frameReservation(completion(2n)), h.now())
    await h.send("agent")
    expect(storage.kv.get<number>("completion:ses_1")).toBe(1)
    expect(h.notices.page().total).toBe(0)
    expect(h.notices.unavailable()).toBe(true)
    expect(pushes).toEqual([])
    rejectCommit = false
    h.relay.closeDevice()
    expect(h.relay.reservation.used).toBe(0)
    const recovered = await harness({
      noticeStorage: storage,
      notifyPush: async (_, event) => {
        pushes.push("sessionID" in event ? event.sessionID : event.category)
        return []
      },
    })
    try {
      const successor = await recovered.attach("successor", "agent")
      const browser = await recovered.attach("reconnected")
      recovered.request(browser, "notice.subscribe")
      await recovered.send("reconnected")
      recovered.receive("reconnected")
      for (let retry = 0; retry < 2; retry++) {
        successor.enqueue(completion(2n), frameReservation(completion(2n)), recovered.now())
        await recovered.send("successor")
      }
      expect(storage.kv.get<number>("completion:ses_1")).toBe(2)
      expect(recovered.notices.page()).toEqual({
        notices: [{ id: "ntc_1", category: "agent-completed", sessionID: "ses_1", createdAt: 2 }],
        total: 1,
      })
      expect(pushes).toEqual(["ses_1"])
      const notices = recovered
        .receive("reconnected")
        .filter((entry) => entry.frame?.body.case === "control" && entry.frame.body.value.kind.case === "notice")
      expect(
        notices.filter(
          (entry) =>
            entry.frame?.body.case === "control" &&
            entry.frame.body.value.kind.case === "notice" &&
            entry.frame.body.value.kind.value.kind.case === "added",
        ),
      ).toHaveLength(1)
    } finally {
      recovered.relay.closeDevice()
      expect(recovered.relay.reservation.used).toBe(0)
    }
    const state = database.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    expect(state.map((row) => row.name).sort()).toEqual([
      "attention_alert",
      "fixture_kv",
      "notice",
      "notice_sync",
      "sqlite_sequence",
    ])
    expect(
      database
        .query("PRAGMA table_info(notice)")
        .all()
        .map((row) => (row as { name: string }).name),
    ).toEqual(["seq", "category", "session_id", "created_at"])
    expect(database.query("SELECT key, value FROM fixture_kv ORDER BY key").all()).toEqual([
      { key: "completion:ses_1", value: "2" },
      { key: "completionSync", value: "true" },
    ])
  } finally {
    h.relay.closeDevice()
    expect(h.relay.reservation.used).toBe(0)
    database.close()
  }
})

test.each(["hello", "confirm"])(
  "status skips a client in %s and replays only the latest cache after establishment",
  async (phase) => {
    const h = await harness()
    const agent = await h.attach("agent", "agent")
    await h.attach("established")
    const joining = await h.attach("joining", "client", {}, undefined, false)
    if (phase === "confirm") {
      joining.start(0)
      await h.send("joining")
      h.receive("joining")
    }
    for (const session of ["ses_old", "ses_latest"]) {
      const body: Frame["body"] = {
        case: "control",
        value: create(ControlSchema, { kind: { case: "status", value: { running: [session], attention: [] } } }),
      }
      agent.enqueue(body, frameReservation(body), 0)
      await h.send("agent")
    }
    expect(h.close).toEqual([])
    expect(h.receive("joining")).toEqual([])
    const live = h
      .receive("established")
      .flatMap((entry) =>
        entry.frame?.body.case === "control" && entry.frame.body.value.kind.case === "status"
          ? [entry.frame.body.value.kind.value.running]
          : [],
      )
    expect(live).toEqual([["ses_old"], ["ses_latest"]])
    if (phase === "hello") {
      joining.start(0)
      await h.send("joining")
      h.receive("joining")
    }
    await h.send("joining")
    const replay = h
      .receive("joining")
      .flatMap((entry) =>
        entry.frame?.body.case === "control" && entry.frame.body.value.kind.case === "status"
          ? [entry.frame.body.value.kind.value.running]
          : [],
      )
    expect(replay).toEqual([["ses_latest"]])
    expect(h.relay.connection("joining")!.state).toBe("established")
    expect(h.close).toEqual([])
  },
)

test.each(["hello", "confirm"])("inventory invalidation does not recycle a client in %s", async (phase) => {
  const h = await harness()
  const agent = await h.attach("agent", "agent")
  await h.attach("established")
  const joining = await h.attach("joining", "client", {}, undefined, false)
  if (phase === "confirm") {
    joining.start(0)
    await h.send("joining")
    h.receive("joining")
  }
  const body: Frame["body"] = {
    case: "control",
    value: create(ControlSchema, { kind: { case: "inventoryInvalidated", value: {} } }),
  }
  agent.enqueue(body, frameReservation(body), 0)
  await h.send("agent")
  expect(h.close).toEqual([])
  expect(h.receive("joining")).toEqual([])
  expect(
    h
      .receive("established")
      .some(
        (entry) => entry.frame?.body.case === "control" && entry.frame.body.value.kind.case === "inventoryInvalidated",
      ),
  ).toBe(true)
  if (phase === "hello") {
    joining.start(0)
    await h.send("joining")
    h.receive("joining")
  }
  await h.send("joining")
  h.receive("joining")
  expect(h.relay.connection("joining")!.state).toBe("established")
})

test("aggregate reservation caps retained input and every socket-handed fanout frame before per-peer windows exhaust", async () => {
  const h = await harness()
  const agent = await h.attach("agent", "agent")
  for (let index = 0; index < 64; index++) await h.attach(`browser-${index}`)
  await h.attach("excess")
  expect(h.close).toContainEqual({ id: "excess", code: 1009, reason: "LIMIT" })
  for (let index = 0; index < 14; index++) {
    const body: Frame["body"] = {
      case: "control",
      value: create(ControlSchema, {
        kind: {
          case: "status",
          value: { running: Array.from({ length: 500 }, (_, item) => `ses_${item}_${"x".repeat(100)}`), attention: [] },
        },
      }),
    }
    agent.enqueue(body, frameReservation(body), 0)
    await h.send("agent")
    expect(h.relay.reservation.used).toBeLessThanOrEqual(32 * 1024 * 1024)
  }
  expect(h.close.some((entry) => entry.id !== "excess" && entry.reason === "LIMIT")).toBe(true)
  expect(h.close.filter((entry) => entry.id !== "excess").every((entry) => entry.reason === "LIMIT")).toBe(true)
  h.relay.closeDevice()
  expect(h.relay.reservation.used).toBe(0)
})

test("cancellation releases a queued-unsent result without refunding another socket-handed result", async () => {
  const h = await harness()
  const agent = await h.attach("agent", "agent")
  const browser = await h.attach("browser", "client", {}, { normalWindowBytes: 1024 })
  h.request(browser)
  const secondID = h.request(browser)
  await h.send("browser")
  const requests = h
    .receive("agent")
    .flatMap((entry) => entry.decisions)
    .filter((entry) => entry.type === "dispatch")
  for (const request of requests) {
    const body = h.result(request)
    if (body.case !== "result" || body.value.outcome.case !== "success") throw new Error("fixture")
    body.value.outcome.value.payload = encodeStrict(
      session_todo_list_ResultSchema,
      create(session_todo_list_ResultSchema, {
        data: { items: [{ content: encodeLossless("x".repeat(500)), status: 1, priority: 1 }] },
      }),
    )
    agent.enqueue(body, frameReservation(body), 0)
    await h.send("agent")
  }
  const before = h.relay.connection("agent")!.ledger(LedgerClass.NORMAL).receivedBytes
  expect(h.relay.connection("browser")!.ledger(LedgerClass.NORMAL).queuedBytes).toBeGreaterThan(0)
  const first = h.receive("browser").find((entry) => entry.frame?.body.case === "result")!.frame!
  expect(browser.cancel(secondID, 0)).toContainEqual(expect.objectContaining({ type: "settled", status: "unknown" }))
  await h.send("browser")
  expect(h.relay.connection("browser")!.ledger(LedgerClass.NORMAL).queuedBytes).toBe(0)
  expect(h.relay.connection("agent")!.ledger(LedgerClass.NORMAL).receivedBytes).toBeGreaterThan(0)
  expect(h.relay.connection("agent")!.ledger(LedgerClass.NORMAL).receivedBytes).toBeLessThan(before)
  browser.consume(LedgerClass.NORMAL, first.deliveryOrdinal, 0)
  h.at(25)
  browser.advance(25)
  await h.send("browser")
  expect(h.relay.connection("agent")!.ledger(LedgerClass.NORMAL).receivedBytes).toBe(0)
  expect(h.close).toEqual([])
})

test("a result cancelled during fresh awaited authority is a late drop, not delivery or replay", async () => {
  const entered = Promise.withResolvers<void>()
  const authority = Promise.withResolvers<{ ok: true; ownerID: string }>()
  let hold = false
  const h = await harness({
    authorize: async () => {
      if (!hold) return { ok: true, ownerID: "owner" }
      entered.resolve()
      return authority.promise
    },
  })
  const agent = await h.attach("agent", "agent")
  const browser = await h.attach("browser")
  const id = h.request(browser)
  await h.send("browser")
  const dispatch = h
    .receive("agent")
    .flatMap((entry) => entry.decisions)
    .find((entry) => entry.type === "dispatch")!
  if (dispatch.type !== "dispatch") throw new Error("dispatch")
  hold = true
  agent.enqueue(h.result(dispatch), 512, 0)
  const delivery = h.send("agent")
  await entered.promise
  hold = false
  expect(browser.cancel(id, 0)).toContainEqual(expect.objectContaining({ type: "settled", status: "unknown" }))
  await h.send("browser")
  authority.resolve({ ok: true, ownerID: "owner" })
  await delivery
  expect(
    h
      .receive("browser")
      .flatMap((entry) => entry.decisions)
      .some((entry) => entry.type === "settled"),
  ).toBe(false)
  expect(h.relay.connection("agent")!.ledger(LedgerClass.NORMAL).receivedBytes).toBe(0)
  expect(h.close).toEqual([])
})
