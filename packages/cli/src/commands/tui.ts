import { Argument, Flag } from "effect/unstable/cli"
import { Spec } from "../framework/spec"

declare const YCODING_CLI_NAME: string | undefined

const ServeCommand = Spec.make("serve", {
  description: "Start the internal V2 API server",
  hidden: true,
  params: {
    hostname: Flag.string("hostname").pipe(Flag.optional),
    port: Flag.integer("port").pipe(Flag.optional),
    service: Flag.boolean("service").pipe(Flag.withDefault(false)),
    stdio: Flag.boolean("stdio").pipe(Flag.withDefault(false)),
  },
})

export const TuiCommand = Spec.make(typeof YCODING_CLI_NAME === "string" ? YCODING_CLI_NAME : "ycoding", {
  description: "YCoding TUI",
  commands: [ServeCommand],
  params: {
    standalone: Flag.boolean("standalone").pipe(
      Flag.withDescription("Run with a private server instead of the background service"),
      Flag.withDefault(false),
    ),
    server: Flag.string("server").pipe(
      Flag.withDescription("Connect to a server URL instead of the background service"),
      Flag.optional,
    ),
    directory: Argument.string("directory").pipe(
      Argument.withDescription("Directory to start YCoding in"),
      Argument.optional,
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
  },
})
