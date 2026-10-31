import { YCoding, type EventSubscribeOutput } from "@ycoding-ai/client/promise"

type Client = ReturnType<typeof YCoding.make>
export type FamilyChange = { readonly sessionID: string; readonly type: string; readonly id: string; readonly seq?: number }
type Cursor = { readonly sessionID: string; readonly after?: number }
type Checkpoint = { readonly version: 1; readonly rootSessionID: string; readonly sourceEpoch: string; readonly cursors: readonly Cursor[] }
export const familyLimit = 64
const checkpointLimit = 64 * 1024
export class FamilyCheckpointError extends Error {}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function decodeCheckpoint(value: string, rootSessionID: string, after?: number): Checkpoint {
  if (value.length > checkpointLimit || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid checkpoint encoding or size")
  let decoded: unknown
  try { decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) } catch { throw new Error("Invalid checkpoint JSON") }
  if (!record(decoded)) throw new Error("Invalid checkpoint fields")
  if (Object.keys(decoded).some((key) => !["version", "rootSessionID", "sourceEpoch", "cursors"].includes(key))) throw new Error("Invalid checkpoint fields")
  if (decoded.version !== 1) throw new Error("Unsupported checkpoint version")
  if (decoded.rootSessionID !== rootSessionID) throw new Error("Mismatched checkpoint root")
  if (typeof decoded.sourceEpoch !== "string" || !decoded.sourceEpoch.trim() || decoded.sourceEpoch.length > 256) throw new Error("Invalid checkpoint epoch")
  if (!Array.isArray(decoded.cursors) || decoded.cursors.length === 0 || decoded.cursors.length > familyLimit) throw new Error("Invalid checkpoint Session IDs")
  const ids = new Set<string>()
  const cursors: Cursor[] = []
  for (const item of decoded.cursors) {
    if (!record(item) || Object.keys(item).some((key) => !["sessionID", "after"].includes(key))) throw new Error("Invalid checkpoint fields")
    if (typeof item.sessionID !== "string" || !item.sessionID.startsWith("ses") || item.sessionID.length > 256 || ids.has(item.sessionID)) throw new Error("Invalid checkpoint Session IDs")
    if (item.after !== undefined && (typeof item.after !== "number" || !Number.isSafeInteger(item.after) || item.after < 0)) throw new Error("Invalid checkpoint cursor")
    ids.add(item.sessionID)
    cursors.push({ sessionID: item.sessionID, ...(item.after === undefined ? {} : { after: item.after }) })
  }
  const root = cursors.find((item) => item.sessionID === rootSessionID)
  if (!root) throw new Error("Missing checkpoint root cursor")
  if (after !== undefined && after !== root.after) throw new Error("--after conflicts with checkpoint")
  return { version: 1, rootSessionID, sourceEpoch: decoded.sourceEpoch, cursors }
}

export async function discoverFamily(client: Client, rootSessionID: string, signal: AbortSignal) {
  const found = new Set([rootSessionID])
  const queue = [rootSessionID]
  let pages = 0
  while (queue.length) {
    const parentID = queue.shift()!
    let cursor: string | undefined
    const visited = new Set<string>()
    do {
      if (++pages > familyLimit * 2) throw new Error(`Family discovery exceeds ${familyLimit * 2} pages`)
      const page = await client.session.list({ parentID, limit: 200, ...(cursor === undefined ? {} : { cursor }) }, { signal })
      for (const child of page.data) {
        if (found.has(child.id)) continue
        if (found.size === familyLimit) throw new Error(`Family exceeds ${familyLimit} Sessions`)
        found.add(child.id)
        queue.push(child.id)
      }
      cursor = page.cursor.next ?? undefined
      if (cursor !== undefined && visited.has(cursor)) throw new Error("Family discovery repeated a page cursor")
      if (cursor !== undefined) visited.add(cursor)
    } while (cursor !== undefined)
  }
  return found
}

type Entry = {
  readonly id: string
  epoch: string
  after?: number
  before?: number
  change?: FamilyChange
  ready: boolean
  restart: boolean
  attempts: number
  controller?: AbortController
  task?: Promise<void>
}

export function createFamilyWatch(client: Client, rootSessionID: string, signal: AbortSignal, checkpoint?: Checkpoint, rootAfter?: number) {
  const entries = new Map<string, Entry>()
  const saved = new Map(checkpoint?.cursors.map((cursor) => [cursor.sessionID, cursor]))
  let scope = new Set(checkpoint?.cursors.map((cursor) => cursor.sessionID) ?? [rootSessionID])
  let epoch = checkpoint?.sourceEpoch
  let baseline = checkpoint !== undefined
  let revision = 0
  let failure: unknown
  let wake: (() => void) | undefined
  let waiting: Promise<void> | undefined
  const notify = () => { revision++; wake?.(); wake = undefined; waiting = undefined }
  const owned = (entry: Entry) => entries.get(entry.id) === entry && !signal.aborted && !entry.controller?.signal.aborted
  const stop = async (entry: Entry) => { entry.controller?.abort(); await entry.task }
  const pump = async (entry: Entry) => {
    const iterator = client.session.log({ sessionID: entry.id, follow: true, ...(entry.after === undefined ? {} : { after: entry.after }) },
      { signal: AbortSignal.any([signal, entry.controller!.signal]) })[Symbol.asyncIterator]()
    try {
      for (;;) {
        const result = await iterator.next()
        if (!owned(entry)) return
        if (result.done) { entry.restart = true; notify(); return }
        const event = result.value
        if (event.sourceEpoch !== entry.epoch) continue
        if (event.type === "log.synced") {
          if (event.aggregateID === entry.id && event.seq !== undefined) entry.after = Math.max(entry.after ?? event.seq, event.seq)
          notify()
          continue
        }
        if (event.durable.aggregateID !== entry.id || (entry.after !== undefined && event.durable.seq <= entry.after)) continue
        const before = entry.after
        entry.after = event.durable.seq
        const terminal = event.type === "session.execution.succeeded" || event.type === "session.execution.failed" || event.type === "session.execution.interrupted"
        if (terminal || (entry.id === rootSessionID && event.type === "session.work.completed")) {
          entry.before = before
          entry.change = { sessionID: entry.id, type: event.type, id: event.id, seq: event.durable.seq }
          entry.ready = false
          notify()
        } else if (event.type === "session.execution.started" && entry.change) {
          entry.ready = true
          notify()
        }
      }
    } catch (error) {
      if (owned(entry)) { entry.restart = true; notify() }
    } finally {
      await iterator.return?.().catch(() => undefined)
    }
  }
  return {
    get revision() { return revision },
    async sync(reset = false) {
      if (failure !== undefined) throw failure
      const family = await discoverFamily(client, rootSessionID, signal)
      scope = family
      for (const [id, entry] of entries) if (!family.has(id)) { entries.delete(id); await stop(entry) }
      if (reset) for (const entry of entries.values()) await stop(entry)
      for (const id of family) {
        let entry = entries.get(id)
        if (entry && !reset && !entry.restart) continue
        if (entry) await stop(entry)
        const snapshot = await client.session.snapshot({ sessionID: id, limit: 1 }, { signal })
        const cursor = saved.get(id)
        if (!entry && cursor?.after !== undefined && (snapshot.watermark.seq === undefined || cursor.after > snapshot.watermark.seq))
          throw new FamilyCheckpointError("Checkpoint cursor is ahead of current Session history; restart without --checkpoint and its --after cursor")
        if (id === rootSessionID) epoch = snapshot.sourceEpoch
        if (snapshot.sourceEpoch !== epoch) throw new Error("Family snapshot changed server epoch")
        if (!entry) {
          entry = { id, epoch: snapshot.sourceEpoch, after: cursor ? cursor.after
            : id === rootSessionID && rootAfter !== undefined ? rootAfter : baseline ? undefined : snapshot.watermark.seq,
            ready: false, restart: false, attempts: 0 }
          entries.set(id, entry)
        }
        if (entry.epoch !== snapshot.sourceEpoch) {
          if (entry.change) entry.after = entry.before
          entry.change = undefined
          entry.before = undefined
          entry.ready = false
        }
        entry.epoch = snapshot.sourceEpoch
        if (++entry.attempts > 10) throw new Error(`Family log keeps closing for ${id}`)
        entry.restart = false
        entry.controller = new AbortController()
        entry.task = pump(entry).catch((error: unknown) => { failure = error; notify() })
      }
      baseline = true
      return family
    },
    notice(event: EventSubscribeOutput) {
      if (event.sourceEpoch !== undefined && event.sourceEpoch !== epoch) return
      if (event.type !== "session.status") return
      const entry = entries.get(event.data.sessionID)
      if (!entry) return
      if (entry.change) entry.ready = true
      else if (event.data.status.type === "idle") {
        entry.before = entry.after
        entry.change = { sessionID: entry.id, type: event.type, id: event.id }
        entry.ready = true
      }
      notify()
    },
    changes(active: readonly string[]) {
      if (failure !== undefined) throw failure
      return [...entries.values()].flatMap((entry) => entry.change && (entry.ready || !active.includes(entry.id)) ? [entry.change] : [])
    },
    wait(seen: number) {
      if (revision !== seen) return Promise.resolve()
      waiting ??= new Promise<void>((resolve) => { wake = resolve })
      return waiting
    },
    checkpoint(rootAfter: number | undefined, delivered: readonly FamilyChange[]) {
      if (epoch === undefined) return undefined
      const cursors = [...scope].map((id): Cursor => {
        const entry = entries.get(id)
        const after = id === rootSessionID ? rootAfter : entry
          ? entry.change && !delivered.includes(entry.change) ? entry.before : entry.after
          : saved.get(id)?.after
        return { sessionID: id, ...(after === undefined ? {} : { after }) }
      })
      return Buffer.from(JSON.stringify({ version: 1, rootSessionID, sourceEpoch: epoch, cursors })).toString("base64url")
    },
    async close() {
      const all = [...entries.values()]
      for (const entry of all) entry.controller?.abort()
      await Promise.all(all.map(stop))
      entries.clear()
      notify()
    },
  }
}
