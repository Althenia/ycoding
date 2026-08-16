import { expect, test } from "bun:test"
import { ProjectV2 } from "@ycoding-ai/core/project"
import { SessionRoot } from "@ycoding-ai/core/session/root"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { DateTime, Effect } from "effect"
import { Money } from "@ycoding-ai/schema/money"

const session = (id: string, parentID?: string) =>
  SessionSchema.Info.make({
    id: SessionSchema.ID.make(id),
    projectID: ProjectV2.ID.global,
    cost: Money.USD.zero,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
    title: "Session",
    location: { directory: AbsolutePath.make("/project") },
    ...(parentID === undefined ? {} : { parentID: SessionSchema.ID.make(parentID) }),
  })

test("resolves a child Session to its root family", async () => {
  const root = session("ses_root")
  const child = session("ses_child", root.id)
  const grandchild = session("ses_grandchild", child.id)
  const sessions = new Map([root, child, grandchild].map((item) => [item.id, item]))

  const actual = await Effect.runPromise(SessionRoot.resolve({ get: (id) => Effect.succeed(sessions.get(id)) }, grandchild))

  expect(actual).toBe(root.id)
})
