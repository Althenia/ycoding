export * as ProviderRequestObserver from "./provider-request-observer"

import type { TransportAttempt } from "@ycoding-ai/ai/route"
import { Effect } from "effect"

const registrations: Array<{ readonly token: object; readonly observer: TransportAttempt.Observer }> = []

export const observe: TransportAttempt.Observer = (info) => registrations.at(-1)?.observer(info) ?? Effect.void

export const register = (observer: TransportAttempt.Observer) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const token = {}
      registrations.push({ token, observer })
      return token
    }),
    (token) =>
      Effect.sync(() => {
        const index = registrations.findIndex((registration) => registration.token === token)
        if (index >= 0) registrations.splice(index, 1)
      }),
  ).pipe(Effect.asVoid)
