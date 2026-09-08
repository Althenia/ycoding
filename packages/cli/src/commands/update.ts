import { Flag } from "effect/unstable/cli"
import { Spec } from "../framework/spec"

export const UpdateCommand = Spec.make("update", {
  description: "Update ycoding to a release",
  params: {
    version: Flag.string("version").pipe(
      Flag.withDescription("Install a specific release version instead of the latest"),
      Flag.optional,
    ),
  },
})
