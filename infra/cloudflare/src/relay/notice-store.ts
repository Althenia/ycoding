import { RemoteLimits, type RemoteAlertDetail, type RemoteNotice, type RemoteNoticeCategory, type RemoteWorkCompletion } from "../../../../packages/remote/src/index"

export type NoticeSql = {
  readonly exec: (query: string, ...bindings: unknown[]) => { readonly toArray: () => unknown[] }
}

export type NoticeStorage = {
  readonly sql: NoticeSql
  readonly kv: { readonly get: <Value>(key: string) => Value | undefined; readonly put: <Value>(key: string, value: Value) => void }
  readonly transactionSync: <Value>(operation: () => Value) => Value
}

export type NoticeEvent = {
  readonly category: RemoteNoticeCategory
  readonly sessionID: string
  readonly createdAt: number
  readonly need?: RemoteAlertDetail["need"]
}

export const attentionRepeatMs = 10 * 60_000

export type NoticePage = {
  readonly notices: readonly RemoteNotice[]
  readonly next?: string
  readonly total: number
}

export type NoticeStore = {
  readonly append: (events: readonly NoticeEvent[]) => { readonly notices: readonly RemoteNotice[]; readonly total: number }
  readonly repeat: (events: readonly NoticeEvent[]) => readonly RemoteNotice[]
  readonly complete: (receipts: readonly RemoteWorkCompletion[], more: boolean) => { readonly notices: readonly RemoteNotice[]; readonly total: number }
  readonly page: (before?: number) => NoticePage
  readonly remove: (sequences: readonly number[]) => { readonly ids: readonly string[]; readonly total: number }
  readonly clear: () => void
  readonly unavailable: () => boolean
  readonly markUnavailable: () => void
}

type Row = { readonly seq: number; readonly category: RemoteNoticeCategory; readonly session_id: string; readonly created_at: number }

export function createNoticeStore(storage: NoticeStorage): NoticeStore {
  const sql = storage.sql
  sql.exec(
    "CREATE TABLE IF NOT EXISTS notice (seq INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, session_id TEXT NOT NULL, created_at INTEGER NOT NULL)",
  ).toArray()
  sql.exec("CREATE TABLE IF NOT EXISTS notice_sync (id INTEGER PRIMARY KEY CHECK (id = 1), unavailable INTEGER NOT NULL DEFAULT 0)").toArray()
  sql.exec("INSERT OR IGNORE INTO notice_sync (id) VALUES (1)").toArray()
  sql.exec("CREATE TABLE IF NOT EXISTS attention_alert (session_id TEXT PRIMARY KEY, need TEXT NOT NULL, alerted_at INTEGER NOT NULL)").toArray()
  let total: number | undefined

  const count = () => (total ??= (sql.exec("SELECT COUNT(*) AS total FROM notice").toArray()[0] as { total: number }).total)
  const guarded = <Value>(operation: () => Value) => {
    try {
      return operation()
    } catch (error) {
      total = undefined
      throw error
    }
  }

  const append = (events: readonly NoticeEvent[]) =>
      guarded(() => {
        if (events.length === 0) return { notices: [], total: count() }
        const before = count()
        const rows = sql.exec(
          "INSERT INTO notice (category, session_id, created_at) SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]') FROM json_each(?) WHERE json_extract(value, '$[0]') != 'approval-requested' OR NOT EXISTS (SELECT 1 FROM notice WHERE category = 'approval-requested' AND session_id = json_extract(value, '$[1]')) ORDER BY CAST(key AS INTEGER) RETURNING seq, category, session_id, created_at",
          JSON.stringify(events.map((event) => [event.category, event.sessionID, event.createdAt])),
        ).toArray() as Row[]
        total = before + rows.length
        for (const row of rows) if (row.category === "approval-requested") alerted(row.session_id, needOf(events, row.session_id), row.created_at)
        return { notices: rows.sort((left, right) => left.seq - right.seq).map(notice), total }
      })

  const alerted = (sessionID: string, need: string, at: number) => {
    sql.exec("INSERT INTO attention_alert (session_id, need, alerted_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET need = excluded.need, alerted_at = excluded.alerted_at",
      sessionID, need, at).toArray()
  }
  const forgetRead = () => {
    sql.exec("DELETE FROM attention_alert WHERE session_id NOT IN (SELECT session_id FROM notice WHERE category = 'approval-requested')").toArray()
  }

  return {
    append,
    repeat: (events) => storage.transactionSync(() => events.flatMap((event) => {
      if (event.category !== "approval-requested") return []
      const row = sql.exec("SELECT seq, category, session_id, created_at FROM notice WHERE category = 'approval-requested' AND session_id = ? ORDER BY seq LIMIT 1",
        event.sessionID).toArray()[0] as Row | undefined
      if (row === undefined) return []
      const last = sql.exec("SELECT need, alerted_at FROM attention_alert WHERE session_id = ?", event.sessionID).toArray()[0] as { need: string; alerted_at: number } | undefined
      const need = needOf([event], event.sessionID)
      if (last !== undefined && last.need === need && event.createdAt - last.alerted_at < attentionRepeatMs) return []
      alerted(event.sessionID, need, event.createdAt)
      return [notice(row)]
    })),
    complete: (receipts, more) => guarded(() => storage.transactionSync(() => {
      const baseline = storage.kv.get<boolean>("completionSync") !== true
      const events = receipts.flatMap((receipt) => {
        const key = `completion:${receipt.sessionID}`
        if (receipt.seq <= (storage.kv.get<number>(key) ?? 0)) return []
        storage.kv.put(key, receipt.seq)
        return baseline ? [] : [{ category: "agent-completed" as const, sessionID: receipt.sessionID, createdAt: receipt.created }]
      })
      if (baseline && !more) storage.kv.put("completionSync", true)
      return append(events)
    })),
    page: (before = Number.MAX_SAFE_INTEGER) => {
      const rows = sql.exec(
        "SELECT seq, category, session_id, created_at FROM notice WHERE seq < ? ORDER BY seq DESC LIMIT ?",
        before,
        RemoteLimits.noticePageSize + 1,
      ).toArray() as Row[]
      const notices = rows.slice(0, RemoteLimits.noticePageSize).map(notice)
      const last = notices.at(-1)
      return { notices, ...(rows.length > RemoteLimits.noticePageSize && last !== undefined ? { next: last.id } : {}), total: guarded(count) }
    },
    remove: (sequences) =>
      guarded(() => {
        const current = count()
        const removed = (sql.exec(
          `DELETE FROM notice WHERE seq IN (${sequences.map(() => "?").join(", ")}) RETURNING seq`,
          ...sequences,
        ).toArray() as { seq: number }[]).map((row) => row.seq)
        total = current - removed.length
        forgetRead()
        return { ids: removed.sort((left, right) => left - right).map((seq) => `ntc_${seq}`), total }
      }),
    clear: () =>
      guarded(() => {
        sql.exec("DELETE FROM notice").toArray()
        forgetRead()
        total = 0
        sql.exec("UPDATE notice_sync SET unavailable = 0 WHERE id = 1").toArray()
      }),
    unavailable: () => (sql.exec("SELECT unavailable FROM notice_sync WHERE id = 1").toArray()[0] as { unavailable: number }).unavailable === 1,
    markUnavailable: () => { sql.exec("UPDATE notice_sync SET unavailable = 1 WHERE id = 1").toArray() },
  }
}

function needOf(events: readonly NoticeEvent[], sessionID: string): string {
  return events.find((event) => event.sessionID === sessionID)?.need ?? "attention"
}

function notice(row: Row): RemoteNotice {
  return { id: `ntc_${row.seq}`, category: row.category, sessionID: row.session_id, createdAt: row.created_at }
}
