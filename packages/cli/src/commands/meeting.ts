import { Argument, Flag } from "effect/unstable/cli"
import { Spec } from "../framework/spec"

export const MeetingCommand = Spec.make("meeting", {
  description: "Start local meeting capture and open its live page",
  params: {
    directory: Argument.string("directory").pipe(
      Argument.withDescription("Project directory for the meeting (defaults to the current directory)"),
      Argument.optional,
    ),
    open: Flag.boolean("open").pipe(
      Flag.withDescription("Open the live meeting page in the browser"),
      Flag.withDefault(true),
    ),
  },
})
