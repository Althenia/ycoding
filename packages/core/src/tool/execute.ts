export * as ExecuteTool from "./execute"

import { CodeMode, DiscoveryPrompt, Tool, toolError } from "@ycoding-ai/codemode"
import { ToolOutput, type ToolFailure } from "@ycoding-ai/ai"
import { Effect, Ref, Schema, Semaphore } from "effect"
import { definition, make, type AnyTool, type Context } from "./tool"

const ExecuteFile = Schema.Struct({
  data: Schema.String,
  mime: Schema.String,
  name: Schema.optionalKey(Schema.String),
})

const ExecuteCall = Schema.Struct({
  tool: Schema.String,
  status: Schema.Literals(["running", "completed", "error"]),
  id: Schema.optionalKey(Schema.String),
  index: Schema.optionalKey(Schema.Number),
  name: Schema.optionalKey(Schema.String),
  input: Schema.optionalKey(Schema.Unknown),
  structured: Schema.optionalKey(Schema.Unknown),
})

type ExecuteCall = typeof ExecuteCall.Type

const ExecuteMetadata = Schema.Struct({
  toolCalls: Schema.Array(ExecuteCall),
  error: Schema.optionalKey(Schema.Literal(true)),
})

const ExecuteOutput = Schema.Struct({
  output: Schema.String,
  toolCalls: Schema.Array(ExecuteCall),
  error: Schema.optionalKey(Schema.Literal(true)),
  files: Schema.Array(ExecuteFile),
})

type CollectedFiles = {
  readonly index: number
  readonly files: Array<typeof ExecuteFile.Type>
}

interface Registration {
  readonly tool: AnyTool
  readonly name: string
  readonly path: string
}

export const create = (
  registrations: ReadonlyMap<string, Registration>,
  invokeNested: (
    name: string,
    tool: AnyTool,
    input: unknown,
    context: Context,
  ) => Effect.Effect<ToolOutput, ToolFailure>,
) => {
  const runtime = (
    invoke: (name: string, registration: Registration, input: unknown) => Effect.Effect<unknown, unknown>,
    hooks: CodeMode.ToolCallHooks,
  ) => {
    const tools: Record<string, Tool.Definition<never>> = {}
    for (const [name, registration] of registrations) {
      const child = definition(name, registration.tool)
      const value = Tool.make({
        description: child.description,
        input: child.inputSchema,
        output: child.outputSchema,
        run: (input) => invoke(name, registration, input),
      })
      tools[registration.path] = value
    }
    return CodeMode.make<typeof tools>({
      tools,
      limits: { maxSteps: 60_000_000, maxToolCalls: 1000, maxOutputBytes: 1048576 },
      ...hooks,
    })
  }
  return make({
    description: DiscoveryPrompt.EXECUTE_DESCRIPTION,
    input: CodeMode.Input,
    output: ExecuteOutput,
    structured: ExecuteMetadata,
    toStructuredOutput: ({ output }) => ({
      toolCalls: output.toolCalls,
      ...(output.error ? { error: true as const } : {}),
    }),
    toModelOutput: ({ output }) => [
      { type: "text" as const, text: output.output },
      ...output.files.map((file) => ({
        type: "file" as const,
        data: file.data,
        mime: file.mime,
        ...(file.name === undefined ? {} : { name: file.name }),
      })),
    ],
    execute: ({ code }, context) =>
      Effect.gen(function* () {
        const invocationIndex = yield* Ref.make(0)
        const searches = new Map<number, number>()
        const files = yield* Ref.make<Array<CollectedFiles>>([])
        const calls = yield* Ref.make<Array<ExecuteCall>>([])
        const progressLock = Semaphore.makeUnsafe(1)
        const publish = (content?: Parameters<Context["progress"]>[0]["content"]) =>
          progressLock.withPermit(
            Ref.get(calls).pipe(
              Effect.flatMap((toolCalls) =>
                context.progress({ structured: { toolCalls }, ...(content ? { content } : {}) }),
              ),
            ),
          )
        const updateCall = (index: number, update: (call: ExecuteCall) => ExecuteCall) =>
          Ref.update(calls, (items) => {
            const current = items[index]
            if (!current) return items
            const next = [...items]
            next[index] = update(current)
            return next
          })
        const finalCalls = Ref.get(calls).pipe(
          Effect.map((items) =>
            items.map((call) => (call.status === "running" ? { ...call, status: "error" as const } : call)),
          ),
        )
        const result = yield* runtime(
          (name, registration, input) =>
            Effect.gen(function* () {
              const sequence = yield* Ref.getAndUpdate(invocationIndex, (value) => value + 1)
              const id = JSON.stringify([context.sessionID, context.messageID, context.callID, sequence])
              const index = yield* Ref.modify(calls, (items) => [
                items.length,
                [
                  ...items,
                  {
                    tool: registration.path,
                    name,
                    id,
                    index: sequence,
                    input: structuredClone(input),
                    status: "running" as const,
                  },
                ],
              ])
              const output = yield* invokeNested(name, registration.tool, input, {
                ...context,
                invocationID: id,
                progress: (update) => publish(update.content),
              }).pipe(
                Effect.tapError(() =>
                  updateCall(index, (call) => ({ ...call, status: "error" })).pipe(Effect.andThen(publish())),
                ),
                Effect.mapError((failure) => toolError(failure.message, failure)),
              )
              yield* updateCall(index, (call) => ({ ...call, status: "completed", structured: output.structured }))
              yield* publish()
              const outputFileParts = outputFiles(output)
              if (outputFileParts.length > 0)
                yield* Ref.update(files, (items) => [...items, { index, files: outputFileParts }])
              return output.structured
            }),
          {
            onToolCallStart: ({ index, kind, name, input }) =>
              Effect.gen(function* () {
                if (kind !== "search") return
                const shown = displayInput(input)
                const position = yield* Ref.modify(calls, (items) => [
                  items.length,
                  [...items, { tool: name, status: "running" as const, ...(shown ? { input: shown } : {}) }],
                ])
                searches.set(index, position)
              }),
            onToolCallEnd: ({ index, kind, outcome }) => {
              if (kind !== "search") return Effect.void
              const position = searches.get(index)
              return position === undefined
                ? Effect.void
                : updateCall(position, (call) => ({ ...call, status: outcome === "success" ? "completed" : "error" }))
            },
          },
        ).execute(code)
        const toolCalls = yield* finalCalls
        const collected = (yield* Ref.get(files))
          .toSorted((left, right) => left.index - right.index)
          .flatMap((item) => item.files)
        const output = formatResult(result)
        return { output, toolCalls, files: collected, ...(result.ok ? {} : { error: true as const }) }
      }),
  })
}

function displayInput(input: unknown): Record<string, unknown> | undefined {
  if (input === null || input === undefined) return
  if (typeof input !== "object" || Array.isArray(input)) return { input }
  if (Object.keys(input).length === 0) return
  return input as Record<string, unknown>
}

function formatResult(result: CodeMode.Result) {
  const output = result.ok
    ? formatValue(result.value)
    : [result.error.message, ...(result.error.suggestions ?? []).filter((hint) => !result.error.message.includes(hint))]
        .join("\n")
        .trim()
  const warnings =
    result.ok && result.warnings && result.warnings.length > 0
      ? `Warnings:\n${result.warnings.map((item) => `- [${item.kind}] ${item.message}`).join("\n")}`
      : undefined
  const logs = result.logs && result.logs.length > 0 ? `Logs:\n${result.logs.join("\n")}` : undefined
  return [output, warnings, logs].filter((part) => part !== undefined && part !== "").join("\n\n")
}

function formatValue(value: CodeMode.DataValue) {
  if (typeof value === "string") return value
  return JSON.stringify(value, null, 2) ?? String(value)
}

function outputFiles(output: ToolOutput): Array<typeof ExecuteFile.Type> {
  return output.content.flatMap((part) => {
    if (part.type !== "file") return []
    const prefix = `data:${part.mime};base64,`
    if (!part.uri.startsWith(prefix)) return []
    return [
      {
        data: part.uri.slice(prefix.length),
        mime: part.mime,
        ...(part.name === undefined ? {} : { name: part.name }),
      },
    ]
  })
}
