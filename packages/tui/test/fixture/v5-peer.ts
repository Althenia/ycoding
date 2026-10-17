import { decodeDomain, encodeDomain, type V5Options } from "@ycoding-ai/client/v5"
import { Connection, type Decision } from "../../../protocol/src/v5/connection"
import {
  schemas,
  create,
  encodeStrict,
  decodeStrict,
  FrameSchema,
  PeerRole,
  operations,
  PublicEventSchema,
  SessionLogItemSchema,
  ResultSchema,
  TypedPayloadSchema,
  Streaming,
  LedgerClass,
  event_subscribe_RequestSchema,
  event_subscribe_ResultSchema,
  session_log_ResultSchema,
  EventRecordSchema,
  BulkStartSchema,
  BulkPieceSchema,
  BulkEndSchema,
  ContentKind,
  model_default_ResultSchema,
  Location_InfoSchema,
  type Scope,
} from "../../../protocol/src/v5"

export type Dispatch = Extract<Decision, { type: "dispatch" }>

export const fixtureBudgets = { agentRate: 1_000_000, clientRate: 1_000_000 }

class ScriptedSocket extends EventTarget {
  readyState = 0
  binaryType = "arraybuffer"
  constructor(readonly peer: ScriptedPeer) {
    super()
  }
  open() {
    this.readyState = 1
    this.dispatchEvent(new Event("open"))
  }
  send(bytes: Uint8Array) {
    this.peer.receive(bytes)
  }
  deliver(bytes: Uint8Array) {
    this.dispatchEvent(
      new MessageEvent("message", { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) }),
    )
  }
  close() {
    this.readyState = 3
    this.dispatchEvent(new Event("close"))
  }
}

export class ScriptedPeer {
  readonly connection: Connection
  readonly socket = new ScriptedSocket(this)
  readonly requests: Dispatch[] = []
  readonly subscriptions = new Map<string, Scope>()
  onRequest?: (dispatch: Dispatch) => void
  onSettled?: (method: string) => void
  private readonly results = new Map<bigint, string>()
  private readonly cancelled = new Set<string>()
  private time = performance.now()
  constructor(epoch: string) {
    this.connection = new Connection({
      role: PeerRole.SERVER,
      peer: PeerRole.LOCAL_CLIENT,
      operations,
      eventTypes: [PublicEventSchema.typeName, SessionLogItemSchema.typeName],
      epoch,
      sourceEpoch: "source-1",
      now: this.time,
      budgets: fixtureBudgets,
    })
  }
  private now() {
    this.time = Math.max(this.time, performance.now())
    return this.time
  }
  receive(bytes: Uint8Array) {
    const token = this.connection.admitIncoming(bytes.length)
    if (!token) throw new Error("Scripted peer input was refused")
    const frame = decodeStrict(FrameSchema, bytes)
    const decisions = this.connection.acceptIncoming(token, frame, this.now())
    if (
      this.connection.state !== "closed" &&
      frame.body.case === "control" &&
      frame.body.value.kind.case === "credit"
    ) {
      const credit = frame.body.value.kind.value
      if (credit.ledger === LedgerClass.NORMAL) {
        for (const [ordinal, method] of this.results) {
          if (ordinal > credit.consumedThrough) continue
          this.results.delete(ordinal)
          this.onSettled?.(method)
        }
      }
    }
    for (const decision of decisions) {
      if (decision.type === "cancelled") {
        this.cancelled.add(decision.requestID)
        continue
      }
      if (decision.type !== "dispatch") continue
      this.requests.push(decision)
      this.onRequest?.(decision)
      this.connection.consume(frame.ledger, decision.ordinal, this.now())
    }
    this.flush()
  }
  result(dispatch: Dispatch, payload: { typeName: string; payload: Uint8Array }, rejected = false) {
    if (this.cancelled.has(dispatch.requestID) || this.connection.state === "closed" || this.socket.readyState === 3)
      return
    this.connection.enqueue(
      {
        case: "result",
        value: create(ResultSchema, {
          requestId: dispatch.requestID,
          operationId: dispatch.operation.operationId,
          settlement: dispatch.operation.settlement,
          outcome: { case: rejected ? "error" : "success", value: create(TypedPayloadSchema, payload) },
        }),
      },
      payload.payload.length + 512,
      this.now(),
    )
    this.flush()
  }
  subscribe(dispatch: Dispatch, id: string) {
    const schema =
      dispatch.operation.diagnosticName === "event.subscribe" ? event_subscribe_ResultSchema : session_log_ResultSchema
    this.result(dispatch, {
      typeName: schema.typeName,
      payload: encodeStrict(
        schema,
        create(schema, {
          subscriptionId: { encoding: { case: "utf8", value: id } },
        }),
      ),
    })
  }
  bulk(dispatch: Dispatch, payload: Uint8Array) {
    const transferId = `transfer_${dispatch.requestID}`
    const now = this.now()
    const size = 16_384
    const chunks = Math.ceil(payload.length / size)
    this.connection.enqueue(
      {
        case: "bulkStart",
        value: create(BulkStartSchema, {
          requestId: dispatch.requestID,
          transferId,
          operationId: dispatch.operation.operationId,
          typeName: dispatch.operation.resultType,
          contentKind: ContentKind.TYPED_MESSAGE,
          byteCount: BigInt(payload.length),
          chunkCount: chunks,
        }),
      },
      512,
      now,
    )
    for (let index = 0; index < chunks; index++) {
      const data = payload.subarray(index * size, (index + 1) * size)
      this.connection.enqueue(
        {
          case: "bulkPiece",
          value: create(BulkPieceSchema, {
            transferId,
            index,
            offset: BigInt(index * size),
            data,
          }),
        },
        data.length + 512,
        now,
      )
    }
    this.connection.enqueue(
      {
        case: "bulkEnd",
        value: create(BulkEndSchema, {
          transferId,
          byteCount: BigInt(payload.length),
          outcome: { case: "success", value: {} },
        }),
      },
      512,
      now,
    )
    this.flush()
  }
  events(id: string, payloads: { typeName: string; payload: Uint8Array }[]) {
    for (const event of payloads)
      this.connection.enqueueEvent(
        create(EventRecordSchema, {
          eventId: `evt_${this.time}`,
          createdMs: BigInt(Math.floor(this.time)),
          event,
        }),
        { subscriptionID: id, scope: this.subscriptions.get(id)!, sourceEpoch: "source-1" },
        this.now(),
      )
    this.time += 50
    this.connection.advance(this.time)
    this.flush()
  }
  end(id: string) {
    this.connection.enqueue(
      { case: "streamEnd", value: { $typeName: "ycoding.v5.StreamEnd", subscriptionId: id } },
      512,
      this.now(),
    )
    this.flush()
  }
  flush() {
    for (;;) {
      const prepared = this.connection.prepareHandoff(this.now())
      if (!prepared) return
      const bytes = encodeStrict(FrameSchema, prepared.frame)
      const decisions = this.connection.handoff(prepared, bytes.length, this.now())
      if (decisions.some((decision) => decision.type === "closed")) throw new Error("Scripted peer handoff closed")
      const frame = prepared.frame
      if (frame.body.case === "result" && frame.body.value.outcome.case === "success") {
        const requestID = frame.body.value.requestId
        const dispatch = this.requests.find((request) => request.requestID === requestID)!
        this.results.set(frame.deliveryOrdinal, dispatch.operation.diagnosticName)
        if (dispatch.operation.streaming === Streaming.EVENTS) {
          const schema =
            dispatch.operation.diagnosticName === "event.subscribe"
              ? event_subscribe_ResultSchema
              : session_log_ResultSchema
          const result = decodeStrict(schema, frame.body.value.outcome.value.payload)
          const id = result.subscriptionId!.encoding
          if (id.case !== "utf8") throw new Error("Scripted subscription ID")
          const scope =
            dispatch.operation.diagnosticName === "event.subscribe"
              ? decodeStrict(event_subscribe_RequestSchema, dispatch.request.payload).scope!
              : dispatch.request.scope!
          this.connection.acceptSubscription(dispatch.requestID, id.value, scope, this.now(), "send")
          this.subscriptions.set(id.value, scope)
        }
      }
      queueMicrotask(() => {
        if (this.socket.readyState !== 3) this.socket.deliver(bytes)
      })
    }
  }
}

type DomainRequest = {
  params?: Record<string, string>
  query?: Record<string, unknown>
  payload?: unknown
  headers?: Record<string, string>
}

const sessionPaths: Record<string, string> = {
  "daybreak.set": "daybreak",
  promptGenerate: "prompt-generate",
  resolveSkillConflict: "skill/resolve",
  "autonomy.get": "autonomy",
  "autonomy.set": "autonomy",
  "todo.list": "todo",
  "pending.list": "pending",
  "compaction.list": "compaction",
  "review.list": "review",
  switchAgent: "agent",
  switchModel: "model",
  unarchive: "archive",
  unpin: "pin",
  messages: "message",
  capturedInputs: "message/captured-inputs",
  "fileChange.list": "file-change",
  taskCosts: "usage/tasks",
}
const locationPaths: Record<string, string> = {
  "telemetry.append": "server/web-latency",
  "telemetry.list": "server/web-latency",
  "telemetry.consent.get": "server/telemetry/consent",
  "telemetry.consent.set": "server/telemetry/consent",
  "keepAwake.get": "keep-awake",
  "keepAwake.set": "keep-awake",
  "mcp.resource.catalog": "mcp/resource",
  "config.diagnostics": "config/diagnostics",
  "permission.request.list": "permission/request",
  "permission.saved.list": "permission/saved",
  "form.request.list": "form/request",
  "model.default": "model/default",
  "providerUsage.list": "provider/usage",
  "providerUsage.forecast": "provider/usage/forecast",
  "incident.guidance.clear": "incident/guidance",
  "usage.get": "usage",
  "usage.report": "usage/report",
  "provider.refresh": "provider/refresh",
  "integration.wellknown.add": "experimental/integration/wellknown",
}

function sessionInfo(value: unknown, id: string) {
  if (typeof value !== "object" || value === null) return value
  return {
    id,
    title: "Fixture Session",
    projectID: "proj_test",
    location: { directory: "/tmp/ycoding/packages/tui" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
    ...value,
  }
}

function scenario(dispatch: Dispatch) {
  const name = dispatch.operation.diagnosticName
  const input = decodeDomain(dispatch.operation.requestType, dispatch.request.payload) as DomainRequest
  const params = input.params ?? {}
  const path = (() => {
    if (name === "event.subscribe") return "/api/event"
    if (name === "session.log") return `/api/experimental/session/${params.sessionID}/log`
    if (name.startsWith("session.")) {
      const action = name.slice("session.".length)
      if (["list", "create", "active", "outstanding", "completions"].includes(action))
        return `/api/session${["list", "create"].includes(action) ? "" : `/${action}`}`
      if (["capturedChanges.list", "team.economics", "family.activity"].includes(action)) {
        const target = dispatch.request.scope?.target
        if (target?.case !== "session") throw new Error(`Expected Session scope for ${name}`)
        return `/api/session/${target.value}/${action === "capturedChanges.list" ? "captured-changes" : action.replaceAll(".", "/")}`
      }
      const root = `/api/session/${params.sessionID ?? params.parentID}`
      if (["get", "remove"].includes(action)) return root
      if (action === "review.decide") return `${root}/review/${params.itemID}/decide`
      if (action.startsWith("subagent.")) {
        const suffix = action.slice("subagent.".length)
        if (["list", "launch"].includes(suffix)) return `${root}/subagent`
        if (suffix === "answer") return `${root}/subagent/${params.childID}/question/${params.questionID}/answer`
        return `${root}/subagent/${params.childID}/${suffix}`
      }
      if (action === "message") return `${root}/message/${params.messageID}`
      if (action.startsWith("permission.") || action.startsWith("question.")) {
        const [group, suffix] = action.split(".")
        return `${root}/${group}${suffix === "list" ? "" : `/${params.requestID}/${suffix}`}`
      }
      if (action.startsWith("form.")) {
        const suffix = action.slice("form.".length)
        return `${root}/form${suffix === "list" ? "" : `/${params.formID}/${suffix}`}`
      }
      if (action === "guardrail.status") return `${root}/guardrail`
      if (action === "guardrail.request.list") return `${root}/guardrail/request`
      if (action === "guardrail.request.reply") return `${root}/guardrail/request/${params.requestID}/reply`
      return `${root}/${sessionPaths[action] ?? action.replaceAll(".", "/")}`
    }
    if (name.startsWith("artifact.")) {
      const action = name.slice("artifact.".length)
      if (action === "list") return "/api/artifact"
      return `/api/artifact/${params.scope}/${params.kind}/${params.id}${["get", "remove"].includes(action) ? "" : `/${action.replaceAll(".", "/")}`}`
    }
    if (name.startsWith("projectCopy."))
      return `/experimental/project/${params.projectID}/copy${name.endsWith("refresh") ? "/refresh" : ""}`
    if (name === "project.directories" || name === "project.forget")
      return `/api/project/${params.projectID}/directories`
    if (name.startsWith("integration.") && Object.keys(params).length) {
      const action = name.slice("integration.".length).replaceAll(".", "/")
      if (action === "get") return `/api/integration/${params.integrationID}`
      if (action === "connect/key") return `/api/integration/${params.integrationID}/connect/key`
      const [kind, suffix] = action.split("/")
      return `/api/integration/${params.integrationID}/connect/${kind}${suffix === "connect" ? "" : `/${params.attemptID}${["status", "cancel"].includes(suffix) ? "" : `/${suffix}`}`}`
    }
    if (name.startsWith("credential."))
      return `/api/credential/${params.credentialID}${name.endsWith("activate") ? "/activate" : ""}`
    if (name.startsWith("browser.") || name.startsWith("isolatedBrowser.")) {
      const [group, action] = name.split(".")
      const root = `/api/session/${params.sessionID}/browser${group === "isolatedBrowser" ? "/isolated" : ""}`
      return `${root}${["status", "stop"].includes(action!) ? "" : action === "forget" ? "/pairing" : `/${action}`}`
    }
    if (name.startsWith("pty.") || name.startsWith("shell.")) {
      const [group, action] = name.split(".")
      const id = params.ptyID ?? params.id
      return `/api/${group}${id ? `/${id}` : ""}${["list", "create", "get", "remove", "update"].includes(action!) ? "" : action === "connectToken" ? "/connect-token" : `/${action}`}`
    }
    if (name.startsWith("mcp.") && params.name) return `/api/mcp/${params.name}/${name.split(".").at(-1)}`
    return `/api/${locationPaths[name] ?? name.replace(/\.(list|get|create|set|remove|refresh)$/, "").replaceAll(".", "/")}`
  })()
  const method = ["session.capturedChanges.list", "session.team.economics", "session.family.activity"].includes(name)
    ? "GET"
    : name === "session.daybreak.set"
      ? "POST"
      : ["event.subscribe", "session.log"].includes(name)
        ? "GET"
        : name.endsWith(".unarchive") ||
            name.endsWith(".unpin") ||
            name.endsWith(".remove") ||
            name.endsWith(".clear") ||
            name.endsWith(".forget") ||
            (name.endsWith(".cancel") && !name.startsWith("session.subagent."))
          ? "DELETE"
          : name.endsWith(".set") || name.endsWith(".update")
            ? "PUT"
            : input.payload !== undefined || dispatch.operation.mutation === 2
              ? "POST"
              : "GET"
  const url = new URL(path, "http://test")
  function query(key: string, value: unknown) {
    if (value === undefined) return
    if (value === null) {
      url.searchParams.append(key, "null")
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item))
      return
    }
    if (typeof value === "object") {
      for (const [field, item] of Object.entries(value)) query(`${key}[${field}]`, item)
      return
    }
    url.searchParams.append(key, String(value))
  }
  for (const [key, value] of Object.entries(input.query ?? {})) query(key, value)
  if (
    ["session.capturedChanges.list", "session.team.economics", "session.family.activity"].includes(name) &&
    typeof input.payload === "object" &&
    input.payload !== null
  )
    for (const [key, value] of Object.entries(input.payload)) query(key, value)
  const request = new Request(url, {
    method,
    headers: input.headers,
    ...(method === "GET" || (method === "DELETE" && input.payload === undefined)
      ? {}
      : { body: JSON.stringify(input.payload ?? {}) }),
  })
  return { url, request }
}

export type Scenario = (url: URL, request: Request) => Response | undefined | Promise<Response | undefined>
export type EventSource = {
  attach(peer: ScriptedPeer, dispatch: Dispatch): void
  opening(open: () => void): void
}
export const eventSources = new WeakMap<Response, EventSource>()

export function scriptedTransport(run: Scenario, events: EventSource) {
  const peers = new Set<ScriptedPeer>()
  const settlements = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
  let generation = 0
  function peer() {
    const peer = new ScriptedPeer(`tui_connection_${++generation}`)
    peers.add(peer)
    peer.onSettled = (method) => settlements.get(method)?.resolve()
    peer.onRequest = (dispatch) => {
      if (dispatch.operation.diagnosticName === "event.unsubscribe")
        return peer.result(dispatch, {
          typeName: dispatch.operation.resultType,
          payload: encodeDomain(dispatch.operation.resultType, {}),
        })
      const { url, request } = scenario(dispatch)
      void Promise.resolve()
        .then(() => run(url, request))
        .then(async (response) => {
          if (!response) throw new Error(`unexpected scripted operation: ${dispatch.operation.diagnosticName}`)
          const source = eventSources.get(response)
          if (source) return source.attach(peer, dispatch)
          const text = await response.text()
          const value: unknown = text ? JSON.parse(text) : {}
          if (!response.ok) {
            const error = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
            if (dispatch.operation.errorTypes.includes("ycoding.v5.Connector_Error"))
              return peer.result(
                dispatch,
                {
                  typeName: "ycoding.v5.Connector_Error",
                  payload: encodeDomain("ycoding.v5.Connector_Error", {
                    code: error.code ?? "internal_error",
                    message: error.message ?? error.error ?? text,
                  }),
                },
                true,
              )
            const requested =
              typeof error._tag === "string"
                ? error._tag
                : response.status === 409
                  ? "ConflictError"
                  : "InvalidRequestError"
            const tag = dispatch.operation.errorTypes.includes(`ycoding.v5.${requested}`)
              ? requested
              : "InvalidRequestError"
            const typeName = `ycoding.v5.${tag}`
            return peer.result(
              dispatch,
              {
                typeName,
                payload: encodeDomain(typeName, { ...error, _tag: tag, message: error.message ?? error.error ?? text }),
              },
              true,
            )
          }
          const name = dispatch.operation.diagnosticName
          if (name === "model.default" && (value as { data?: unknown }).data == null) {
            const location = (value as { location: unknown }).location
            return peer.result(dispatch, {
              typeName: dispatch.operation.resultType,
              payload: encodeStrict(
                model_default_ResultSchema,
                create(model_default_ResultSchema, {
                  location: decodeStrict(Location_InfoSchema, encodeDomain(Location_InfoSchema.typeName, location)),
                  data: { kind: { case: "none", value: {} } },
                }),
              ),
            })
          }
          const body = (() => {
            if (name === "health.get") return { data: value }
            if (name === "session.list") {
              const page = value as { data: Record<string, unknown>[]; cursor: unknown }
              return { data: { ...page, data: page.data.map((session) => sessionInfo(session, String(session.id))) } }
            }
            if (["session.get", "session.create", "session.fork", "session.move"].includes(name)) {
              const result = value as { data: Record<string, unknown> }
              return { data: sessionInfo(result.data, String(result.data?.id ?? url.pathname.split("/").at(-1))) }
            }
            if (["agent.list", "model.list", "integration.list", "provider.list"].includes(name)) {
              const page = value as { data: Record<string, unknown>[] }
              return {
                ...page,
                data: page.data.map((item) =>
                  name === "agent.list"
                    ? {
                        name: item.id,
                        ...item,
                        request: { settings: {}, ...(item.request as Record<string, unknown>) },
                      }
                    : name === "model.list"
                      ? { modelID: item.id, enabled: true, ...item }
                      : name === "provider.list"
                        ? { package: "fixture-package", ...item }
                        : { methods: [], connections: [], ...item },
                ),
              }
            }
            if (name === "session.active") {
              const active = value as { data: Record<string, Record<string, unknown>> }
              return {
                data: Object.fromEntries(
                  Object.entries(active.data).map(([id, status]) => [id, { type: "running", ...status }]),
                ),
              }
            }
            if (name === "session.synthetic") {
              const input = decodeDomain(dispatch.operation.requestType, dispatch.request.payload) as DomainRequest
              const payload = input.payload as Record<string, unknown>
              return {
                data: {
                  type: "synthetic",
                  admittedSeq: 1,
                  timeCreated: 1,
                  delivery: "steer",
                  sessionID: input.params?.sessionID,
                  id: payload.id,
                  data: { text: payload.text, description: payload.description, metadata: payload.metadata },
                  ...(value as { data: Record<string, unknown> }).data,
                },
              }
            }
            if (name === "model.default") {
              const page = value as { data: { selection: { id: string; providerID: string } } }
              return {
                ...page,
                data: {
                  id: page.data.selection.id,
                  modelID: page.data.selection.id,
                  providerID: page.data.selection.providerID,
                  name: page.data.selection.id,
                  capabilities: { tools: true, input: ["text"], output: ["text"] },
                  variants: [],
                  time: { released: 0 },
                  cost: [],
                  status: "active",
                  enabled: true,
                  limit: { context: 200_000, output: 32_000 },
                  ...page.data,
                },
              }
            }
            if (
              schemas
                .find((schema) => schema.typeName === dispatch.operation.resultType)
                ?.fields.some(
                  (field) => field.name === "data" && field.fieldKind === "message" && field.message.name === "Empty",
                )
            )
              return { data: {} }
            return [
              "location.get",
              "session.snapshot",
              "session.subagent.list",
              "session.compaction.list",
              "session.messages",
              "session.generate",
              "session.prediction",
              "session.promptGenerate",
              "generate.text",
              "project.inventory",
              "telemetry.consent.get",
              "telemetry.consent.set",
              "session.subagent.cancel",
            ].includes(name)
              ? { data: value }
              : value
          })()
          const payload = encodeDomain(
            dispatch.operation.resultType,
            (body as { data?: unknown }).data === null ? {} : body,
          )
          if (payload.length > 16_384) return peer.bulk(dispatch, payload)
          peer.result(dispatch, { typeName: dispatch.operation.resultType, payload })
        })
        .catch((error) => {
          if (dispatch.operation.errorTypes.includes("ycoding.v5.Connector_Error"))
            return peer.result(
              dispatch,
              {
                typeName: "ycoding.v5.Connector_Error",
                payload: encodeDomain("ycoding.v5.Connector_Error", {
                  code: "internal_error",
                  message: `${dispatch.operation.diagnosticName}: ${String(error)}`,
                }),
              },
              true,
            )
          peer.result(
            dispatch,
            {
              typeName: "ycoding.v5.InvalidRequestError",
              payload: encodeDomain("ycoding.v5.InvalidRequestError", {
                _tag: "InvalidRequestError",
                message: `${dispatch.operation.diagnosticName}: ${String(error)}`,
              }),
            },
            true,
          )
        })
    }
    return peer
  }
  return {
    waitForSettlement(method: string) {
      const settlement = Promise.withResolvers<void>()
      settlements.set(method, settlement)
      return settlement.promise
    },
    socket: (() => {
      const current = peer()
      queueMicrotask(() => events.opening(() => current.socket.open()))
      return current.socket
    }) satisfies NonNullable<V5Options["socket"]>,
    listen() {
      const server = Bun.serve<ScriptedPeer>({
        port: 0,
        fetch(request, server) {
          if (new URL(request.url).pathname !== "/ws/v5/local") return new Response(null, { status: 404 })
          if (server.upgrade(request, { data: peer() })) return
          return new Response(null, { status: 400 })
        },
        websocket: {
          open(socket) {
            socket.data.socket.readyState = 1
            socket.data.socket.deliver = (bytes) => {
              socket.send(bytes)
            }
            socket.data.socket.close = () => {
              socket.data.socket.readyState = 3
              socket.close()
            }
          },
          message(socket, message) {
            if (typeof message === "string") throw new Error("Binary v5 is required")
            if (socket.data.connection.state === "closed") {
              socket.close()
              return
            }
            socket.data.receive(new Uint8Array(message))
          },
          close(socket) {
            socket.data.socket.close()
            peers.delete(socket.data)
          },
        },
      })
      return server
    },
    close() {
      for (const peer of peers) peer.socket.close()
      peers.clear()
    },
  }
}
