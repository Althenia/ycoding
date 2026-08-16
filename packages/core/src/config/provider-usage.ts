export * as ConfigProviderUsage from "./provider-usage"

import { Schema } from "effect"
import { PositiveInt } from "../schema"

export class CodexAppServer extends Schema.Class<CodexAppServer>("ConfigV2.ProviderUsage.CodexAppServer")({
  command: Schema.String.check(Schema.isNonEmpty()),
  args: Schema.Array(Schema.String).pipe(Schema.optional),
  cwd: Schema.String.pipe(Schema.optional),
  timeout_ms: PositiveInt.check(Schema.isLessThanOrEqualTo(30_000)).pipe(Schema.optional),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.ProviderUsage")({
  codex_app_server: CodexAppServer.pipe(Schema.optional),
}) {}
