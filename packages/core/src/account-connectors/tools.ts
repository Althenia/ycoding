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
  for (const entry of input.catalog) {
    const tool = entry.tool
    const name = `${input.provider}_${entry.id.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 80)}_${tool.name.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 80)}_${Hash.sha256(`${entry.id}\0${tool.name}`).slice(0, 12)}`
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
              requireHuman: entry.requireHuman,
              metadata: { connector: entry.id, tool: tool.name, operationDigest },
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
  return [{ tools }]
})
