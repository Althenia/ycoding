export * as AccountConnectorTools from "./tools"

import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv"
import { Effect, type JsonSchema } from "effect"
import type { MCPClient } from "../mcp/client"
import type { Permission } from "../permission"
import { SessionGuardrail } from "../session/guardrail"
import { Tool } from "../tool/tool"
import { Hash } from "../util/hash"

export const make = Effect.fn("AccountConnectorTools.make")(function* (input: {
  readonly provider: "chatgpt" | "claude"
  readonly catalog: ReadonlyArray<{
    readonly id: string
    readonly label: string
    readonly tool: MCPClient.ToolDefinition
    readonly requireHuman?: boolean
  }>
  readonly permission: Pick<Permission.Interface, "assert">
  readonly guardrail: Pick<SessionGuardrail.Interface, "assert">
  readonly current: (id: string) => Effect.Effect<unknown, Error>
  readonly call: (
    id: string,
    name: string,
    args: Record<string, unknown>,
  ) => Effect.Effect<MCPClient.CallToolResult, Error>
}) {
  if (input.catalog.length > 8192) return yield* Effect.fail(new Error("Account connector catalog exceeds 8192 tools"))
  const validators = new AjvJsonSchemaValidator()
  const tools: Record<string, Tool.AnyTool> = {}
  const paths = callablePaths(input.provider, input.catalog)
  if (paths instanceof Error) return yield* Effect.fail(paths)
  for (const entry of input.catalog) {
    const tool = entry.tool
    const name = securityName(input.provider, entry.id, tool.name)
    if (tools[name])
      return yield* Effect.fail(new Error("Account connector catalog contains a duplicate tool identity"))
    const validate = yield* Effect.try(() =>
      validators.getValidator<Record<string, unknown>>(tool.inputSchema as JsonSchema.JsonSchema),
    ).pipe(Effect.mapError(() => new Error("Account connector tool has an unsupported input schema")))
    const validateOutput =
      tool.outputSchema === undefined
        ? undefined
        : yield* Effect.try(() => validators.getValidator<unknown>(tool.outputSchema as JsonSchema.JsonSchema)).pipe(
            Effect.mapError(() => new Error("Account connector tool has an unsupported output schema")),
          )
    tools[name] = Tool.withPermission(
      Tool.make({
        description: `${entry.label}: ${tool.description ?? tool.name}`,
        jsonSchema: tool.inputSchema as JsonSchema.JsonSchema,
        outputSchema: tool.outputSchema as JsonSchema.JsonSchema | undefined,
        execute: (args, context) =>
          Effect.gen(function* () {
            const valid = validate(args)
            if (!valid.valid) return yield* new Tool.Failure({ message: "Invalid account connector tool arguments" })
            yield* input.current(entry.id)
            const operationDigest = Hash.json({ connectorID: entry.id, name: tool.name, arguments: valid.data })
            yield* input.permission.assert({
              sessionID: context.sessionID,
              agent: context.agent,
              action: name,
              resources: [entry.id],
              save: entry.requireHuman ? undefined : [entry.id],
              requireHuman: entry.requireHuman,
              metadata: { connector: entry.id, connectorLabel: entry.label, tool: tool.name, operationDigest },
              source: { type: "tool", messageID: context.messageID, callID: context.callID },
            })
            yield* input.current(entry.id)
            const reservation = yield* input.guardrail.assert({
              sessionID: context.sessionID,
              source: { messageID: context.messageID, callID: context.callID },
              action: "mcp_execute",
              resources: [`${input.provider}/${entry.id}/${tool.name}`],
              metadata: { operationDigest },
            })
            const result = yield* input.call(entry.id, tool.name, valid.data).pipe(Effect.ensuring(reservation.release))
            if (result.isError)
              return yield* new Tool.Failure({
                message:
                  result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n") ||
                  "Account connector tool failed. Check authorization and consent in the account's connector settings.",
              })
            if (validateOutput && !validateOutput(result.structured).valid)
              return yield* new Tool.Failure({ message: "Account connector result does not match its output schema" })
            return {
              structured: result.structured,
              content: result.content.map((part) =>
                part.type === "text" ? part : { type: "file" as const, data: part.data, mime: part.mimeType },
              ),
            }
          }).pipe(
            Effect.mapError((error) =>
              error instanceof Tool.Failure
                ? error
                : new Tool.Failure({ message: SessionGuardrail.reviewMessage(error) ?? error.message, error }),
            ),
          ),
      }),
      name,
    )
  }
  return [{ tools, options: { paths } }]
})

const securityName = (provider: string, id: string, tool: string) =>
  `${provider}_${id.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 80)}_${tool.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 80)}_${Hash.sha256(`${id}\0${tool}`).slice(0, 12)}`

function callablePaths(
  provider: string,
  catalog: ReadonlyArray<{ readonly id: string; readonly label: string; readonly tool: { readonly name: string } }>,
) {
  const connectorIDs = [...new Set(catalog.map((entry) => entry.id))]
  const titles = new Map(catalog.map((entry) => [entry.id, entry.label]))
  const labels = new Map(catalog.map((entry) => [entry.id, slug(entry.label.toLowerCase(), 40)]))
  const bases = new Map(
    connectorIDs.map((id) => {
      const label = labels.get(id)!
      return [id, usable(label, titles.get(id)!) ? label : `connector_${short(id)}`] as const
    }),
  )
  const connectors = disambiguate(bases, (id) => short(id))
  const connectorCollision = collision(connectors)
  if (connectorCollision) return new Error(`Account connector paths collide at ${provider}.${connectorCollision}`)
  const paths: Record<string, string> = {}
  for (const id of connectorIDs) {
    const label = bases.get(id) === labels.get(id) ? labels.get(id)! : undefined
    const operations = new Map(
      catalog
        .filter((entry) => entry.id === id)
        .map((entry) => {
          const normalized = slug(entry.tool.name, 56)
          const stripped =
            label !== undefined && normalized.toLowerCase().startsWith(`${label}_`)
              ? normalized.slice(label.length + 1)
              : normalized
          const operation = usable(stripped, entry.tool.name)
            ? stripped
            : usable(normalized, entry.tool.name)
              ? normalized
              : `operation_${short(`${id}\0${entry.tool.name}`)}`
          return [entry.tool.name, operation] as const
        }),
    )
    const names = disambiguate(operations, (name) => short(`${id}\0${name}`))
    const operationCollision = collision(names)
    if (operationCollision)
      return new Error(`Account connector paths collide at ${provider}.${connectors.get(id)}.${operationCollision}`)
    for (const [name, operation] of names)
      paths[securityName(provider, id, name)] = `${provider}.${connectors.get(id)}.${operation}`
  }
  return paths
}

const reserved = new Set(["__proto__", "constructor", "prototype"])

const short = (value: string) => Hash.sha256(value).slice(0, 6)

const slug = (value: string, length: number) =>
  value
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+/, "")
    .slice(0, length)
    .replace(/_+$/, "")

const usable = (value: string, source: string) =>
  /^[A-Za-z]/.test(value) && !reserved.has(value) && !reserved.has(source.trim().toLowerCase())

function disambiguate(segments: ReadonlyMap<string, string>, suffix: (key: string) => string) {
  const counts = new Map<string, number>()
  for (const segment of segments.values()) counts.set(segment, (counts.get(segment) ?? 0) + 1)
  return new Map(
    [...segments].map(
      ([key, segment]) => [key, counts.get(segment)! > 1 ? `${segment}_${suffix(key)}` : segment] as const,
    ),
  )
}

function collision(segments: ReadonlyMap<string, string>) {
  const seen = new Set<string>()
  for (const segment of segments.values()) {
    if (seen.has(segment)) return segment
    seen.add(segment)
  }
  return undefined
}
