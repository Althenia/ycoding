export * as AutonomyDefaults from "./autonomy-defaults"

import { AutonomyDefaults } from "@ycoding-ai/schema/autonomy-defaults"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { Context, Effect, Layer, Result, Schema, Semaphore } from "effect"
import path from "node:path"
import { Config } from "./config"
import { ConfigVariable } from "./config/variable"
import { makeGlobalNode } from "./effect/app-node"
import { FSUtil } from "./fs-util"
import { Global } from "./global"

export const Info = AutonomyDefaults.Info
export type Info = AutonomyDefaults.Info
export const Change = AutonomyDefaults.Change
export type Change = AutonomyDefaults.Change
export type Mode = AutonomyDefaults.Mode

const categories = ["permissions", "guardrails", "answers"] as const
type Category = (typeof categories)[number]

interface Defaults {
  readonly modes: Readonly<Record<Category, Mode>>
  readonly acceptedAt: Readonly<Partial<Record<Category, number>>>
}

const manual: Defaults = { modes: { permissions: "manual", guardrails: "manual", answers: "manual" }, acceptedAt: {} }
const isMode = Schema.is(AutonomyDefaults.Mode)

export class RefusedError extends Schema.TaggedErrorClass<RefusedError>()("AutonomyDefaults.Refused", {
  reason: Schema.Literals(["no-category", "risk-not-accepted"]),
  message: Schema.String,
}) {}

export class WriteError extends Schema.TaggedErrorClass<WriteError>()("AutonomyDefaults.WriteFailed", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly get: Effect.Effect<Info>
  readonly set: (change: Change) => Effect.Effect<Info, RefusedError | WriteError>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/AutonomyDefaults") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const lock = Semaphore.makeUnsafe(1)

    const read = Effect.gen(function* () {
      const sources = yield* Config.readGlobalSources().pipe(Effect.provideService(FSUtil.Service, fs), Effect.provideService(Global.Service, global))
      const documents = yield* Effect.forEach(
        sources.filter((source): source is { target: string; text: string } => !!source.text),
        (source) =>
          ConfigVariable.substitute({ type: "path", path: source.target, text: source.text }).pipe(
            Effect.provideService(FSUtil.Service, fs),
            Effect.flatMap((text) => Config.parseDocument(text, source.target)),
          ),
      )
      if (documents.some((document) => document.diagnostics.length > 0)) return manual
      return normalize(documents.findLast((document) => document.info?.autonomy?.defaults !== undefined)?.info?.autonomy?.defaults)
    }).pipe(Effect.orElseSucceed(() => manual))

    const target = Effect.gen(function* () {
      const existing = yield* Effect.filter(
        ["ycoding.json", "ycoding.jsonc"].map((name) => path.join(global.config, name)),
        (file) => fs.exists(file).pipe(Effect.orElseSucceed(() => false)),
      )
      return existing[0] ?? path.join(global.config, "ycoding.json")
    })

    const write = Effect.fnUntraced(function* (change: Change) {
      const file = yield* target
      const text = (yield* fs.readFileStringSafe(file)) ?? "{}\n"
      const errors: ParseError[] = []
      const root: unknown = parse(text.replace(/^\uFEFF/, ""), errors, { allowTrailingComma: true })
      if (errors.length > 0 || !isRecord(root)) return yield* new WriteError({ message: "The global configuration is not valid JSONC" })
      const current = normalize(isRecord(root.autonomy) ? root.autonomy.defaults : undefined)
      const next = yield* Effect.fromResult(apply(current, change, Date.now()))
      const updated = applyEdits(text, modify(text, ["autonomy", "defaults"], encode(next), { formattingOptions: { tabSize: 2, insertSpaces: true } }))
      const temporary = `${file}.${process.pid}.tmp`
      yield* fs.makeDirectory(path.dirname(file), { recursive: true })
      yield* fs.writeFileString(temporary, updated, { mode: 0o600 })
      yield* fs.rename(temporary, file)
    })

    return Service.of({
      get: read.pipe(Effect.map(view)),
      set: Effect.fn("AutonomyDefaults.set")((change: Change) =>
        lock.withPermits(1)(
          write(change).pipe(
            Effect.catchTag(["PlatformError", "FileSystemError"], (error) => Effect.fail(new WriteError({ message: error.message }))),
            Effect.andThen(read),
            Effect.map(view),
          ),
        ),
      ),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [FSUtil.node, Global.node] })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function timestamp(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function normalize(value: unknown): Defaults {
  if (!isRecord(value)) return manual
  const accepted = isRecord(value.yolo_accepted_at) ? value.yolo_accepted_at : {}
  const entries = categories.map((category) => {
    const mode = isMode(value[category]) ? value[category] : "manual"
    const at = timestamp(accepted[category])
    return [category, mode === "yolo" && at === undefined ? "manual" : mode, mode === "yolo" ? at : undefined] as const
  })
  return {
    modes: Object.fromEntries(entries.map(([category, mode]) => [category, mode])) as Defaults["modes"],
    acceptedAt: Object.fromEntries(entries.flatMap(([category, , at]) => (at === undefined ? [] : [[category, at]]))),
  }
}

function view(defaults: Defaults): Info {
  return {
    ...defaults.modes,
    ...(Object.keys(defaults.acceptedAt).length > 0 ? { yoloAcceptedAt: defaults.acceptedAt } : {}),
  }
}

function encode(defaults: Defaults) {
  return {
    ...defaults.modes,
    ...(Object.keys(defaults.acceptedAt).length > 0 ? { yolo_accepted_at: defaults.acceptedAt } : {}),
  }
}

function apply(current: Defaults, change: Change, now: number) {
  if (categories.every((category) => change[category] === undefined))
    return Result.fail(new RefusedError({ reason: "no-category", message: "At least one autonomy category is required" }))
  const resolved = categories.map((category) => {
    const requested = change[category]
    const accepted = current.acceptedAt[category]
    if (requested === undefined) return Result.succeed([category, current.modes[category], accepted] as const)
    if (requested !== "yolo") return Result.succeed([category, requested, undefined] as const)
    if (current.modes[category] === "yolo" && accepted !== undefined) return Result.succeed([category, "yolo", accepted] as const)
    if (change.acceptYolo === true) return Result.succeed([category, "yolo", now] as const)
    return Result.fail(
      new RefusedError({ reason: "risk-not-accepted", message: "Saving a YOLO default requires explicit risk acceptance" }),
    )
  })
  return Result.all(resolved).pipe(
    Result.map((entries) => ({
      modes: Object.fromEntries(entries.map(([category, mode]) => [category, mode])) as Defaults["modes"],
      acceptedAt: Object.fromEntries(entries.flatMap(([category, , at]) => (at === undefined ? [] : [[category, at]]))),
    })),
  )
}
