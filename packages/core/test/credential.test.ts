import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { Credential } from "@ycoding-ai/core/credential"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Integration } from "@ycoding-ai/core/integration"
import { Database } from "@ycoding-ai/core/database/database"
import { CredentialTable } from "@ycoding-ai/core/credential/sql"
import { eq, sql } from "drizzle-orm"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Credential.node, Database.node])))

describe("Credential", () => {
  for (const rejected of [true, false])
    it.effect(
      `adopts another process's same-account rotation after ${rejected ? "rejected" : "successful"} refresh`,
      () =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const database = yield* Database.Service
          const value = Credential.OAuth.make({
            type: "oauth",
            methodID: Integration.MethodID.make("chatgpt-headless"),
            access: "fixture-old",
            refresh: "fixture-old-refresh",
            expires: 0,
          })
          const created = yield* credentials.create({ integrationID: Integration.ID.make("openai"), value })
          const newer = Credential.OAuth.make({
            ...value,
            access: "fixture-new",
            refresh: "fixture-new-refresh",
            expires: 600_000,
          })
          const refreshed = yield* credentials.refresh(
            created,
            Effect.gen(function* () {
              yield* database.db
                .update(CredentialTable)
                .set({ value: newer, generation: sql`${CredentialTable.generation} + 1` })
                .where(eq(CredentialTable.id, created.id))
                .run()
              if (rejected) return yield* Effect.fail(new Error("fixture rejected consumed refresh token"))
              return Credential.OAuth.make({ ...newer, access: "fixture-late" })
            }),
          )
          expect(refreshed?.value).toEqual(newer)
          expect(refreshed?.generation).toBe(1)
          expect(refreshed?.accountGeneration).toBe(created.accountGeneration)
          expect((yield* credentials.get(created.id))?.value).toEqual(newer)
          expect(yield* credentials.refresh(created, Effect.die("must not reuse rotated token"))).toEqual(refreshed)
        }),
    )

  it.effect("keeps the stored credential and propagates rejection without a fresh same-account rotation", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const value = Credential.OAuth.make({
        type: "oauth",
        methodID: Integration.MethodID.make("chatgpt-headless"),
        access: "fixture-old",
        refresh: "fixture-refresh",
        expires: 0,
      })
      const created = yield* credentials.create({ integrationID: Integration.ID.make("openai"), value })
      const error = new Error("fixture refresh rejected")
      expect(yield* credentials.refresh(created, Effect.fail(error)).pipe(Effect.flip)).toBe(error)
      expect(yield* credentials.get(created.id)).toEqual(created)
      yield* credentials.create({
        integrationID: created.integrationID,
        value: Credential.OAuth.make({
          ...value,
          access: "fixture-replacement",
          expires: 600_000,
        }),
      })
      expect(yield* credentials.refresh(created, Effect.die("must not refresh replaced account"))).toBeUndefined()
    }),
  )

  for (const replaced of [true, false])
    it.effect(`does not adopt ${replaced ? "a replacement account" : "an expired rotation"} after rejection`, () =>
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        const database = yield* Database.Service
        const value = Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("chatgpt-headless"),
          access: "fixture-old",
          refresh: "fixture-refresh",
          expires: 0,
        })
        const created = yield* credentials.create({ integrationID: Integration.ID.make("openai"), value })
        const newer = Credential.OAuth.make({ ...value, access: "fixture-newer", expires: replaced ? 600_000 : 0 })
        const error = new Error("fixture rejected")
        const rejected = yield* credentials
          .refresh(
            created,
            Effect.gen(function* () {
              yield* database.db
                .update(CredentialTable)
                .set({
                  value: newer,
                  generation: sql`${CredentialTable.generation} + 1`,
                  account_generation: created.accountGeneration + (replaced ? 1 : 0),
                })
                .where(eq(CredentialTable.id, created.id))
                .run()
              return yield* Effect.fail(error)
            }),
          )
          .pipe(Effect.flip)
        expect(rejected).toBe(error)
        expect((yield* credentials.get(created.id))?.value).toEqual(newer)
      }),
    )

  it.effect("shares one refresh while distinct credentials progress independently and fences stale settlement", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const value = Credential.OAuth.make({
        type: "oauth",
        methodID: Integration.MethodID.make("test"),
        access: "old",
        refresh: "refresh",
        expires: 0,
      })
      const work = yield* credentials.create({ integrationID: Integration.ID.make("test"), label: "Work", value })
      const personal = yield* credentials.create({ integrationID: work.integrationID, label: "Personal", value })
      const gate = yield* Deferred.make<void>()
      const entered = yield* Deferred.make<void>()
      let count = 0
      const refresh = Effect.gen(function* () {
        count += 1
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(gate)
        return Credential.OAuth.make({ ...value, access: "new" })
      })
      const first = yield* credentials.refresh(work, refresh).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      const second = yield* credentials.refresh(work, refresh).pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      expect(
        (yield* credentials.refresh(personal, Effect.succeed(Credential.OAuth.make({ ...value, access: "personal" }))))
          ?.value,
      ).toMatchObject({ access: "personal" })
      yield* credentials.create({
        integrationID: work.integrationID,
        label: work.label,
        value: Credential.OAuth.make({ ...value, access: "replacement" }),
      })
      yield* Deferred.succeed(gate, undefined)
      expect(yield* Fiber.join(first)).toBeUndefined()
      expect(yield* Fiber.join(second)).toBeUndefined()
      expect(count).toBe(1)
      expect((yield* credentials.get(work.id))?.value).toMatchObject({ access: "replacement" })
    }),
  )

  it.effect("preserves account identity on refresh and rejects replacement or deleted snapshots", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const value = Credential.OAuth.make({
        type: "oauth",
        methodID: Integration.MethodID.make("test"),
        access: "old",
        refresh: "refresh",
        expires: 0,
      })
      const created = yield* credentials.create({ integrationID: Integration.ID.make("test"), label: "Work", value })
      expect(created.accountGeneration).toBe(0)
      const refreshed = yield* credentials.refresh(
        created,
        Effect.succeed(Credential.OAuth.make({ ...value, access: "new", expires: 10000 })),
      )
      expect(refreshed?.accountGeneration).toBe(created.accountGeneration)
      expect(refreshed?.generation).toBe(1)
      const replaced = yield* credentials.create({ integrationID: created.integrationID, label: created.label, value })
      expect(replaced.accountGeneration).toBe(1)
      expect(yield* credentials.refresh(created, Effect.succeed(value))).toBeUndefined()
      expect((yield* credentials.get(created.id))?.value).toEqual(value)
      yield* credentials.remove(created.id)
      expect(yield* credentials.refresh(replaced, Effect.succeed(value))).toBeUndefined()
      expect(yield* credentials.get(created.id)).toBeUndefined()
    }),
  )

  it.effect("stores, updates, lists, and removes credentials", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("openai")
      const created = yield* credentials.create({
        integrationID,
        label: "Work",
        value: Credential.Key.make({ type: "key", key: "secret" }),
      })

      expect(created.generation).toBe(0)
      expect(yield* credentials.list(integrationID)).toEqual([created])
      yield* credentials.update(created.id, { label: "Personal" })
      expect((yield* credentials.list(integrationID))[0]).toMatchObject({ label: "Personal", generation: 0 })
      yield* credentials.update(created.id, { value: Credential.Key.make({ type: "key", key: "secret" }) })
      expect((yield* credentials.list(integrationID))[0]?.generation).toBe(0)
      yield* credentials.update(created.id, { value: Credential.Key.make({ type: "key", key: "rotated" }) })
      expect((yield* credentials.list(integrationID))[0]?.generation).toBe(1)

      // Re-using a profile name updates that profile instead of evicting every sibling.
      const replacement = yield* credentials.create({
        integrationID,
        label: "Personal",
        value: Credential.Key.make({ type: "key", key: "replacement" }),
      })
      expect(replacement.id).toBe(created.id)
      expect(yield* credentials.list(integrationID)).toEqual([replacement])

      yield* credentials.remove(replacement.id)
      expect(yield* credentials.list(integrationID)).toEqual([])
    }),
  )

  it.effect("keeps several named profiles and marks exactly one active", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("anthropic")
      const work = yield* credentials.create({
        integrationID,
        label: "Work",
        value: Credential.Key.make({ type: "key", key: "work" }),
      })
      const personal = yield* credentials.create({
        integrationID,
        label: "Personal",
        value: Credential.Key.make({ type: "key", key: "personal" }),
      })

      const listed = yield* credentials.list(integrationID)
      expect(listed.map((credential) => credential.label)).toEqual(["Work", "Personal"])
      expect(listed.filter((credential) => credential.active)).toHaveLength(1)
      // The newest profile becomes active; the earlier one stays stored.
      expect(listed.find((credential) => credential.active)?.id).toBe(personal.id)
      expect(work.id).not.toBe(personal.id)

      yield* credentials.activate(work.id)
      const activated = yield* credentials.list(integrationID)
      expect(activated.filter((credential) => credential.active).map((credential) => credential.id)).toEqual([work.id])

      // Removing the active profile leaves the remaining one active rather than none.
      yield* credentials.remove(work.id)
      const remaining = yield* credentials.list(integrationID)
      expect(remaining.map((credential) => credential.id)).toEqual([personal.id])
    }),
  )
})
