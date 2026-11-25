import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { Connection } from "../../../packages/protocol/src/v5/connection"
import {
  create,
  encodeStrict,
  EmptySchema,
  LedgerClass,
  PeerRole,
  ResultSchema,
  ScopeSchema,
  operations,
  session_todo_list_RequestSchema,
  session_todo_list_ResultSchema,
} from "../../../packages/protocol/src/v5"
import { defaultBudgets } from "../../../packages/protocol/src/v5/connection"
import { frameReservation, handoffBinary, receiveBinary, remoteEventTypes, RemoteWebSocketPath } from "../../../packages/remote/src/index"
import type { Decision } from "../../../packages/protocol/src/v5/connection"
import { BinaryRelayAdapter } from "../src/relay/binary-adapter"
import { createNoticeStore } from "../src/relay/notice-store"
import { createNoticeStorage } from "./notice-storage"

class FakeSocket {
  readyState = WebSocket.OPEN
  readonly sent: Uint8Array[] = []
  tags: string[] = []
  attachment: unknown
  send(bytes: Uint8Array) {
    this.sent.push(bytes)
  }
  close() {
    this.readyState = WebSocket.CLOSED
  }
  serializeAttachment(value: unknown) {
    this.attachment = value
  }
  deserializeAttachment() {
    return this.attachment
  }
}

let skew = 0
const clock = () => performance.now() + skew

function adapter() {
  const sockets: FakeSocket[] = []
  const alarms: (number | undefined)[] = []
  Object.assign(globalThis, {
    WebSocketPair: class {
      0 = new FakeSocket()
      1 = new FakeSocket()
    },
  })
  const ctx = {
    id: {},
    acceptWebSocket: (socket: FakeSocket, tags: string[]) => {
      socket.tags = tags
      sockets.push(socket)
    },
    getWebSockets: (tag?: string) => sockets.filter((socket) => !tag || socket.tags.includes(tag)),
    setWebSocketAutoResponse: () => undefined,
    storage: {
      setAlarm: async (time: number) => void alarms.push(time),
      deleteAlarm: async () => void alarms.push(undefined),
    },
    waitUntil: () => undefined,
  }
  const authority = async () => ({ ok: true as const, value: { userID: "owner" } })
  const relay = new BinaryRelayAdapter(
    ctx as unknown as DurableObjectState,
    { idFromName: () => ({ equals: () => true }) } as unknown as DurableObjectNamespace,
    { authorizeClientCommand: authority, authorizeAgentCommand: authority } as never,
    {
      notices: createNoticeStore(createNoticeStorage(new Database(":memory:"))),
      loadOfflineCheck: async () => undefined,
      saveOfflineCheck: async () => undefined,
    },
  )
  async function connect(role: "agent" | "client") {
    const response = await relay.fetch(
      new Request(`https://relay.internal${RemoteWebSocketPath[role]}`, {
        headers: {
          upgrade: "websocket",
          "x-ycoding-protocol": "5",
          "x-ycoding-role": role,
          "x-ycoding-owner": "owner",
          "x-ycoding-device": "device",
          "x-ycoding-browser-session": role,
          "x-ycoding-credential-expires-at": String(Date.now() + 3_600_000),
        },
      }),
    )
    expect(response.status).toBe(101)
    const socket = sockets.at(-1)!
    const peer = new Connection({
      role: role === "agent" ? PeerRole.AGENT : PeerRole.REMOTE_CLIENT,
      peer: PeerRole.RELAY,
      operations,
      eventTypes: remoteEventTypes,
      now: clock(),
    })
    const endpoint = {
      peer,
      send: async () => {
        const frames: Uint8Array[] = []
        handoffBinary(peer, (bytes) => frames.push(bytes), clock())
        for (const bytes of frames) await relay.webSocketMessage(socket as unknown as WebSocket, bytes.slice().buffer)
      },
      receive: (): { decisions: Decision[]; frame?: { ledger: LedgerClass; deliveryOrdinal: bigint } }[] =>
        socket.sent.splice(0).map((bytes) => receiveBinary(peer, bytes.slice().buffer, clock())),
    }
    peer.start(clock())
    await endpoint.send()
    endpoint.receive()
    await endpoint.send()
    endpoint.receive()
    return endpoint
  }
  return { connect, alarms }
}

test("an inbound message that creates a short timer moves the armed alarm ahead of the idle heartbeat", async () => {
  const { connect, alarms } = adapter()
  const agent = await connect("agent")
  const client = await connect("client")
  const idle = alarms.at(-1)!
  expect(idle - Date.now()).toBeGreaterThan(defaultBudgets.pingIntervalMs - 1000)
  expect(idle - Date.now()).toBeLessThanOrEqual(defaultBudgets.pingIntervalMs)

  const operation = operations.find((item) => item.diagnosticName === "session.todo.list")!
  const scope = create(ScopeSchema, { target: { case: "session", value: "ses_1" } })
  client.peer.request(
    operation.operationId,
    scope,
    encodeStrict(
      session_todo_list_RequestSchema,
      create(session_todo_list_RequestSchema, { params: { sessionID: { encoding: { case: "utf8", value: "ses_1" } } } }),
    ),
    512,
    clock(),
  )
  await client.send()
  const dispatch = agent.receive().flatMap((entry) => entry.decisions).find((entry) => entry.type === "dispatch")!
  if (dispatch.type !== "dispatch") throw new Error("Missing dispatch")
  const result = {
    case: "result" as const,
    value: create(ResultSchema, {
      requestId: dispatch.requestID,
      operationId: dispatch.operation.operationId,
      settlement: dispatch.operation.settlement,
      outcome: {
        case: "success",
        value: {
          typeName: dispatch.operation.resultType,
          payload: encodeStrict(
            session_todo_list_ResultSchema,
            create(session_todo_list_ResultSchema, { data: { items: [] } }),
          ),
        },
      },
    }),
  }
  agent.peer.enqueue(result, frameReservation(result), clock())
  await agent.send()
  for (const item of client.receive())
    if (item.frame?.ledger === LedgerClass.NORMAL)
      client.peer.consume(LedgerClass.NORMAL, item.frame.deliveryOrdinal, clock())
  skew = defaultBudgets.creditDelayMs
  client.peer.advance(clock())
  await client.send()

  const armed = alarms.at(-1)!
  expect(armed).toBeLessThan(Date.now() + 2 * defaultBudgets.creditDelayMs)
  expect(armed).toBeLessThan(idle)
})
