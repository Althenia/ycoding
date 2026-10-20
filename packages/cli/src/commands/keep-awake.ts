import { Spec } from "../framework/spec"

export const KeepAwakeCommand = Spec.make("keep-awake", {
  description: "Manage closed-lid keep-awake",
  commands: [
    Spec.make("setup", { description: "Allow the backend to hold system sleep with a passwordless pmset rule" }),
  ],
})
