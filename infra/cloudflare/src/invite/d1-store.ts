import type { InviteRow, InviteStore } from "./store"

type Row = { readonly id: string; readonly label: string | null; readonly created_at: number;
  readonly redeemed_at: number | null; readonly user_id: string | null }

export function createD1InviteStore(db: D1Database): InviteStore {
  return {
    create: async (row) => {
      await db.prepare("INSERT INTO invite (id, token_hash, label, created_at) VALUES (?, ?, ?, ?)")
        .bind(row.id, row.tokenHash, row.label, row.createdAt).run()
    },
    list: async () => (await db.prepare("SELECT id, label, created_at, redeemed_at, user_id FROM invite ORDER BY created_at DESC, id DESC")
      .all<Row>()).results.map(readRow),
    find: async (id) => {
      const row = await db.prepare("SELECT id, label, created_at, redeemed_at, user_id FROM invite WHERE id = ?").bind(id).first<Row>()
      return row ? readRow(row) : undefined
    },
    redeem: async (tokenHash, input) => {
      const [, claimed] = await db.batch([
        db.prepare('INSERT INTO "user" (id, created_at) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM invite WHERE token_hash = ? AND redeemed_at IS NULL)')
          .bind(input.userID, input.now, tokenHash),
        db.prepare("UPDATE invite SET redeemed_at = ?, user_id = ?, key_hash = ? WHERE token_hash = ? AND redeemed_at IS NULL")
          .bind(input.now, input.userID, input.keyHash, tokenHash),
        db.prepare("INSERT INTO browser_session (id, user_id, created_at, expires_at) SELECT ?, user_id, ?, ? FROM invite WHERE token_hash = ? AND user_id = ?")
          .bind(input.sessionHash, input.now, input.expiresAt, tokenHash, input.userID),
      ])
      return claimed?.meta.changes === 1
    },
    signIn: async (keyHash, input) => {
      const result = await db.prepare("INSERT INTO browser_session (id, user_id, created_at, expires_at) SELECT ?, user_id, ?, ? FROM invite WHERE key_hash = ? AND user_id IS NOT NULL")
        .bind(input.sessionHash, input.now, input.expiresAt, keyHash).run()
      return result.meta.changes === 1
    },
    delete: async (id, userID) => {
      const [, removed] = await db.batch([
        db.prepare("DELETE FROM oauth_transaction WHERE user_id = ? AND EXISTS (SELECT 1 FROM invite WHERE id = ? AND user_id = ?)")
          .bind(userID, id, userID),
        db.prepare("DELETE FROM invite WHERE id = ? AND user_id IS ?").bind(id, userID),
        db.prepare('DELETE FROM "user" WHERE id = ? AND NOT EXISTS (SELECT 1 FROM invite WHERE id = ?)').bind(userID, id),
      ])
      return removed?.meta.changes === 1
    },
  }
}

function readRow(row: Row): InviteRow {
  return { id: row.id, label: row.label, createdAt: row.created_at, redeemedAt: row.redeemed_at, userID: row.user_id }
}
