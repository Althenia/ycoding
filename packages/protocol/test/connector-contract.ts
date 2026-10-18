import { messageTags, reservedLine } from "./wire-allocation.js"
import path from "node:path"
import { readFileSync } from "node:fs"
import { Schema, SchemaAST } from "effect"
import { HttpApiEndpoint } from "effect/unstable/httpapi"
import { Session } from "@ycoding-ai/schema/session"
import { Shell } from "@ycoding-ai/schema/shell"
import { Model } from "@ycoding-ai/schema/model"
import { domainLabel, wireContract, withDomainLiteral } from "./wire-contract.js"
import { resourceFieldConstraints } from "./resources-contract.js"
import { connectorOperations, noticeOperations, relayOperations, connectorScopeOptions } from "./connector-source.js"
import type { WireField } from "./wire-contract.js"

const text = (min = 0, max = Number.MAX_SAFE_INTEGER) =>
  Schema.String.check(Schema.isMinLength(min), Schema.isMaxLength(max))
const integer = (min = 0, max = Number.MAX_SAFE_INTEGER) =>
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(min), Schema.isLessThanOrEqualTo(max))
const optional = Schema.optional
const named = <S extends Schema.Top>(name: string, schema: S) => schema.annotate({ identifier: `Connector.${name}` })
const target = named(
  "AuthTarget",
  Schema.Union([Schema.Struct({ sessionID: text(1, 128) }), Schema.Struct({ workspace: text(1, 256) })]),
)
const authTime = named("AuthTime", Schema.Struct({ created: Schema.Finite, expires: Schema.Finite }))
const authWhen = Schema.Struct({ key: text(), op: Schema.Literals(["eq", "neq"]), value: text() })
const authPrompt = named(
  "AuthPrompt",
  Schema.Union([
    Schema.Struct({
      type: Schema.Literal("text"),
      key: text(),
      message: text(),
      placeholder: optional(text()),
      when: optional(authWhen),
    }),
    Schema.Struct({
      type: Schema.Literal("select"),
      key: text(),
      message: text(),
      options: Schema.Array(Schema.Struct({ label: text(), value: text(), hint: optional(text()) })),
      when: optional(authWhen),
    }),
  ]),
)
const authInfo = named(
  "AuthInfo",
  Schema.Struct({
    id: text(),
    name: text(),
    providers: Schema.Array(text()),
    profiles: Schema.Array(Schema.Struct({ name: text(), active: Schema.Boolean })),
    methods: Schema.Array(
      Schema.Struct({
        type: Schema.Literals(["key", "oauth", "command"]),
        id: optional(text()),
        label: text(),
        available: Schema.Boolean,
        reason: optional(text()),
        prompts: optional(Schema.Array(authPrompt)),
      }),
    ),
  }),
)
const authAttempt = named(
  "AuthAttempt",
  Schema.Struct({
    attemptID: text(),
    type: Schema.Literals(["oauth", "command"]),
    time: authTime,
    url: optional(text()),
    instructions: optional(text()),
    mode: optional(Schema.Literals(["auto", "code"])),
    manualCode: optional(Schema.Boolean),
  }),
)
const workspace = named(
  "Workspace",
  Schema.Struct({
    id: text(),
    projectID: text(),
    directory: text(),
    workspaceID: optional(text()),
    name: optional(text()),
  }),
)
const cursor = named("Cursor", Schema.Struct({ previous: optional(text()), next: optional(text()) }))
const capturedFile = named(
  "CapturedFile",
  Schema.Struct({
    diff: text(),
    path: text(),
    additions: integer(),
    deletions: integer(),
    status: Schema.Literals(["created", "deleted", "modified"]),
    unavailable: optional(Schema.Boolean),
  }),
)
const capturedGroup = named(
  "CapturedGroup",
  Schema.Struct({
    placementMessageID: text(),
    path: text(),
    additions: integer(),
    deletions: integer(),
    status: Schema.Literals(["created", "deleted", "modified"]),
    files: Schema.Array(capturedFile),
  }),
)
const catalog = named(
  "Catalog",
  Schema.Struct({
    agents: Schema.Array(
      Schema.Struct({
        id: text(),
        name: text(),
        description: optional(text()),
        mode: Schema.Literals(["primary", "subagent", "all"]),
        hidden: Schema.Boolean,
        model: optional(Model.Ref),
      }),
    ),
    models: Schema.Array(
      Schema.Struct({
        providerID: text(),
        providerName: optional(text()),
        id: text(),
        name: text(),
        variants: Schema.Array(text()),
        enabled: optional(Schema.Boolean),
        profiles: optional(
          Schema.Array(
            Schema.Struct({ name: text(), active: Schema.Boolean, variants: optional(Schema.Array(text())) }),
          ),
        ),
      }),
    ),
    defaultModel: optional(Model.Ref),
    commands: Schema.Array(Schema.Struct({ name: text(), description: optional(text()) })),
    skills: Schema.Array(
      Schema.Struct({ id: text(), name: text(), description: optional(text()), slash: Schema.Boolean }),
    ),
    references: Schema.Array(Schema.Struct({ name: text(), uri: text(), description: optional(text()) })),
    resources: Schema.Array(Schema.Struct({ name: text(), uri: text(), description: optional(text()) })),
  }),
)
const memberIDs = Schema.Array(text(1, 128)).check(Schema.isMaxLength(128))
const localAppMethod = named(
  "LocalAppMethod",
  Schema.Literals(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
)
const localAppRoute = named(
  "LocalAppRoute",
  Schema.Struct({
    path: text(1, 4096),
    match: Schema.Literals(["exact", "prefix"]),
    methods: Schema.Array(localAppMethod).check(Schema.isMinLength(1), Schema.isMaxLength(7)),
  }),
)
const localAppRoutes = Schema.Array(localAppRoute).check(Schema.isMinLength(1), Schema.isMaxLength(64))
const localAppRegistration = named(
  "LocalAppRegistration",
  Schema.Struct({
    id: text(36, 36),
    generation: text(43, 43),
    sessionID: text(1, 128),
    expiresAt: integer(),
    entryPath: text(1, 4096),
    allowedMethods: Schema.Array(localAppMethod).check(Schema.isMinLength(1), Schema.isMaxLength(7)),
    routes: localAppRoutes,
  }),
)
const localAppView = named(
  "LocalAppView",
  Schema.Struct({
    kind: Schema.Literal("local-http-app"),
    version: Schema.Literal(1),
    appID: text(36, 36),
    sessionID: text(1, 128),
    expiresAt: Schema.Union([Schema.Null, text(1, 40)]),
    status: Schema.Literals(["ready", "unavailable", "expired", "revoked"]),
    reason: optional(
      Schema.Literals(["preview_unconfigured", "not_registered", "access_unavailable", "expired", "revoked"]),
    ),
  }),
)
const localAppID = named("LocalAppID", Schema.Struct({ id: text(36, 36) }))
const localAppGeneration = named("LocalAppGeneration", Schema.Struct({ id: text(36, 36), generation: text(43, 43) }))
const body = <S extends Schema.Top>(data: S) => Schema.Struct({ data })
const empty = Schema.Void
const schemas = {
  "local.app.register": [
    named(
      "LocalAppRegister",
      Schema.Struct({
        host: Schema.Literals(["127.0.0.1", "[::1]"]),
        port: integer(1, 65535),
        entryPath: text(1, 4096),
        routes: localAppRoutes,
        ttlMs: optional(integer(1, 3600000)),
      }),
    ),
    body(localAppRegistration),
  ],
  "local.app.list": [empty, body(Schema.Array(localAppRegistration).check(Schema.isMaxLength(64)))],
  "local.app.revoke": [localAppID, body(localAppView)],
  "local.app.open": [
    localAppGeneration,
    Schema.Struct({
      data: localAppView,
      metadata: optional(
        named(
          "LocalAppMetadata",
          Schema.Struct({ localApp: Schema.Struct({ url: text(1, 8192), origin: text(1, 2048) }) }),
        ),
      ),
    }),
  ],
  "local.app.status": [localAppID, body(localAppView)],
  "local.app.http": [
    named(
      "LocalAppHttp",
      Schema.Struct({
        id: text(36, 36),
        generation: text(43, 43),
        method: localAppMethod,
        path: text(1, 4096),
        headers: optional(Schema.Record(text(1, 128), text(0, 8192))),
        body: optional(text(0, 349528)),
      }),
    ),
    body(
      named(
        "LocalAppResponse",
        Schema.Struct({
          status: integer(200, 599),
          headers: Schema.Record(text(1, 128), Schema.Union([text(0, 8192), Schema.Array(text(0, 8192))])),
          body: text(0, 2796204),
        }),
      ),
    ),
  ],
  "provider.auth.list": [Schema.Struct({ target }), body(Schema.Array(authInfo))],
  "provider.auth.key": [
    Schema.Struct({ target, integrationID: text(1, 128), label: text(1, 128), key: text(1, 8192) }),
    body(Schema.Struct({ status: Schema.Literal("complete") })),
  ],
  "provider.auth.begin": [
    Schema.Struct({
      target,
      integrationID: text(1, 128),
      methodID: text(1, 128),
      label: text(1, 128),
      inputs: Schema.Record(text(1, 128), text(0, 2048)),
    }),
    body(authAttempt),
  ],
  "provider.auth.status": [
    Schema.Struct({ target, integrationID: text(1, 128), attemptID: text(1, 128) }),
    body(
      Schema.Struct({
        status: Schema.Literals(["pending", "complete", "failed", "expired"]),
        message: optional(text()),
        time: authTime,
      }),
    ),
  ],
  "provider.auth.complete": [
    Schema.Struct({ target, integrationID: text(1, 128), attemptID: text(1, 128), code: text(1, 2048) }),
    body(Schema.Struct({ status: Schema.Literal("submitted") })),
  ],
  "provider.auth.cancel": [
    Schema.Struct({ target, integrationID: text(1, 128), attemptID: text(1, 128) }),
    body(Schema.Struct({ status: Schema.Literal("cancelled") })),
  ],
  "workspace.list": [Schema.Struct({ sessionsOnly: optional(Schema.Literal(true)) }), body(Schema.Array(workspace))],
  "session.capturedChanges.list": [
    Schema.Struct({ cursor: optional(text(1, 256)) }),
    Schema.Struct({ data: Schema.Array(capturedGroup), cursor: optional(Schema.Struct({ next: optional(text()) })) }),
  ],
  "session.team.economics": [
    Schema.Struct({ sessionIDs: memberIDs.check(Schema.isMinLength(1)) }),
    body(
      Schema.Array(
        Schema.Struct({
          sessionID: text(),
          cost: Schema.Finite,
          tokens: Session.Info.fields.tokens,
          contextTotal: optional(Schema.Finite),
          contextLimit: optional(Schema.Finite),
          cacheHitRatio: optional(Schema.Finite),
          cacheRead: optional(Schema.Finite),
          cacheWrite: optional(Schema.Finite),
        }),
      ),
    ),
  ],
  "session.team.shell.list": [
    empty,
    Schema.Struct({
      data: Schema.Array(
        Schema.Struct({
          id: text(),
          ownerID: text(),
          command: text(0, 256),
          status: text(),
          startedAt: Schema.Finite,
          completedAt: optional(Schema.Finite),
        }),
      ),
      truncated: Schema.Boolean,
    }),
  ],
  "session.team.shell.kill": [Schema.Struct({ shellID: text(1, 128) }), empty],
  "session.side-chat.list": [
    Schema.Struct({ cursor: optional(text(1, 1024)) }),
    Schema.Struct({
      data: Schema.Array(Schema.Struct({ id: text(), title: text(), updatedAt: Schema.Finite })),
      cursor,
    }),
  ],
  "session.side-chat.create": [Schema.Struct({ id: text(1, 128) }), body(Session.Info)],
  "session.family.activity": [
    Schema.Struct({ sessionIDs: memberIDs }),
    body(
      Schema.Array(
        Schema.Struct({
          sessionID: text(),
          executing: Schema.Boolean,
          activity: optional(
            Schema.Struct({
              kind: Schema.Literals(["tool", "thinking", "replying"]),
              room: Schema.Literals(["research", "qa", "meeting", "developer", "hold"]),
              text: named(
                "ActivityText",
                Schema.String.check(Schema.makeFilter<string>((value) => Array.from(value).length <= 80)),
              ),
            }),
          ),
        }),
      ),
    ),
  ],
  "session.attachment.upload": [
    Schema.Struct({ uploadID: text(), index: integer(0, 1023), last: Schema.Boolean, data: text(1, 28000) }),
    Schema.Union([Schema.Struct({ uri: text() }), Schema.Struct({ received: integer() })]),
  ],
  "session.status": [
    empty,
    Schema.Struct({
      running: Schema.Array(text()),
      attention: Schema.Array(text()),
      outstanding: optional(Schema.Array(text())),
      failed: optional(Schema.Array(text())),
      lost: optional(Schema.Array(text())),
    }),
  ],
  "session.catalog": [empty, catalog],
} satisfies Record<string, readonly [Schema.Top, Schema.Top]>

export const connectorError = named(
  "Error",
  Schema.Struct({
    code: Schema.Literals([
      "invalid_message",
      "message_too_large",
      "unknown_operation",
      "session_required",
      "session_not_allowed",
      "subagent_read_only",
      "not_found",
      "not_subscribed",
      "rate_limited",
      "agent_unavailable",
      "outcome_unknown",
      "forbidden",
      "telemetry_disabled",
      "unauthorized",
      "internal_error",
    ]),
    message: text(0, 512),
  }),
)

export function connectorSourceIdentity(ast: SchemaAST.AST, hint: string) {
  const name = String(
    ast.annotations?.identifier ??
      ast.checks?.flatMap((check) => (check._tag === "Filter" ? [check.annotations?.identifier] : [])).find(Boolean) ??
      "",
  )
  if (name.startsWith("Connector.LocalApp") || hint.startsWith("Connector_LocalApp") || hint.startsWith("local_app_"))
    return "rust/crates/runtime/src/connector/local_apps.rs#Facade"
  if (name === "Connector.AuthTarget") return "packages/protocol/src/v5/connection/index.ts#validRequest"
  if (name === "Connector.ActivityText") return "packages/cli/src/remote-operations.ts#boundedActivity"
  if (name.startsWith("Connector.Auth")) return "packages/cli/src/remote-provider-auth.ts#executeProviderAuth"
  if (hint.includes("Request")) return "packages/protocol/src/v5/connection/index.ts#validRequest"
  if (hint === "Connector_Error") return "packages/protocol/src/v5/connection/index.ts#validResult"
  return "packages/cli/src/remote-operations.ts#run"
}

export function connectorContract() {
  const entries = Object.entries(schemas)
  const ids = Object.fromEntries(
    entries.map(([source]) => {
      const item = connectorOperations[source as keyof typeof connectorOperations]
      return [item[1], item[0]]
    }),
  )
  const contract = wireContract(
    entries.map(([source, [request, result]]) => {
      const name = connectorOperations[source as keyof typeof connectorOperations][1]
      return {
        group: "connector",
        endpoint:
          request === empty
            ? HttpApiEndpoint.post(name, `/connector/${name}`, { success: result, error: connectorError })
            : HttpApiEndpoint.post(name, `/connector/${name}`, {
                payload: request,
                success: result,
                error: connectorError,
              }),
      }
    }),
    ids,
    connectorSourceIdentity,
    [],
  )
  const upload = contract.messages.get("session_attachment_upload_Request_payload")!
  contract.messages.get("session_family_activity_Request_payload_sessionIDs")!.fields[0].countMin = 0
  upload.fields.find((field) => field.name === "data")!.type = "bytes"
  upload.fields.find((field) => field.name === "data")!.constraints = [
    { "~structural": true, meta: { _tag: "isMinLength", minLength: 1 } },
    { "~structural": true, meta: { _tag: "isMaxLength", maxLength: 21000 } },
  ]
  upload.fields.find((field) => field.name === "data")!.source = undefined
  upload.fields.find((field) => field.name === "data")!.ast = undefined
  upload.fields.push({
    name: "offset",
    type: "uint64",
    presence: "required",
    constraints: [],
    ast: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(20971520)).ast,
  })
  return contract
}

export function connectorFieldConstraints(field: WireField) {
  const constraints = resourceFieldConstraints(field)
  if (field.countMin !== undefined) constraints.countMin = field.countMin
  return field.constraints.some((rule) => rule.identifier === "Connector.ActivityText")
    ? { ...constraints, codepointsMax: 80 }
    : constraints
}

export function connectorProto() {
  const contract = connectorContract()
  const existing = new Set(
    ["foundation", "shared", "resources", "platform", "session"].flatMap((file) =>
      [
        ...readFileSync(path.resolve(import.meta.dir, `../../../protocol/ycoding/v5/${file}.proto`), "utf8").matchAll(
          /^(?:message|enum) (\w+)/gm,
        ),
      ].map((match) => match[1]),
    ),
  )
  const fieldOption = (field: WireField) => {
    const options = Object.entries(connectorFieldConstraints(field)).flatMap(([key, value]) =>
      value === undefined
        ? []
        : Array.isArray(value)
          ? value.map((item) => `domain_obligations: ${JSON.stringify(item)}`)
          : [`${key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}: ${JSON.stringify(value)}`],
    )
    return options.length ? ` [(ycoding.v5.constraints) = { ${options.join(" ")} }]` : ""
  }
  const declarations = [...contract.enums]
    .filter(([name]) => !existing.has(name))
    .map(
      ([name, values]) =>
        `enum ${name} {\n${values
          .map(
            (value, index) =>
              `  ${name.toUpperCase()}_${String(value)
                .replace(/[^a-zA-Z0-9]/g, "_")
                .toUpperCase()} = ${index + 1}${domainLabel(value)};`,
          )
          .join("\n")}\n}`,
    )
    .concat(
      [...contract.messages]
        .filter(([name]) => !existing.has(name))
        .map(
          ([name, message]) =>
            `message ${name} {\n${message.oneof ? "  oneof kind {\n" : ""}${message.fields.map((field, index) => `  ${message.oneof ? "  " : ""}${field.presence === "oneof" ? "" : field.presence + " "}${field.type} ${field.name} = ${messageTags(name, message.fields)[index]}${withDomainLiteral(fieldOption(field), message, field)};`).join("\n")}\n${message.oneof ? "  }\n" : ""}${reservedLine("message", name)}}`,
        ),
    )
  return `syntax = "proto2";\npackage ycoding.v5;\n\n${["foundation", "operations", "shared", "session"].map((file) => `import "ycoding/v5/${file}.proto";`).join("\n")}\n\noption (ycoding.v5.operation_range) = { first: 5000 last: 5099 };\n\n${declarations.join("\n\n")}\n\n${connectorServices(contract)}\n`
}

function connectorServices(contract: ReturnType<typeof connectorContract>) {
  const scopes = new Set(["workspace.catalog", "workspace.file.find", "session.create"])
  const sessions = new Set(["session.list", "session.status"])
  const reads = new Set([
    "local.app.list",
    "local.app.status",
    "provider.auth.list",
    "workspace.list",
    "session.list",
    "session.capturedChanges.list",
    "session.compaction.list",
    "session.attachment.read",
    "session.message.stream",
    "session.team.economics",
    "session.team.shell.list",
    "session.side-chat.list",
    "session.family.activity",
    "session.log",
    "session.form.list",
    "session.shell.output",
    "session.status",
    "session.catalog",
    "workspace.catalog",
    "session.file.find",
    "workspace.file.find",
    "usage.providers",
    "machine.latency.list",
  ])
  const rpc = (
    id: number,
    name: string,
    request: string,
    result: string,
    mutation: string,
    scope: string,
    roles = ["REMOTE_CLIENT", "RELAY"],
  ) =>
    `  rpc ${name.replace(/[^a-zA-Z0-9]/g, "_")}(${request}) returns (${result}) {\n    option (ycoding.v5.operation) = {\n      operation_id: ${id}\n      diagnostic_name: "${name}"\n      error_types: "ycoding.v5.Connector_Error"\n${["session.capturedChanges.list", "session.team.economics", "session.family.activity"].includes(name) ? "      roles: LOCAL_CLIENT\n" : ""}${roles.map((role) => `      roles: ${role}\n`).join("")}${connectorScopeOptions(name)}      scope: ${scope}\n      mutation: ${mutation}\n      settlement: COMPLETED\n      paging: ${["session.capturedChanges.list", "session.side-chat.list", "notice.subscribe", "notice.list"].includes(name) ? "CURSOR" : "UNPAGED"}\n      streaming: TYPED_BULK\n      sensitivity: ${name.startsWith("provider.auth.") || name.startsWith("local.app.") || name === "session.attachment.upload" || name === "mcp.request" ? "SECRET" : "PRIVATE"}\n    };\n  }`
  const operations = contract.operations.map((item) => {
    const source = Object.entries(connectorOperations).find(([, value]) => value[0] === item.id)![0]
    return rpc(
      item.id,
      item.name,
      item.request,
      item.result,
      reads.has(source) ? "READ" : "MUTATION",
      scopes.has(source)
        ? "WORKSPACE"
        : (source.startsWith("session.") && !sessions.has(source)) || source.startsWith("local.app.")
          ? "SESSION"
          : source.startsWith("provider.auth.")
            ? "GLOBAL"
            : "MACHINE",
    )
  })
  const notices = Object.entries(noticeOperations).map(([source, [id, name]]) =>
    rpc(
      id,
      name,
      source === "notice.list" ? "ConnectorNoticeBefore" : source === "notice.read" ? "ConnectorNoticeIDs" : "Empty",
      source === "notice.subscribe" || source === "notice.list" ? "ConnectorNoticePage" : "ConnectorNoticeSettlement",
      source === "notice.list" ? "READ" : "MUTATION",
      "MACHINE",
      ["REMOTE_CLIENT"],
    ),
  )
  const relay = Object.values(relayOperations).map(([id, name, , mutation]) =>
    rpc(id, name, "mcp_request_Request", "mcp_request_Result", mutation, "MACHINE", ["RELAY"]),
  )
  const demo = ["preview", "export"].map((name, index) =>
    rpc(
      5045 + index,
      `artifact.demo.${name}`,
      `artifact_demo_${name}_Request`,
      `artifact_demo_${name}_Result`,
      "READ",
      "MACHINE",
    ),
  )
  return `message ConnectorNoticeBefore { required LosslessString before = 1; }\nmessage ConnectorNoticeIDs { repeated string ids = 1 [(ycoding.v5.constraints) = { count_min: 1 count_max: 100 }]; }\nmessage ConnectorNoticePage { required Notice notice = 1; optional string next = 2; required bool unavailable = 3; }\nmessage ConnectorNoticeSettlement { required Empty data = 1; optional Notice notification = 2; }\n${mcpDeclarations}\n${demoDeclarations}\n\nservice connector {\n${demo.join("\n")}\n${operations.join("\n")}\n${notices.join("\n")}\n${relay.join("\n")}\n}`
}

const utf16 = (min: number | undefined, max: number) =>
  ` [(ycoding.v5.constraints) = { ${min === undefined ? "" : `utf16_min: ${min} `}utf16_max: ${max} }]`
const demoDeclarations = `enum artifact_demo_preview_Result_variantsItem {
  ARTIFACT_DEMO_PREVIEW_RESULT_VARIANTSITEM_LIST = 1 [(ycoding.v5.domain_label) = "list"];
  ARTIFACT_DEMO_PREVIEW_RESULT_VARIANTSITEM_CARDS = 2 [(ycoding.v5.domain_label) = "cards"];
}

enum artifact_demo_preview_Result_hostVerification {
  ARTIFACT_DEMO_PREVIEW_RESULT_HOSTVERIFICATION_REQUIRED = 1 [(ycoding.v5.domain_label) = "required"];
}

enum artifact_demo_export_Result_mime {
  ARTIFACT_DEMO_EXPORT_RESULT_MIME_IMAGE_PNG = 1 [(ycoding.v5.domain_label) = "image/png"];
}

enum artifact_demo_export_Result_delivery {
  ARTIFACT_DEMO_EXPORT_RESULT_DELIVERY_HOST_NATIVE_ATTACHMENT_REQUIRED = 1 [(ycoding.v5.domain_label) = "host-native-attachment-required"];
}

message artifact_demo_preview_Request {}
message artifact_demo_preview_Result {
  repeated artifact_demo_preview_Result_variantsItem variants = 1 [(ycoding.v5.constraints) = { count_min: 2 count_max: 2 }];
  required artifact_demo_preview_Result_hostVerification hostVerification = 2;
}
message artifact_demo_export_Request {}
message artifact_demo_export_Result {
  required string id = 1 [(ycoding.v5.constraints) = { utf16_min: 1 utf16_max: 128 }];
  required string filename = 2 [(ycoding.v5.constraints) = { utf16_min: 1 utf16_max: 128 }];
  required artifact_demo_export_Result_mime mime = 3;
  required uint32 size = 4;
  required string sha256 = 5 [(ycoding.v5.constraints) = { utf16_min: 64 utf16_max: 64 }];
  required uint64 expiresAt = 6 [(ycoding.v5.constraints) = { integer_min: "0" integer_max: "9007199254740991" }];
  required artifact_demo_export_Result_delivery delivery = 7;
}`
const mcpDeclarations = `
message mcp_request_Request {
  required Connector_McpRequest payload = 1;
}

message Connector_McpRequest {
  required LosslessString body = 1${utf16(1, 32768)};
  repeated Connector_McpHeader headers = 2 [(ycoding.v5.constraints) = { count_max: 5 }];
  required Connector_McpPrincipal principal = 3;
  required string epoch = 4${utf16(1, 64)};
}

message Connector_McpHeader {
  required string name = 1${utf16(1, 64)};
  required LosslessString value = 2${utf16(undefined, 1024)};
}

message Connector_McpPrincipal {
  required string ownerID = 1${utf16(1, 64)};
  required string deviceID = 2${utf16(1, 64)};
  required LosslessString clientID = 3${utf16(1, 2048)};
}

message mcp_request_Result {
  required Connector_McpResponse data = 1;
}

message Connector_McpResponse {
  required uint32 status = 1 [(ycoding.v5.constraints) = { integer_min: "200" integer_max: "599" }];
  required string contentType = 2${utf16(1, 256)};
  required LosslessString body = 3${utf16(undefined, 2097152)};
}
`
