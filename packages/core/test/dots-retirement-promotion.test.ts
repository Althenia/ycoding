import { expect } from "bun:test"
import { tmpdir } from "node:os"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { Dots } from "@ycoding-ai/schema/dots"
import { AbsolutePath } from "@ycoding-ai/schema/schema"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { EventRuntime } from "../src/event"
import { EventTable } from "../src/event/sql"
import { Session } from "../src/session"
import { SessionEvent } from "../src/session/event"
import { SessionExecution } from "../src/session/execution"
import { SessionMessage } from "../src/session/message"
import { SessionPending } from "../src/session/pending"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventRuntime.node, Session.node]), [
  [SessionExecution.node, SessionExecution.noopLayer],
]))

for (const delivery of ["queue", "steer"] as const)
  for (const kind of ["routine", "delegated"] as const)
    it.live(`${delivery} promotion rejects retired ${kind} authority once and preserves ordinary and native inputs`, () => Effect.gen(function* () {
      const sessions = yield* Session.Service
      const db = (yield* Database.Service).db
      const events = yield* EventRuntime.Service
      const root = yield* sessions.create({ location: { directory: AbsolutePath.make(tmpdir()) } })
      const inputID = SessionMessage.ID.make(`msg_retired_${kind}_${delivery}`)
      const delegation = { id: "delegation_fixture", revision: 1 }
      const receipt = kind === "routine"
        ? { routine: { delegation, taskInputID: SessionMessage.ID.make("msg_task_fixture"), instruction: { operation: "continue" as const } } }
        : { delegated: { delegation, instruction: { operation: "task" as const, text: "Synthetic task" } } }
      const record: Dots.ExchangeRecord = {
        sessionID: root.id, targetSessionID: root.id, inputID, exchangeID: `exchange_${kind}_${delivery}`,
        expectedAttachment: { profile: "fixture", dotID: "dot_fixture", threadID: "thread_fixture", generation: "generation_fixture", label: "Fixture" },
        accountDigest: "a".repeat(64), fingerprint: "b".repeat(64), grantID: "grant_fixture",
        source: { requestID: "request_fixture", epoch: "epoch_fixture", principal: { ownerID: "owner_fixture", deviceID: "device_fixture", clientID: "client_fixture" } },
        scope: { rootSessionID: root.id }, ...receipt,
      }
      yield* events.publish(SessionEvent.DotsExchangeCreated, record)
      yield* sessions.prompt({ id: inputID, sessionID: root.id, text: "Synthetic retired instruction", delivery, origin: "plugin", resume: false,
        metadata: { dotsExchange: { sessionID: root.id, exchangeID: record.exchangeID, ...receipt } } })
      const prepared: SessionMessage.ID[] = []
      const prepare = (entry: SessionPending.Info) => Effect.sync(() => { prepared.push(entry.id) })
      const promote = () => delivery === "queue"
        ? SessionPending.promoteNextQueued(db, events, root.id, prepare)
        : SessionPending.promoteSteers(db, events, root.id, prepare)
      expect(Number(yield* promote())).toBe(0)
      expect(prepared).toEqual([])
      expect(yield* SessionPending.find(db, inputID)).toBeUndefined()
      expect(yield* sessions.message({ sessionID: root.id, messageID: inputID })).toBeUndefined()
      yield* promote()
      const rejected = yield* db.select().from(EventTable).where(eq(EventTable.type,
        EventRuntime.versionedType(SessionEvent.DotsInstructionRejected.type, 1))).all().pipe(Effect.orDie)
      expect(rejected.filter((event) => event.aggregate_id === root.id).map((event) => event.data)).toEqual([{
        sessionID: root.id, inputID, anchorSessionID: root.id, exchangeID: record.exchangeID,
        delegationID: delegation.id, reason: "delegation_invalid",
      }])
      for (const origin of ["user", "native"] as const) {
        const input = yield* sessions.prompt({ sessionID: root.id, text: `Synthetic ${origin} input`, delivery, resume: false,
          ...(origin === "native" ? { native: { validate: () => Effect.succeed(true), source: {
            kind: "dots-native" as const, profile: "synthetic", credentialID: "synthetic", accountID: "synthetic", accountGeneration: 0,
            environmentID: "environment", connectionID: "connection", clientID: "client", streamID: "stream", rootSessionID: root.id, accessRevision: 1, requestID: "request",
          } } } : {}),
        })
        yield* events.publish(SessionEvent.DotsExchangeCreated, { ...record, inputID: input.id, exchangeID: `${record.exchangeID}_${origin}` })
        expect(Number(yield* promote())).toBe(1)
        expect((yield* sessions.message({ sessionID: root.id, messageID: input.id }))?.type).toBe("user")
      }
      const historical = yield* db.select().from(EventTable).where(eq(EventTable.type,
        EventRuntime.versionedType(SessionEvent.DotsExchangeCreated.type, 1))).all().pipe(Effect.orDie)
      expect(historical.some((event) => event.aggregate_id === root.id)).toBe(true)
      expect(prepared).toHaveLength(2)
    }))
