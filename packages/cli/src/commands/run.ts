import { Argument, Flag } from "effect/unstable/cli"
import { Spec } from "../framework/spec"

export const ServerParams = {
  standalone: Flag.boolean("standalone").pipe(
    Flag.withDescription("Run with a private server instead of the background service"),
    Flag.withDefault(false),
  ),
  server: Flag.string("server").pipe(
    Flag.withDescription("Connect to a server URL instead of the background service"),
    Flag.optional,
  ),
}

export const RunCommand = Spec.make("run", {
  description: "Run YCoding with a message",
  params: {
    ...ServerParams,
    config: Flag.string("config").pipe(
      Flag.withDescription(
        "Apply a JSON/JSONC runtime config document as the highest-priority layer of a private server for this run",
      ),
      Flag.optional,
    ),
    isolated: Flag.boolean("isolated").pipe(
      Flag.withDescription(
        "Run on a private server with a temporary data directory and database removed afterwards; stored credentials are unavailable",
      ),
      Flag.withDefault(false),
    ),
    message: Argument.string("message").pipe(
      Argument.withDescription("Message to send"),
      Argument.variadic({ min: 0 }),
    ),
    continue: Flag.boolean("continue").pipe(
      Flag.withAlias("c"),
      Flag.withDescription("Continue the last session"),
      Flag.withDefault(false),
    ),
    session: Flag.string("session").pipe(
      Flag.withAlias("s"),
      Flag.withDescription("Session ID to continue"),
      Flag.optional,
    ),
    fork: Flag.boolean("fork").pipe(
      Flag.withDescription("Fork the session before continuing"),
      Flag.withDefault(false),
    ),
    model: Flag.string("model").pipe(
      Flag.withAlias("m"),
      Flag.withDescription("Model to use in the format [profile#]provider/model[#variant]"),
      Flag.optional,
    ),
    agent: Flag.string("agent").pipe(Flag.withDescription("Agent to use"), Flag.optional),
    format: Flag.choice("format", ["default", "json"]).pipe(
      Flag.withDescription("Output format"),
      Flag.withDefault("default"),
    ),
    file: Flag.string("file").pipe(
      Flag.withAlias("f"),
      Flag.withDescription("File to attach to the message"),
      Flag.atMost(100),
    ),
    title: Flag.string("title").pipe(Flag.withDescription("Session title"), Flag.optional),
    thinking: Flag.boolean("thinking").pipe(Flag.withDescription("Show thinking blocks"), Flag.withDefault(false)),
    permissions: Flag.choice("permissions", ["manual", "yolo", "auto"]).pipe(
      Flag.withDescription(
        "Set the durable Session permissions mode; omitted preserves it (manual: humans decide asks; auto: rules approve asks; yolo: evaluator also decides unresolved asks; denies still apply)",
      ),
      Flag.optional,
    ),
    guardrails: Flag.choice("guardrails", ["manual", "yolo", "auto"]).pipe(
      Flag.withDescription(
        "Set the durable Session guardrails mode; omitted preserves it (auto: ordinary reviews approve while awake; hard and custom-rule reviews still need a human)",
      ),
      Flag.optional,
    ),
    answers: Flag.choice("answers", ["manual", "yolo", "auto"]).pipe(
      Flag.withDescription(
        "Set the durable Session answers mode; omitted preserves it (auto: exactly one Recommended or default option answers; yolo: evaluator also answers free text)",
      ),
      Flag.optional,
    ),
  },
})
