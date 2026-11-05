export * as StandaloneConfig from "./standalone"

import { Context, Effect, Layer, Schema, Semaphore } from "effect"
import { parse, type ParseError } from "jsonc-parser"
import { Config } from "../config"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { builtinAgentIDs } from "../agent/builtin-ids"

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()(
  "StandaloneConfig.InvalidError",
  { reason: Schema.Literals(["invalid", "file-reference", "environment-reference", "closed", "stale", "read"]) },
) {}

export interface Snapshot {
  readonly entries: readonly Config.Document[]
  readonly generation: number
}

export interface Interface {
  readonly snapshot: () => Effect.Effect<Snapshot, InvalidError>
  readonly reload: () => Effect.Effect<void, InvalidError>
  readonly assert: (generation: number) => Effect.Effect<void, InvalidError>
  readonly withCurrent: <A, E, R>(
    generation: number,
    use: (validate: Effect.Effect<void, InvalidError>) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | InvalidError, R>
}
export class Service extends Context.Service<Service, Interface>()("@ycoding/StandaloneConfig") {}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const freeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

export const layer = Layer.effect(Service, Effect.gen(function* () {
  const context = yield* Effect.context<FSUtil.Service | Global.Service>()
  const ids = new Set<string>(Object.values(builtinAgentIDs))
  const lock = Semaphore.makeUnsafe(1)
  let closed = false
  let previous = ""
  let generation = 0
  yield* Effect.addFinalizer(() => Effect.sync(() => { closed = true }))

  const load = () => Effect.gen(function* () {
    if (closed) return yield* new InvalidError({ reason: "closed" })
    const sources = yield* Config.readGlobalSources(true).pipe(
      Effect.provideContext(context),
      Effect.mapError(() => new InvalidError({ reason: "read" })),
    )
    if (closed) return yield* new InvalidError({ reason: "closed" })
    const projected: { target: string; info: Record<string, unknown> }[] = []
    let invalid = false
    for (const source of sources) {
      if (source.text === undefined) continue
      const errors: ParseError[] = []
      const input: unknown = parse(source.text, errors, { allowTrailingComma: true })
      if (errors.length || !record(input)) { invalid = true; continue }
      const selected: Record<string, unknown> = {}
      for (const key of ["model", "model_fallbacks", "default_agent", "permissions", "providers", "efficiency", "guardrails", "coordination", "memory", "capabilities", "compaction", "experimental"]) {
        if (key in input) selected[key] = input[key]
      }
      if (record(input.agents)) selected.agents = Object.fromEntries(Object.entries(input.agents).filter(([id]) => ids.has(id)))
      else if ("agents" in input) selected.agents = input.agents
      projected.push({ target: source.target, info: selected })
    }
    const next = JSON.stringify([sources, projected, invalid])
    if (previous !== next) { previous = next; generation++ }
    if (invalid) return yield* new InvalidError({ reason: "invalid" })
    const selected = JSON.stringify(projected.map(({ info }) => info))
    if (selected.includes("{env:")) return yield* new InvalidError({ reason: "environment-reference" })
    if (selected.includes("{file:")) return yield* new InvalidError({ reason: "file-reference" })
    const entries: Config.Document[] = []
    for (const { target, info } of projected) {
      const parsed = yield* Schema.decodeUnknownEffect(Config.Info)(info).pipe(Effect.mapError(() => new InvalidError({ reason: "invalid" })))
      entries.push(new Config.Document({ type: "document", scope: "global", path: target, info: parsed }))
    }
    if (closed) return yield* new InvalidError({ reason: "closed" })
    return freeze({ entries, generation })
  }).pipe(Effect.tapError(() => Effect.sync(() => { previous = ""; generation++ })))
  const snapshot = () => lock.withPermit(load())
  const withCurrent: Interface["withCurrent"] = (expected, use) => lock.withPermit(Effect.gen(function* () {
    const current = yield* load()
    if (current.generation !== expected) return yield* new InvalidError({ reason: "stale" })
    const validate = Effect.suspend(() => !closed && generation === expected
      ? Effect.void
      : Effect.fail(new InvalidError({ reason: closed ? "closed" : "stale" })))
    return yield* use(validate)
  }))
  return Service.of({
    snapshot,
    withCurrent,
    reload: () => snapshot().pipe(Effect.asVoid),
    assert: (expected) => lock.withPermit(load().pipe(Effect.flatMap((current) =>
      !closed && current.generation === expected ? Effect.void : Effect.fail(new InvalidError({ reason: closed ? "closed" : "stale" }))))),
  })
}))

export const node = makeLocationNode({ service: Service, layer, deps: [FSUtil.node, Global.node] })
