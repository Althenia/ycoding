import { createHash } from "node:crypto"

export type DoubleSession = {
  readonly id: string
  readonly parentID?: string
  readonly title: string
  readonly agent?: string
  readonly projectID?: string
  readonly location?: { readonly directory: string; readonly workspaceID?: string }
  readonly model?: {
    readonly providerID: string
    readonly id: string
    readonly variant?: string
    readonly profile?: string
  }
  readonly time: {
    readonly created: number
    readonly updated: number
    readonly active?: number
    readonly archived?: number
    readonly pinned?: number
  }
}
type SessionInfo = DoubleSession

const maxSessionListPage = 200

const literal = <T extends string>(value: unknown, allowed: readonly T[], name: string): T => {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`Invalid ${name}`)
  return value as T
}
const requireString = (value: unknown, name: string, max: number, options: { readonly allowEmpty?: boolean } = {}) => {
  if (typeof value !== "string" || value.length > max || (value.length === 0 && options.allowEmpty !== true))
    throw new Error(`Invalid ${name}`)
  return value
}
const sessionID = (value: unknown, name: string) => {
  if (typeof value !== "string" || !value.startsWith("ses_") || value.length > 100) throw new Error(`Invalid ${name}`)
  return value
}
const optionalInteger = (value: unknown, name: string, min: number, max: number) => {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    throw new Error(`Invalid ${name}`)
  return value
}
class OperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}
const workspaceKey = (_projectID: string | undefined, directory: string, workspaceID: string | undefined) =>
  `${directory}\u0000${workspaceID ?? ""}`
const resolve = (path: string) => path

type Cursor = {
  readonly id: string
  readonly time: number
  readonly direction: "next" | "previous"
  readonly pinned?: number | null
  readonly running?: boolean
  readonly waiting?: boolean
  readonly epoch?: string
}

export type ListQuery = {
  readonly order: "asc" | "desc" | "pinned" | "active"
  readonly search?: string
  readonly searchFields?: "summary"
  readonly workspace?: string
  readonly status?: "waiting" | "running" | "idle"
  readonly parentID?: string | null
  readonly limit: number
  readonly anchor?: Cursor
  readonly around?: string
  readonly before?: number
}
type SessionOrderKey = {
  readonly id: string
  readonly time: { readonly updated: number; readonly pinned?: number | undefined }
}

export function parseListQuery(fields: Readonly<Record<string, unknown>>): ListQuery {
  const order =
    fields.order === undefined ? "desc" : literal(fields.order, ["asc", "desc", "pinned", "active"], "order")
  const anchor = fields.cursor === undefined ? undefined : cursor(fields.cursor)
  if (order === "pinned" && anchor !== undefined && anchor.pinned === undefined)
    throw new OperationError("invalid_message", "Pinned Session cursor is missing its sort key")
  if (
    order === "active" &&
    anchor !== undefined &&
    (anchor.running === undefined || anchor.waiting === undefined || anchor.epoch === undefined)
  )
    throw new OperationError("invalid_message", "Active Session cursor is missing its sort key")
  if (
    (fields.around !== undefined || fields.before !== undefined) &&
    (order !== "active" || anchor !== undefined || fields.around === undefined)
  )
    throw new OperationError("invalid_message", "A Session window anchor requires active order without a cursor")
  return {
    order,
    search: fields.search === undefined ? undefined : requireString(fields.search, "search", 200, { allowEmpty: true }),
    searchFields:
      fields.searchFields === undefined ? undefined : literal(fields.searchFields, ["summary"] as const, "searchFields"),
    workspace: fields.workspace === undefined ? undefined : requireString(fields.workspace, "workspace", 128),
    status: fields.status === undefined ? undefined : literal(fields.status, ["waiting", "running", "idle"] as const, "status"),
    parentID:
      fields.parentID === undefined
        ? undefined
        : fields.parentID === null
          ? null
          : sessionID(fields.parentID, "parentID"),
    limit: fields.limit === undefined ? 50 : optionalInteger(fields.limit, "limit", 1, maxSessionListPage)!,
    anchor,
    around: fields.around === undefined ? undefined : sessionID(fields.around, "around"),
    before:
      fields.before === undefined
        ? undefined
        : optionalInteger(fields.before, "before", 0, (typeof fields.limit === "number" ? fields.limit : 50) - 1),
  }
}

export function listPage(
  sessions: readonly SessionInfo[],
  query: ListQuery,
  running?: ReadonlySet<string>,
  waiting?: ReadonlySet<string>,
  lost?: ReadonlySet<string>,
) {
  const { order, search, parentID, limit, anchor } = query
  const direction = anchor?.direction ?? "next"
  const effectiveOrder =
    order === "pinned" || order === "active"
      ? order
      : direction === "previous"
        ? order === "asc"
          ? "desc"
          : "asc"
        : order
  const byID = new Map(sessions.map((session) => [session.id, session]))
  const runningRoots = new Set(
    sessions
      .filter((session) => running?.has(session.id))
      .map((session) => rootSessionID(session, byID))
      .filter((id): id is string => id !== undefined),
  )
  const isRunning = (session: SessionInfo) =>
    session.parentID === undefined ? runningRoots.has(session.id) : running?.has(session.id) === true
  const isWaiting = (session: SessionInfo) => session.parentID === undefined && waiting?.has(session.id) === true
  const isLost = (session: SessionInfo) =>
    session.parentID === undefined && lost?.has(session.id) === true && !isWaiting(session)
  const activeKey = (session: SessionInfo) => ({
    id: session.id,
    time: session.time.active ?? session.time.updated,
    waiting: isWaiting(session),
    running: !isWaiting(session) && session.parentID === undefined && runningRoots.has(session.id),
  })
  const needle = search?.toLowerCase()
  const matching = sessions
    .filter(
      (session) =>
        query.workspace === undefined ||
        (session.location !== undefined &&
          workspaceKey(session.projectID, resolve(session.location.directory), session.location.workspaceID) ===
            query.workspace),
    )
    .filter(
      (session) =>
        needle === undefined ||
        (query.searchFields === "summary"
          ? [
              session.title,
              session.agent ?? "",
              ...(session.model === undefined
                ? []
                : [
                    `${session.model.providerID}/${session.model.id}${session.model.variant === undefined ? "" : `#${session.model.variant}`}${session.model.profile === undefined ? "" : ` profile ${session.model.profile}`}`,
                  ]),
            ].some((value) => value.toLowerCase().includes(needle))
          : session.title.toLowerCase().includes(needle)),
    )
    .filter(
      (session) =>
        query.status === undefined ||
        (query.status === "waiting"
          ? isWaiting(session)
          : query.status === "running"
            ? isRunning(session) && !isWaiting(session)
            : !isWaiting(session) && !isRunning(session) && session.time.archived === undefined),
    )
    .filter((session) => (parentID === undefined ? true : (session.parentID ?? null) === parentID))
    .sort(
      order === "active"
        ? (left, right) => compareActiveSessions(activeKey(left), activeKey(right))
        : order === "pinned"
          ? comparePinnedSessions
          : compareSessions,
    )
  const epoch =
    order !== "active"
      ? undefined
      : createHash("sha256")
          .update(
            JSON.stringify([
              query.workspace,
              search,
              query.searchFields,
              query.status,
              parentID,
              matching.map(activeKey),
            ]),
          )
          .digest("hex")
  if (order === "active" && anchor !== undefined && anchor.epoch !== epoch)
    return { data: [], cursor: { previous: undefined, next: undefined }, stale: true }
  const ordered =
    effectiveOrder === "asc" || ((effectiveOrder === "pinned" || effectiveOrder === "active") && direction === "next")
      ? matching
      : matching.toReversed()
  const anchored =
    anchor === undefined
      ? ordered
      : ordered.filter((session) =>
          effectiveOrder === "active"
            ? compareActiveSessions(activeKey(session), {
                id: anchor.id,
                time: anchor.time,
                running: anchor.running === true,
                waiting: anchor.waiting === true,
              }) *
                (direction === "next" ? 1 : -1) >
              0
            : effectiveOrder === "pinned"
              ? comparePinnedSessions(session, {
                  id: anchor.id,
                  time: { updated: anchor.time, pinned: anchor.pinned ?? undefined },
                }) *
                  (direction === "next" ? 1 : -1) >
                0
              : afterAnchor(session, anchor, effectiveOrder),
        )
  const windowStart =
    query.around === undefined
      ? 0
      : Math.max(0, matching.findIndex((session) => session.id === query.around) - (query.before ?? 0))
  const page = anchored.slice(windowStart, windowStart + limit)
  const remaining = anchored.length - windowStart - page.length
  const data = direction === "previous" ? page.toReversed() : page
  const first = data[0]
  const last = data.at(-1)
  return {
    data,
    ...(running === undefined
      ? {}
      : {
          status: {
            running: data.filter(isRunning).map((session) => session.id),
            attention: data.filter((session) => isWaiting(session) || isLost(session)).map((session) => session.id),
            ...(data.some(isLost) ? { lost: data.filter(isLost).map((session) => session.id) } : {}),
          },
        }),
    cursor: {
      previous:
        first && (direction === "next" ? anchor !== undefined || windowStart > 0 : remaining > 0)
          ? encodeCursor({
              id: first.id,
              time: order === "active" ? activeKey(first).time : first.time.updated,
              direction: "previous",
              ...(order === "pinned" ? { pinned: first.time.pinned ?? null } : {}),
              ...(order === "active"
                ? { running: activeKey(first).running, waiting: activeKey(first).waiting, epoch }
                : {}),
            })
          : undefined,
      next:
        last && (direction === "previous" ? anchor !== undefined : remaining > 0)
          ? encodeCursor({
              id: last.id,
              time: order === "active" ? activeKey(last).time : last.time.updated,
              direction: "next",
              ...(order === "pinned" ? { pinned: last.time.pinned ?? null } : {}),
              ...(order === "active"
                ? { running: activeKey(last).running, waiting: activeKey(last).waiting, epoch }
                : {}),
            })
          : undefined,
    },
  }
}

function rootSessionID(session: SessionInfo, byID: ReadonlyMap<string, SessionInfo>): string | undefined {
  const seen = new Set<string>()
  let current = session
  while (current.parentID !== undefined && !seen.has(current.id)) {
    seen.add(current.id)
    const parent = byID.get(current.parentID)
    if (parent === undefined) return undefined
    current = parent
  }
  return current.parentID === undefined ? current.id : undefined
}

function encodeCursor(cursor: Cursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url")
}

function cursor(value: unknown): Cursor {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024)
    throw new OperationError("invalid_message", "Invalid cursor")
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
    if (typeof parsed !== "object" || parsed === null) throw new Error("shape")
    const record = parsed as Record<string, unknown>
    if (typeof record.id !== "string" || typeof record.time !== "number") throw new Error("shape")
    if (record.pinned !== undefined && record.pinned !== null && typeof record.pinned !== "number")
      throw new Error("shape")
    if (record.running !== undefined && typeof record.running !== "boolean") throw new Error("shape")
    if (record.waiting !== undefined && typeof record.waiting !== "boolean") throw new Error("shape")
    if (record.epoch !== undefined && (typeof record.epoch !== "string" || !/^[a-f0-9]{64}$/.test(record.epoch)))
      throw new Error("shape")
    return {
      id: record.id,
      time: record.time,
      direction: literal(record.direction, ["next", "previous"], "cursor"),
      ...(record.pinned === undefined ? {} : { pinned: record.pinned }),
      ...(record.running === undefined ? {} : { running: record.running }),
      ...(record.waiting === undefined ? {} : { waiting: record.waiting }),
      ...(record.epoch === undefined ? {} : { epoch: record.epoch }),
    }
  } catch {
    throw new OperationError("invalid_message", "Invalid cursor")
  }
}

function compareSessions(left: SessionOrderKey, right: SessionOrderKey) {
  if (left.time.updated !== right.time.updated) return left.time.updated - right.time.updated
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

function comparePinnedSessions(left: SessionOrderKey, right: SessionOrderKey) {
  const pinnedLeft = left.time.pinned
  const pinnedRight = right.time.pinned
  if (pinnedLeft !== undefined && pinnedRight === undefined) return -1
  if (pinnedLeft === undefined && pinnedRight !== undefined) return 1
  if (pinnedLeft !== undefined && pinnedRight !== undefined && pinnedLeft !== pinnedRight)
    return pinnedLeft - pinnedRight
  return -compareSessions(left, right)
}

function compareActiveSessions(
  left: { readonly id: string; readonly time: number; readonly running: boolean; readonly waiting: boolean },
  right: { readonly id: string; readonly time: number; readonly running: boolean; readonly waiting: boolean },
) {
  if (left.waiting !== right.waiting) return left.waiting ? -1 : 1
  if (left.running !== right.running) return left.running ? -1 : 1
  if (left.time !== right.time) return right.time - left.time
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

function afterAnchor(session: SessionInfo, anchor: Cursor, order: "asc" | "desc") {
  if (session.time.updated !== anchor.time)
    return order === "asc" ? session.time.updated > anchor.time : session.time.updated < anchor.time
  return order === "asc" ? session.id > anchor.id : session.id < anchor.id
}
