import { DesktopError, utf8Length, type PinRequest, type SessionItem, type Sessions, type SessionsQuery } from "./contract"
import { amount, bounded, own, text } from "./models"
import { isRevision, isSessionID, session } from "./requests"

const retry = "Refresh Sessions and try again."
const invalidList = "The backend returned an invalid Session list. Refresh to retry."

const plain = (value: unknown): value is object =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const cursor = (value: unknown): value is string => text(value) && value.length > 0 && utf8Length(value) <= 4096
const time = (value: unknown): value is number | undefined => value === undefined || amount(value)

export function sessionsQuery(value: unknown): SessionsQuery {
  if (!plain(value)) throw new DesktopError(retry)
  const keys = Object.keys(value).sort().join()
  if (keys === "") return {}
  if (keys === "search") {
    const search = own(value, "search")
    if (!text(search) || utf8Length(search) > 256) throw new DesktopError("Use a Session search of at most 256 bytes.")
    const trimmed = search.trim()
    return trimmed ? { search: trimmed } : {}
  }
  const revision = own(value, "revision")
  const next = own(value, "cursor")
  if (keys !== "cursor,revision" || !isRevision(revision) || !cursor(next)) throw new DesktopError(retry)
  return { revision, cursor: next }
}

export function sessionTarget(value: unknown) {
  if (!plain(value) || Object.keys(value).join() !== "sessionID") throw new DesktopError("Choose a Session.")
  return session(own(value, "sessionID"))
}

export function projectSessionRecord(sessionID: string, value: unknown): SessionItem {
  if (own(value, "id") !== sessionID) throw new DesktopError("The backend returned a different Session. Refresh and choose again.")
  const item = projectSession(value)
  if (!item) throw new DesktopError("The backend returned an invalid Session. Refresh to retry.")
  return item
}

export function pinRequest(value: unknown): PinRequest {
  if (!plain(value) || Object.keys(value).sort().join() !== "pinned,revision,sessionID") throw new DesktopError(retry)
  const revision = own(value, "revision")
  const pinned = own(value, "pinned")
  if (!isRevision(revision) || typeof pinned !== "boolean") throw new DesktopError(retry)
  return { sessionID: session(own(value, "sessionID")), revision, pinned }
}

function projectSession(value: unknown): SessionItem | undefined {
  const id = own(value, "id")
  const parentID = own(value, "parentID")
  const title = own(value, "title")
  const directory = own(own(value, "location"), "directory")
  const times = own(value, "time")
  const updated = own(times, "updated")
  const active = own(times, "active")
  const archived = own(times, "archived")
  const pinned = own(times, "pinned")
  const agent = own(value, "agent")
  const model = own(value, "model")
  const modelID = own(model, "id")
  const providerID = own(model, "providerID")
  const reference = model === undefined ? undefined : bounded(modelID) && bounded(providerID) ? { id: modelID, providerID } : null
  const tokens = own(value, "tokens")
  const input = own(tokens, "input")
  const output = own(tokens, "output")
  const reasoning = own(tokens, "reasoning")
  const read = own(own(tokens, "cache"), "read")
  const write = own(own(tokens, "cache"), "write")
  const cost = own(value, "cost")
  if (!isSessionID(id) || (parentID !== undefined && !isSessionID(parentID)) || !text(title) || !text(directory) || !amount(updated) ||
    !time(active) || !time(archived) || !time(pinned) || (agent !== undefined && !text(agent)) || reference === null ||
    !amount(input) || !amount(output) || !amount(reasoning) || !amount(read) || !amount(write) || !amount(cost)) return undefined
  return {
    id,
    ...(parentID === undefined ? {} : { parentID }),
    title,
    location: { directory },
    time: { updated, ...(active === undefined ? {} : { active }), ...(archived === undefined ? {} : { archived }), ...(pinned === undefined ? {} : { pinned }) },
    ...(agent === undefined ? {} : { agent }),
    ...(reference === undefined ? {} : { model: reference }),
    tokens: { input, output, reasoning, cache: { read, write } },
    cost,
  }
}

export function projectSessions(value: unknown, revision: number): Sessions {
  const data = own(value, "data")
  const next = own(own(value, "cursor"), "next")
  if (!Array.isArray(data) || (next !== undefined && next !== null && !cursor(next))) throw new DesktopError(invalidList)
  return { revision, items: data.flatMap((item: unknown) => projectSession(item) ?? []), ...(cursor(next) ? { next } : {}) }
}
