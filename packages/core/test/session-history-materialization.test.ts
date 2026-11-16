import { expect } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "../src/database/database"
import { EventRuntime } from "../src/event"
import { SessionHistory } from "../src/session/history"
import { SessionMessage } from "../src/session/message"
import { SessionContextStateTable } from "../src/session/sql"
import { historyDatabase, historyFixture } from "./fixture/session-history-pruning"
import { testEffect } from "./lib/effect"

const it = testEffect(EventRuntime.layer.pipe(Layer.provideMerge(historyDatabase)))

for (const checkpoint of ["active", "quarantined"] as const) {
  it.effect(`repeated ${checkpoint} history materialization preserves required payloads and canonical rows`, () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const fixture = yield* historyFixture(db, { count: 1000, bytes: 8192 })
      if (checkpoint === "quarantined")
        yield* db.update(SessionContextStateTable).set({ status: "quarantined" })
          .where(eq(SessionContextStateTable.session_id, fixture.sessionID)).run()
      const expected = checkpoint === "active"
        ? [SessionMessage.ID.make(`msg_compaction_${fixture.manifestDigest}`), ...fixture.tail]
        : fixture.ids
      const firstPayload = checkpoint === "active" ? 990 : 0
      const payloads = Array.from({ length: checkpoint === "active" ? 10 : 1000 }, (_, offset) =>
        `${firstPayload + offset}:` + "x".repeat(8192),
      )
      for (let round = 0; round < 16; round++) {
        const history = yield* SessionHistory.entriesForRunner(db, fixture.sessionID, [])
        expect(history.entries.map((entry) => entry.message.id)).toEqual(expected)
        const messages = checkpoint === "active" ? history.entries.slice(1) : history.entries
        expect(messages.map(({ message }) => {
          if (message.type !== "synthetic") throw new Error("Expected synthetic fixture history")
          return message.text
        })).toEqual(payloads)
        if (checkpoint === "active") {
          const first = history.entries[0].message
          expect(first.type === "synthetic" && first.text).toContain(fixture.summary.text)
        }
      }
      expect(yield* db.get<{ count: number }>(sql`SELECT COUNT(*) AS count FROM session_message`)).toEqual({ count: 1000 })
    }),
  )
}
