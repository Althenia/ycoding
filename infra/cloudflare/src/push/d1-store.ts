import { RemoteLimits, type PushRegistration, type PushRenewal } from "../../../../packages/remote/src/index"
import type { PushStore, PushSubscription } from "./store"

type Row = {
  readonly endpoint: string
  readonly account_id: string
  readonly browser_session_id: string
  readonly p256dh: string
  readonly auth: string
  readonly created_at: number
  readonly failures: number
  readonly agent_completed: number
  readonly approval_requested: number
  readonly machine_offline: number
}

const columns = "endpoint, account_id, browser_session_id, p256dh, auth, created_at, failures, agent_completed, approval_requested, machine_offline"
const retention = "DELETE FROM push_subscription WHERE account_id = ? AND endpoint NOT IN (SELECT endpoint FROM push_subscription WHERE account_id = ? ORDER BY created_at DESC, endpoint DESC LIMIT 10)"
const liveSession = "EXISTS (SELECT 1 FROM browser_session WHERE user_id = ? AND id = ? AND revoked_at IS NULL AND expires_at > ?)"

export function createD1PushStore(db: D1Database): PushStore {
  return {
    async upsert(accountID: string, browserSessionID: string, input: PushRegistration, now: number) {
      const results = await db.batch([
        db.prepare(`DELETE FROM push_subscription WHERE browser_session_id = ? AND endpoint <> ? AND ${liveSession}`).bind(browserSessionID, input.endpoint, accountID, browserSessionID, now),
        db.prepare(`INSERT INTO push_subscription (endpoint, account_id, browser_session_id, p256dh, auth, created_at, agent_completed, approval_requested, machine_offline) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${liveSession} ON CONFLICT(endpoint) DO UPDATE SET account_id = excluded.account_id, browser_session_id = excluded.browser_session_id, p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at, failures = 0, agent_completed = excluded.agent_completed, approval_requested = excluded.approval_requested, machine_offline = excluded.machine_offline`)
          .bind(input.endpoint, accountID, browserSessionID, input.keys.p256dh, input.keys.auth, now,
            Number(input.categories["agent-completed"]), Number(input.categories["approval-requested"]), Number(input.categories["machine-offline"]), accountID, browserSessionID, now),
        db.prepare(`${retention} AND ${liveSession}`).bind(accountID, accountID, accountID, browserSessionID, now),
      ])
      return (results[1]?.meta.changes ?? 0) > 0
    },
    async renew(accountID: string, browserSessionID: string, input: PushRenewal, now: number) {
      const replaced = "EXISTS (SELECT 1 FROM push_subscription WHERE account_id = ? AND endpoint = ?)"
      const results = await db.batch([
        db.prepare(`DELETE FROM push_subscription WHERE browser_session_id = ? AND endpoint <> ? AND ${replaced} AND ${liveSession}`).bind(browserSessionID, input.replaces, accountID, input.replaces, accountID, browserSessionID, now),
        db.prepare(`DELETE FROM push_subscription WHERE endpoint = ? AND endpoint <> ? AND ${replaced} AND ${liveSession}`).bind(input.endpoint, input.replaces, accountID, input.replaces, accountID, browserSessionID, now),
        db.prepare(`UPDATE push_subscription SET endpoint = ?, browser_session_id = ?, p256dh = ?, auth = ?, created_at = ?, failures = 0, tested_at = NULL WHERE account_id = ? AND endpoint = ? AND ${liveSession}`)
          .bind(input.endpoint, browserSessionID, input.keys.p256dh, input.keys.auth, now, accountID, input.replaces, accountID, browserSessionID, now),
        db.prepare(`${retention} AND ${liveSession}`).bind(accountID, accountID, accountID, browserSessionID, now),
      ])
      if ((results[2]?.meta.changes ?? 0) > 0) return "written"
      const live = await db.prepare(`SELECT 1 WHERE ${liveSession}`).bind(accountID, browserSessionID, now).first()
      return live ? "missing" : "unauthorized"
    },
    async remove(accountID: string, endpoint: string) {
      await db.prepare("DELETE FROM push_subscription WHERE account_id = ? AND endpoint = ?").bind(accountID, endpoint).run()
    },
    async list(accountID: string): Promise<readonly PushSubscription[]> {
      const rows = await db.prepare(`SELECT ${columns} FROM push_subscription WHERE account_id = ? ORDER BY created_at DESC, endpoint DESC`)
        .bind(accountID).all<Row>()
      return rows.results.map(subscription)
    },
    async claimTest(accountID: string, endpoint: string, now: number) {
      const claimed = await db.prepare(`UPDATE push_subscription SET tested_at = ? WHERE account_id = ? AND endpoint = ? AND (tested_at IS NULL OR tested_at <= ?) RETURNING ${columns}`)
        .bind(now, accountID, endpoint, now - RemoteLimits.pushTestIntervalMs).all<Row>()
      const row = claimed.results[0]
      if (row) return { status: "claimed", subscription: subscription(row) }
      const existing = await db.prepare("SELECT endpoint FROM push_subscription WHERE account_id = ? AND endpoint = ?").bind(accountID, endpoint).all()
      return existing.results.length > 0 ? { status: "limited" } : { status: "missing" }
    },
    async recordFailure(subscription: PushSubscription, permanent: boolean) {
      if (permanent) {
        await db.prepare("DELETE FROM push_subscription WHERE account_id = ? AND endpoint = ? AND p256dh = ? AND auth = ?")
          .bind(subscription.accountID, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth).run()
        return
      }
      await db.batch([
        db.prepare("UPDATE push_subscription SET failures = failures + 1 WHERE account_id = ? AND endpoint = ? AND p256dh = ? AND auth = ?")
          .bind(subscription.accountID, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth),
        db.prepare("DELETE FROM push_subscription WHERE account_id = ? AND endpoint = ? AND p256dh = ? AND auth = ? AND failures >= 5")
          .bind(subscription.accountID, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth),
      ])
    },
  }
}

function subscription(row: Row): PushSubscription {
  return { endpoint: row.endpoint, accountID: row.account_id, browserSessionID: row.browser_session_id, keys: { p256dh: row.p256dh, auth: row.auth }, createdAt: row.created_at, failures: row.failures,
    categories: { "agent-completed": row.agent_completed === 1, "approval-requested": row.approval_requested === 1, "machine-offline": row.machine_offline === 1 } }
}
