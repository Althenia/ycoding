export * as RemoteLocal from "./remote-local"

import {
  ClientError,
  YCoding,
  type FormAnswer,
  type FormInfo,
  type Project,
  type ProjectDirectory,
  type SessionInfo,
  type SessionMessageInfo,
  type YCodingClient,
} from "@ycoding-ai/client/promise"
import { Service, type Endpoint } from "@ycoding-ai/client/effect/service"
import { RemoteLimits } from "@ycoding-ai/remote"

// The bridge's only view of the local YCoding server: the same Protocol routes
// the TUI uses, addressed with a Location derived from the backend inventory.
// Remote input never reaches a URL, method, or Location header.

export type LocalLocation = { readonly directory: string; readonly workspaceID?: string }

export type LocalPrompt = {
  readonly id?: string
  readonly text: string
  readonly files?: readonly unknown[]
  readonly agents?: readonly unknown[]
  readonly delivery?: "steer" | "queue"
  readonly resume?: boolean
}

export type LocalAutonomy =
  | { readonly yolo: number | boolean; readonly maxNoProgress?: number | null }
  | { readonly goal: string | null; readonly maxNoProgress?: number | null }

export type LocalFailureKind = "not_found" | "invalid" | "conflict" | "transport" | "too_large" | "server"

export class LocalFailure extends Error {
  override readonly name = "LocalFailure"

  constructor(
    readonly kind: LocalFailureKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

export type LocalEventStream = {
  readonly onEvent: (event: unknown) => void
  readonly onFailure: (error: LocalFailure) => void
  /** Called when the stream ends without a failure, such as a server restart. */
  readonly onEnd: () => void
}

export type LocalServer = {
  readonly listPage: (input: { limit: number; cursor?: string }) => Promise<{
    readonly data: readonly SessionInfo[]
    readonly next?: string
  }>
  readonly projectList: () => Promise<readonly Project[]>
  readonly projectDirectories: (projectID: string) => Promise<readonly ProjectDirectory[]>
  readonly projectCurrent: (location: LocalLocation) => Promise<{ readonly id: string; readonly directory: string }>
  readonly createSession: (id: string, location: LocalLocation) => Promise<SessionInfo>
  readonly getSession: (sessionID: string, location: LocalLocation) => Promise<SessionInfo>
  /** Process-wide running status; the caller filters it to the current inventory. */
  readonly activeSessions: () => Promise<unknown>
  readonly snapshot: (sessionID: string, location: LocalLocation) => Promise<unknown>
  readonly messages: (sessionID: string, location: LocalLocation) => Promise<readonly SessionMessageInfo[]>
  readonly log: (sessionID: string, location: LocalLocation, after?: number) => Promise<readonly unknown[]>
  readonly autonomyGet: (sessionID: string, location: LocalLocation) => Promise<unknown>
  readonly permissionList: (sessionID: string, location: LocalLocation) => Promise<unknown>
  readonly guardrailStatus: (sessionID: string, location: LocalLocation) => Promise<unknown>
  readonly guardrailRequestList: (sessionID: string, location: LocalLocation) => Promise<unknown>
  readonly formList: (sessionID: string, location: LocalLocation) => Promise<readonly FormInfo[]>
  readonly fileChangeList: (sessionID: string, location: LocalLocation) => Promise<unknown>
  /** Reads one shell's info at the bound Location; the caller proves Session ownership from its metadata. */
  readonly shellGet: (shellID: string, location: LocalLocation) => Promise<unknown>
  /** Reads one bounded page of a shell's captured output at the bound Location. */
  readonly shellOutput: (
    shellID: string,
    location: LocalLocation,
    input: { readonly cursor?: number; readonly limit: number },
  ) => Promise<unknown>
  readonly prompt: (sessionID: string, location: LocalLocation, input: LocalPrompt) => Promise<unknown>
  readonly interrupt: (sessionID: string, location: LocalLocation) => Promise<void>
  readonly permissionReply: (
    sessionID: string,
    location: LocalLocation,
    requestID: string,
    reply: string,
    message?: string,
  ) => Promise<void>
  readonly guardrailReply: (
    sessionID: string,
    location: LocalLocation,
    requestID: string,
    reply: string,
  ) => Promise<void>
  readonly formReply: (
    sessionID: string,
    location: LocalLocation,
    formID: string,
    answer: FormAnswer,
  ) => Promise<void>
  readonly formCancel: (sessionID: string, location: LocalLocation, formID: string) => Promise<void>
  readonly autonomySet: (sessionID: string, location: LocalLocation, payload: LocalAutonomy) => Promise<unknown>
  /** Starts the shared event stream and resolves with an idempotent stop function. */
  readonly events: (stream: LocalEventStream) => Promise<() => Promise<void>>
}

export type LocalServerOptions = {
  readonly timeoutMs?: number
  readonly maxLogItems?: number
}

const defaultTimeoutMs = 30_000
const defaultMaxLogItems = 2_000

export function createLocalServer(endpoint: Endpoint, options: LocalServerOptions = {}): LocalServer {
  const client = YCoding.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs
  const maxLogItems = options.maxLogItems ?? defaultMaxLogItems

  const call = async <A>(operation: () => Promise<A>): Promise<A> => {
    try {
      return await operation()
    } catch (cause) {
      throw classify(cause, timeoutMs)
    }
  }

  return {
    listPage: (input) =>
      call(async () => {
        const page = await client.session.list(
          { limit: input.limit, order: "desc", ...(input.cursor === undefined ? {} : { cursor: input.cursor }) },
          { signal: AbortSignal.timeout(timeoutMs) },
        )
        return { data: page.data, next: page.cursor.next ?? undefined }
      }),
    projectList: () => call(() => client.project.list({ signal: AbortSignal.timeout(timeoutMs) })),
    projectDirectories: (projectID) =>
      call(() => client.project.directories({ projectID }, { signal: AbortSignal.timeout(timeoutMs) })),
    projectCurrent: (location) =>
      call(() => client.project.current({}, request(location, timeoutMs))),
    createSession: (id, location) =>
      call(() =>
        client.session.create(
          { id, location } as Parameters<YCodingClient["session"]["create"]>[0],
          request(location, timeoutMs),
        ),
      ),
    getSession: (sessionID, location) =>
      call(async () => {
        const info = await client.session.get({ sessionID }, request(location, timeoutMs))
        if (info.location.directory !== location.directory || info.location.workspaceID !== location.workspaceID)
          throw new LocalFailure("not_found", "Session is not available at the recorded location")
        return info
      }),
    messages: (sessionID, location) =>
      call(() => client.message.list({ sessionID }, request(location, timeoutMs))),
    activeSessions: () => call(() => client.session.active({ signal: AbortSignal.timeout(timeoutMs) })),
    snapshot: (sessionID, location) =>
      call(() => client.session.snapshot({ sessionID }, request(location, timeoutMs))),
    autonomyGet: (sessionID, location) =>
      call(() => client.session.autonomy.get({ sessionID }, request(location, timeoutMs))),
    permissionList: (sessionID, location) =>
      call(() => client.permission.list({ sessionID }, request(location, timeoutMs))),
    guardrailStatus: (sessionID, location) =>
      call(() => client.guardrail.status({ sessionID }, request(location, timeoutMs))),
    guardrailRequestList: (sessionID, location) =>
      call(() => client.guardrail.request.list({ sessionID }, request(location, timeoutMs))),
    formList: (sessionID, location) => call(() => client.form.list({ sessionID }, request(location, timeoutMs))),
    fileChangeList: (sessionID, location) =>
      call(() => client.session["file-change"].list({ sessionID }, request(location, timeoutMs))),
    shellGet: (shellID, location) =>
      call(async () => (await client.shell.get({ id: shellID }, request(location, timeoutMs))).data),
    shellOutput: (shellID, location, input) =>
      call(async () =>
        (
          await client.shell.output(
            {
              id: shellID,
              ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
              limit: input.limit,
            },
            request(location, timeoutMs),
          )
        ).data,
      ),
    log: (sessionID, location, after) =>
      call(async () => {
        const items: unknown[] = []
        const stream = client.session.log(
          { sessionID, follow: false, ...(after === undefined ? {} : { after }) },
          request(location, timeoutMs),
        )
        for await (const item of stream) {
          if (items.length >= maxLogItems)
            throw new LocalFailure("too_large", "Session log read exceeded the bounded item count; read again with after")
          items.push(item)
        }
        return items
      }),
    prompt: (sessionID, location, input) =>
      call(() =>
        client.session.prompt(
          {
            sessionID,
            ...(input.id === undefined ? {} : { id: input.id }),
            text: input.text,
            ...(input.files === undefined ? {} : { files: input.files }),
            ...(input.agents === undefined ? {} : { agents: input.agents }),
            ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
            ...(input.resume === undefined ? {} : { resume: input.resume }),
          } as Parameters<YCodingClient["session"]["prompt"]>[0],
          request(location, timeoutMs),
        ),
      ),
    interrupt: (sessionID, location) =>
      call(async () => {
        await client.session.interrupt({ sessionID }, request(location, timeoutMs))
      }),
    permissionReply: (sessionID, location, requestID, reply, message) =>
      call(async () => {
        await client.permission.reply(
          { sessionID, requestID, reply, ...(message === undefined ? {} : { message }) } as Parameters<
            YCodingClient["permission"]["reply"]
          >[0],
          request(location, timeoutMs),
        )
      }),
    guardrailReply: (sessionID, location, requestID, reply) =>
      call(async () => {
        await client.guardrail.request.reply(
          { sessionID, requestID, reply } as Parameters<YCodingClient["guardrail"]["request"]["reply"]>[0],
          request(location, timeoutMs),
        )
      }),
    formReply: (sessionID, location, formID, answer) =>
      call(async () => {
        await client.form.reply({ sessionID, formID, answer }, request(location, timeoutMs))
      }),
    formCancel: (sessionID, location, formID) =>
      call(async () => {
        await client.form.cancel({ sessionID, formID }, request(location, timeoutMs))
      }),
    autonomySet: (sessionID, location, payload) =>
      call(() =>
        client.session.autonomy.set(
          { sessionID, payload } as Parameters<YCodingClient["session"]["autonomy"]["set"]>[0],
          request(location, timeoutMs),
        ),
      ),
    events: async (stream) => {
      const controller = new AbortController()
      let stopped = false
      const consumption = (async () => {
        for await (const event of client.event.subscribe({ signal: controller.signal })) {
          if (stopped) return
          stream.onEvent(event)
        }
        if (!stopped) stream.onEnd()
      })().catch((cause) => {
        if (stopped) return
        stream.onFailure(classify(cause, timeoutMs))
      })
      return async () => {
        stopped = true
        controller.abort()
        await consumption
      }
    },
  }
}

function request(location: LocalLocation, timeoutMs: number) {
  return {
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "x-ycoding-directory": encodeURIComponent(location.directory),
      ...(location.workspaceID === undefined ? {} : { "x-ycoding-workspace": location.workspaceID }),
    },
  }
}

function classify(cause: unknown, timeoutMs: number): LocalFailure {
  if (cause instanceof LocalFailure) return cause
  if (cause instanceof ClientError) {
    const message =
      cause.reason === "Transport" || cause.reason === "UnexpectedStatus"
        ? `Local server did not complete the request${describe(cause.cause)}`
        : "Local server returned an unusable response"
    return new LocalFailure("transport", message, { cause })
  }
  const tag = typeof cause === "object" && cause !== null ? Reflect.get(cause, "_tag") : undefined
  if (tag === "InvalidRequestError" || tag === "InvalidCursorError" || tag === "SchemaError")
    return new LocalFailure("invalid", "Local server rejected the request", { cause })
  if (
    tag === "SessionNotFoundError" ||
    tag === "MessageNotFoundError" ||
    tag === "PermissionNotFoundError" ||
    tag === "GuardrailRequestNotFoundError" ||
    tag === "QuestionNotFoundError" ||
    tag === "SkillNotFoundError" ||
    tag === "ShellNotFoundError"
  )
    return new LocalFailure("not_found", "Session is not available on this device", { cause })
  if (tag === "ConflictError" || tag === "SessionBusyError" || tag === "ModelSwitchBlockedError")
    return new LocalFailure("conflict", "Local server rejected the request", { cause })
  return new LocalFailure("server", `Local server failed the request after ${timeoutMs}ms timeout policy`, { cause })
}

function describe(cause: unknown) {
  const message = cause instanceof Error ? cause.message : undefined
  return message === undefined || message === "" ? "" : `: ${message}`
}

/** Locate a session's recorded Location from the local server without any remote input. */
export async function findSession(local: LocalServer, sessionID: string) {
  let cursor: string | undefined
  for (;;) {
    const result = await local.listPage({
      limit: RemoteLimits.maxSessionListPage,
      ...(cursor === undefined ? {} : { cursor }),
    })
    const found = result.data.find((session) => session.id === sessionID)
    if (found) return found
    if (result.next === undefined || result.data.length === 0) return undefined
    cursor = result.next
  }
}

/** Read the complete global backend Session inventory without a page cap. */
export async function listSessions(local: LocalServer) {
  const sessions: SessionInfo[] = []
  let cursor: string | undefined
  for (;;) {
    const result = await local.listPage({
      limit: RemoteLimits.maxSessionListPage,
      ...(cursor === undefined ? {} : { cursor }),
    })
    sessions.push(...result.data)
    if (result.next === undefined || result.data.length === 0) return sessions
    cursor = result.next
  }
}

/**
 * The bridge dials the relay; it never listens, and it only ever talks to a
 * loopback local server. A LAN or public endpoint is refused: remote access must
 * travel through the relay, and the local server's cleartext credential must not
 * cross a network boundary.
 */
export function assertPrivateEndpoint(endpoint: Endpoint) {
  const url = new URL(endpoint.url)
  if (isLoopbackHost(url.hostname)) return
  throw new Error(
    `Refusing to bridge ${url.hostname}: the local YCoding server must be reachable on loopback. ` +
      "Use the managed background service, or reach this machine through the relay.",
  )
}

function isLoopbackHost(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (host === "localhost" || host.endsWith(".localhost")) return true
  if (host === "::1" || host === "::" || host === "0.0.0.0") return true
  const octets = host.split(".")
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet))) return false
  return Number(octets[0]) === 127
}

export const limits = RemoteLimits
