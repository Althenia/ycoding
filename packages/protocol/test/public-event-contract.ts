import { Schema, SchemaAST } from "effect"
import { EventManifest } from "@ycoding-ai/schema/event-manifest"
import { SessionEvent } from "@ycoding-ai/schema/session-event"
import { wireContract } from "./wire-contract.js"
import { sessionContract } from "./session-contract.js"
import { resourceFieldConstraints } from "./resources-contract.js"
import { readFileSync } from "node:fs"
import path from "node:path"

export function publicEventContract() {
  const contract = wireContract(
    [],
    {},
    eventSourceIdentity,
    [],
    {},
    EventManifest.ServerDefinitions.filter((definition) => definition.durability === "ephemeral").map((definition) =>
      definition.annotate({ identifier: `PublicEvent_${definition.type.replace(/[^a-zA-Z0-9]/g, "_")}` }),
    ),
  )
  const log = sessionContract().messages.get("SessionLogItem")!
  contract.messages.set("PublicEvent", {
    oneof: true,
    fields: EventManifest.ServerDefinitions.map((definition) => ({
      name: definition.type.replace(/[^a-zA-Z0-9]/g, "_"),
      type:
        definition.durability === "durable"
          ? log.fields[SessionEvent.PublicDurableDefinitions.findIndex((event) => event.type === definition.type)].type
          : `PublicEvent_${definition.type.replace(/[^a-zA-Z0-9]/g, "_")}`,
      presence: "oneof",
      constraints: [],
    })),
  })
  return contract
}

function eventSourceIdentity(_ast: SchemaAST.AST, _hint: string): string {
  return "packages/schema/src/event-manifest.ts#ServerDefinitions"
}

export function publicEventProto() {
  const contract = publicEventContract()
  const imports = ["foundation", "operations", "shared", "resources", "platform", "session"]
  const existing = new Set(
    imports.flatMap((file) =>
      [
        ...readFileSync(path.resolve(import.meta.dir, `../../../protocol/ycoding/v5/${file}.proto`), "utf8").matchAll(
          /^(?:message|enum) (\w+)/gm,
        ),
      ].map((match) => match[1]),
    ),
  )
  const declarations = [...contract.enums]
    .filter(([name]) => !existing.has(name))
    .map(
      ([name, values]) =>
        `enum ${name} {\n${values
          .map(
            (value, index) =>
              `  ${name.toUpperCase()}_${String(value)
                .replace(/[^a-zA-Z0-9]/g, "_")
                .toUpperCase()} = ${index + 1};`,
          )
          .join("\n")}\n}`,
    )
  declarations.push(
    ...[...contract.messages]
      .filter(([name]) => !existing.has(name))
      .map(
        ([name, message]) =>
          `message ${name} {\n${message.oneof ? "  oneof kind {\n" : ""}${message.fields
            .map((field, index) => {
              const metadata =
                name === "PublicEvent"
                  ? ` [(ycoding.v5.public_event) = { diagnostic_name: ${JSON.stringify(EventManifest.ServerDefinitions[index].type)} durable: ${EventManifest.ServerDefinitions[index].durability === "durable"} }]`
                  : fieldOptions(field)
              return `  ${message.oneof ? "  " : ""}${field.presence === "oneof" ? "" : field.presence + " "}${field.type} ${field.name} = ${index + 1}${metadata};`
            })
            .join("\n")}\n${message.oneof ? "  }\n" : ""}}`,
      ),
  )
  return `syntax = "proto2";\npackage ycoding.v5;\n${imports
    .filter((file) => file !== "resources" && file !== "platform")
    .map((file) => `import "ycoding/v5/${file}.proto";`)
    .join("\n")}\n\n${declarations.join("\n\n")}\n`
}

function fieldOptions(field: Parameters<typeof resourceFieldConstraints>[0]) {
  const options = Object.entries(resourceFieldConstraints(field)).flatMap(([key, value]) =>
    value === undefined
      ? []
      : Array.isArray(value)
        ? value.map((source) => `domain_obligations: ${JSON.stringify(source)}`)
        : [`${key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}: ${JSON.stringify(value)}`],
  )
  return options.length ? ` [(ycoding.v5.constraints) = { ${options.join(" ")} }]` : ""
}
