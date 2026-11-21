import { Argument, Flag } from "effect/unstable/cli"
import { Spec } from "../framework/spec"
import { ServerParams } from "./run"

export const ApiCommand = Spec.make("api", {
  description: "Make a request to the running server",
  params: {
    ...ServerParams,
    request: Argument.string("operation | method path").pipe(
      Argument.withDescription("V5 operation name, or an HTTP method followed by a path"),
      Argument.variadic({ min: 1, max: 2 }),
    ),
    data: Flag.string("data").pipe(Flag.withAlias("d"), Flag.withDescription("Request body"), Flag.optional),
    header: Flag.string("header").pipe(
      Flag.withAlias("H"),
      Flag.withDescription("Request header in name:value form"),
      Flag.atMost(100),
    ),
    param: Flag.keyValuePair("param").pipe(Flag.withDescription("Named operation path or query parameter"), Flag.optional),
  },
})
