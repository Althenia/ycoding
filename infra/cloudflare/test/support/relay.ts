import { Database } from "bun:sqlite"
import { Connection } from "../../../../packages/protocol/src/v5/connection"
import type { Decision, Options } from "../../../../packages/protocol/src/v5/connection"
import {
  create,
  encodeStrict,
  PeerRole,
  operations,
  ScopeSchema,
  session_todo_list_RequestSchema,
  session_todo_list_ResultSchema,
  ResultSchema,
  EmptySchema,
} from "../../../../packages/protocol/src/v5"
import type { Frame } from "../../../../packages/protocol/src/v5"
import { receiveBinary, handoffBinary, remoteEventTypes } from "../../../../packages/remote/src/index"
import { createRelay } from "../../src/relay/core"
import type { RelayConnection, RelayAuthority, RelayDeps } from "../../src/relay/core"
import { createNoticeStore } from "../../src/relay/notice-store"
import type { NoticeStorage } from "../../src/relay/notice-store"
import { createNoticeStorage } from "../notice-storage"

export async function harness(
  options: {
    authorize?: (sessionID: string) => Promise<RelayAuthority>
    notifyPush?: RelayDeps["notifyPush"]
    ownerID?: string
    deviceID?: string
    monotonic?: RelayDeps["monotonic"]
    send?: RelayDeps["send"]
    noticeStorage?: NoticeStorage
  } = {},
) {
  let now = 0
  let id = 0
  const ownerID = options.ownerID ?? "owner"
  const deviceID = options.deviceID ?? "device"
  const output = new Map<string, Uint8Array[]>()
  const close: { id: string; code: number; reason: string }[] = []
  const notices = createNoticeStore(options.noticeStorage ?? createNoticeStorage(new Database(":memory:")))
  const relay = createRelay({
    now: () => now,
    monotonic: options.monotonic ?? (() => now),
    newID: () => `epoch-${++id}`,
    send: (id, bytes) => {
      const queue = output.get(id) ?? []
      queue.push(bytes)
      output.set(id, queue)
      options.send?.(id, bytes)
    },
    close: (id, code, reason) => close.push({ id, code, reason }),
    notices,
    authorizeClientCommand: async (sessionID) =>
      options.authorize ? options.authorize(sessionID) : { ok: true, ownerID },
    authorizeAgentCommand: async () => ({ ok: true, ownerID }),
    loadOfflineCheck: async () => undefined,
    saveOfflineCheck: async () => undefined,
    notifyPush: options.notifyPush,
  })
  const connections = new Map<string, Connection>()
  const collected = new Map<string, { frame?: Frame; decisions: Decision[] }[]>()
  function receive(id: string) {
    const messages = output.get(id) ?? []
    output.set(id, [])
    const received = messages.map((bytes) => receiveBinary(connections.get(id)!, bytes.slice().buffer, now))
    const history = collected.get(id) ?? []
    history.push(...received)
    collected.set(id, history)
    return received
  }
  async function send(id: string) {
    const frames: Uint8Array[] = []
    handoffBinary(connections.get(id)!, (bytes) => frames.push(bytes), now)
    for (const bytes of frames) await relay.handleClientMessage(id, bytes.slice().buffer)
  }
  async function attach(
    id: string,
    role: "agent" | "client" = "client",
    overrides: Partial<RelayConnection> = {},
    budgets?: Options["budgets"],
    handshake = true,
  ) {
    const peer = new Connection({
      role: role === "agent" ? PeerRole.AGENT : PeerRole.REMOTE_CLIENT,
      peer: PeerRole.RELAY,
      operations,
      eventTypes: remoteEventTypes,
      now,
      budgets,
    })
    connections.set(id, peer)
    await relay.attach({
      connectionID: id,
      role,
      ownerID,
      deviceID,
      browserSessionID: id,
      credentialExpiresAt: 1_000_000,
      ...overrides,
    })
    if (!handshake || close.some((entry) => entry.id === id)) return peer
    peer.start(now)
    await send(id)
    receive(id)
    await send(id)
    receive(id)
    return peer
  }
  function request(peer: Connection, name = "session.todo.list") {
    const operation = operations.find((item) => item.diagnosticName === name)!
    const scope = name.startsWith("notice.")
      ? create(ScopeSchema, { target: { case: "machine", value: {} } })
      : create(ScopeSchema, { target: { case: "session", value: "ses_1" } })
    return peer.request(
      operation.operationId,
      scope,
      name.startsWith("notice.")
        ? encodeStrict(EmptySchema, create(EmptySchema))
        : encodeStrict(
            session_todo_list_RequestSchema,
            create(session_todo_list_RequestSchema, {
              params: { sessionID: { encoding: { case: "utf8", value: "ses_1" } } },
            }),
          ),
      512,
      now,
    ).requestID!
  }
  function result(dispatch: Extract<Decision, { type: "dispatch" }>): Frame["body"] {
    return {
      case: "result",
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
  }
  return {
    relay,
    notices,
    close,
    attach,
    receive,
    send,
    collected,
    request,
    result,
    at: (time: number) => {
      now = time
    },
    now: () => now,
  }
}
