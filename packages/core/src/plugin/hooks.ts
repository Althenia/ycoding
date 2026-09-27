export * as PluginHooks from "./hooks"

import { Message } from "@ycoding-ai/ai"
import type { AISDKHooks } from "@ycoding-ai/plugin/effect/aisdk"
import type { SessionContext, SessionHooks } from "@ycoding-ai/plugin/effect/session"
import type { ToolHooks } from "@ycoding-ai/plugin/effect/tool"
import { Context, Effect, Layer, Scope } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { State } from "../state"

export interface Domains {
  readonly aisdk: AISDKHooks
  readonly session: SessionHooks
  readonly tool: ToolHooks
}

type Callback<Event> = (event: Event) => Effect.Effect<void>

const isSessionContext = (event: unknown): event is SessionContext =>
  typeof event === "object" && event !== null && "sessionID" in event && typeof event.sessionID === "string" &&
  "messages" in event && Array.isArray(event.messages)

export interface Interface {
  readonly register: <Domain extends keyof Domains, Name extends keyof Domains[Domain]>(
    domain: Domain,
    name: Name,
    callback: Callback<Domains[Domain][Name]>,
  ) => Effect.Effect<State.Registration, never, Scope.Scope>
  readonly trigger: <Domain extends keyof Domains, Name extends keyof Domains[Domain]>(
    domain: Domain,
    name: Name,
    event: Domains[Domain][Name],
  ) => Effect.Effect<Domains[Domain][Name]>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/PluginHooks") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const callbacks = new Map<string, Function[]>()
    const key = (domain: keyof Domains, name: PropertyKey) => `${domain}.${String(name)}`

    const register: Interface["register"] = Effect.fn("PluginHooks.register")(function* (domain, name, callback) {
      const scope = yield* Scope.Scope
      const id = key(domain, name)
      let active = true
      callbacks.set(id, [...(callbacks.get(id) ?? []), callback])
      const dispose = Effect.sync(() => {
        if (!active) return
        active = false
        const next = (callbacks.get(id) ?? []).filter((item) => item !== callback)
        if (next.length === 0) callbacks.delete(id)
        else callbacks.set(id, next)
      })
      yield* Scope.addFinalizer(scope, dispose)
      return { dispose }
    })

    const trigger: Interface["trigger"] = Effect.fn("PluginHooks.trigger")(function* (domain, name, event) {
      for (const callback of callbacks.get(key(domain, name)) ?? []) {
        if (domain === "session" && name === "context" && isSessionContext(event)) {
          yield* Effect.suspend((): Effect.Effect<void> => Reflect.apply(callback, undefined, [event])).pipe(
            Effect.catchDefect(() => Effect.gen(function* () {
              yield* Effect.logWarning("Session context hook failed", { sessionID: event.sessionID, routeID: event.routeID })
              event.messages.push(Message.user("Session context hook failed; its changes may be incomplete."))
            })),
          )
          continue
        }
        const result: Effect.Effect<void> = Reflect.apply(callback, undefined, [event])
        yield* result
      }
      return event
    })

    return Service.of({ register, trigger })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [] })
