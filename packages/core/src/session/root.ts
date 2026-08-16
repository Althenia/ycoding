export * as SessionRoot from "./root"

import { Effect } from "effect"
import { SessionSchema } from "./schema"
import { SessionStore } from "./store"

export const resolve = (
  store: Pick<SessionStore.Interface, "get">,
  session: SessionSchema.Info,
): Effect.Effect<SessionSchema.ID> => {
  if (!session.parentID) return Effect.succeed(session.id)
  return store.get(session.parentID).pipe(
    Effect.flatMap((parent) => {
      if (parent) return resolve(store, parent)
      return Effect.die(new Error(`Parent Session not found: ${session.parentID}`))
    }),
  )
}
