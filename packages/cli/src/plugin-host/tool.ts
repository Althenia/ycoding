export * as PluginTool from "./tool"

import type { Effect, Schema } from "effect"
import { runtime } from "./sdk"

// The plugin tool contract executed inside the host. Plugins build these objects with their own
// @ycoding-ai/plugin copy; the host reads them structurally so the frontend graph stays free of it.
export type Content =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "file"; readonly data: string; readonly mime: string; readonly name?: string }
export type Progress = {
  readonly structured: Readonly<Record<string, unknown>>
  readonly content?: ReadonlyArray<Content>
}
export type Context = {
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly callID: string
  readonly progress: (update: Progress) => Effect.Effect<void>
}
export type AnyTool = Record<string, any> & { readonly description: string; readonly execute: (...args: any[]) => any }
export type RegisterOptions = { readonly namespace?: string; readonly codemode?: boolean; readonly paths?: Readonly<Record<string, string>> }
export type Output = {
  readonly structured: unknown
  readonly content: ReadonlyArray<
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
  >
}

export class Failure extends Error {}

export function normalize(name: string) {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_")
}

export function permission(tool: AnyTool, name: string): string {
  return typeof tool.permission === "string" ? tool.permission : name
}

export function definition(tool: AnyTool) {
  if ("jsonSchema" in tool) return { description: tool.description, input: tool.jsonSchema, output: tool.outputSchema }
  return {
    description: tool.description,
    input: jsonSchema(tool.input, "input"),
    output: jsonSchema(tool.structured ?? tool.output, "output"),
  }
}

export function settle(tool: AnyTool, input: unknown, context: Context): Effect.Effect<Output, unknown> {
  return runtime.Effect.gen(function* () {
    if ("jsonSchema" in tool) {
      const output = yield* run(tool.execute(input, context))
      return { structured: output.structured, content: (output.content ?? []).map(content) }
    }
    const decoded = yield* validate(tool.input, input, "decode", "Invalid tool input")
    const value = yield* run(tool.execute(decoded, context))
    const output = yield* validate(tool.output, value, "encode", "Tool returned an invalid value for its output schema")
    const structured =
      tool.structured && tool.toStructuredOutput
        ? yield* validate(
            tool.structured,
            tool.toStructuredOutput({ input: decoded, output }),
            "encode",
            "Tool returned an invalid value for its output schema",
          )
        : output
    const model = tool.toModelOutput?.({ input: decoded, output }) as ReadonlyArray<Content> | undefined
    return {
      structured,
      content: model?.map(content) ?? (typeof output === "string" ? [{ type: "text" as const, text: output }] : []),
    }
  })
}

export function fromPromise(tool: AnyTool, track: <A>(task: Promise<A>) => Promise<A>): AnyTool {
  return {
    ...tool,
    execute: (input: unknown, context: Context) =>
      runtime.Effect.tryPromise({
        try: () =>
          track(Promise.resolve(tool.execute(input, {
            ...context,
            progress: (update: Progress) => runtime.Effect.runPromise(context.progress(update)),
          }))),
        catch: (error) => error,
      }),
  }
}

function run(value: unknown): Effect.Effect<any, unknown> {
  if (runtime.Effect.isEffect(value)) return value as Effect.Effect<any, unknown>
  return runtime.Effect.tryPromise({ try: () => Promise.resolve(value), catch: (error) => error })
}

function content(part: Content) {
  if (part.type === "text") return { type: "text" as const, text: part.text }
  return { type: "file" as const, uri: `data:${part.mime};base64,${part.data}`, mime: part.mime, name: part.name }
}

function validate(
  schema: any,
  value: unknown,
  direction: "decode" | "encode",
  prefix: string,
): Effect.Effect<unknown, Failure> {
  if (runtime.Schema.isSchema(schema)) {
    const codec = schema as Schema.Codec<unknown, unknown, never, never>
    const coded =
      direction === "decode"
        ? runtime.Schema.decodeUnknownEffect(codec)(value)
        : runtime.Schema.encodeEffect(codec)(value)
    return coded.pipe(runtime.Effect.mapError((error) => new Failure(`${prefix}: ${error.message}`)))
  }
  return runtime.Effect.tryPromise({
    try: async () => {
      const result = await schema["~standard"].validate(value)
      if (result.issues)
        throw new Failure(`${prefix}: ${result.issues.map((issue: { message: string }) => issue.message).join(", ")}`)
      return result.value
    },
    catch: (error) =>
      error instanceof Failure
        ? error
        : new Failure(`${prefix}: ${error instanceof Error ? error.message : String(error)}`),
  })
}

function jsonSchema(schema: any, direction: "input" | "output") {
  if (!runtime.Schema.isSchema(schema)) return schema["~standard"].jsonSchema[direction]({ target: "draft-2020-12" })
  const document = runtime.Schema.toJsonSchemaDocument(schema as Schema.Top)
  if (Object.keys(document.definitions).length === 0) return document.schema
  return { ...document.schema, $defs: document.definitions }
}
