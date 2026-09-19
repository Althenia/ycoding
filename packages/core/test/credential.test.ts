import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Credential } from "@ycoding-ai/core/credential"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Integration } from "@ycoding-ai/core/integration"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(Credential.node))

describe("Credential", () => {
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
