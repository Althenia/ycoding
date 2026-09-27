import type { PushSubscriptionInput } from "../../../../packages/remote/src/index"
import type { PushStore, PushSubscription } from "./store"

type Row = { readonly endpoint: string; readonly account_id: string; readonly p256dh: string; readonly auth: string; readonly created_at: number; readonly failures: number }

export function createD1PushStore(db: D1Database): PushStore {
  return {
    async upsert(accountID: string, input: PushSubscriptionInput, now: number) {
      await db.batch([
        db.prepare("INSERT INTO push_subscription (endpoint, account_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET account_id = excluded.account_id, p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at, failures = 0")
          .bind(input.endpoint, accountID, input.keys.p256dh, input.keys.auth, now),
        db.prepare("DELETE FROM push_subscription WHERE account_id = ? AND endpoint NOT IN (SELECT endpoint FROM push_subscription WHERE account_id = ? ORDER BY created_at DESC, endpoint DESC LIMIT 10)")
          .bind(accountID, accountID),
      ])
    },
    async remove(accountID: string, endpoint: string) {
      await db.prepare("DELETE FROM push_subscription WHERE account_id = ? AND endpoint = ?").bind(accountID, endpoint).run()
    },
    async list(accountID: string): Promise<readonly PushSubscription[]> {
      const rows = await db.prepare("SELECT endpoint, account_id, p256dh, auth, created_at, failures FROM push_subscription WHERE account_id = ? ORDER BY created_at DESC, endpoint DESC")
        .bind(accountID).all<Row>()
      return rows.results.map((row) => ({ endpoint: row.endpoint, accountID: row.account_id,
        keys: { p256dh: row.p256dh, auth: row.auth }, createdAt: row.created_at, failures: row.failures }))
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
