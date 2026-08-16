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

      const replacement = yield* credentials.create({
        integrationID,
        label: "Replacement",
        value: Credential.Key.make({ type: "key", key: "replacement" }),
      })
      expect(yield* credentials.list(integrationID)).toEqual([replacement])

      yield* credentials.remove(replacement.id)
      expect(yield* credentials.list(integrationID)).toEqual([])
    }),
  )
})
