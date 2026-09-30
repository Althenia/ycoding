import { Argument } from "effect/unstable/cli"
import { Spec } from "../framework/spec"

export const ServiceCommand = Spec.make("service", {
  description: "Manage the background server",
  commands: [
    Spec.make("start", { description: "Start the background server" }),
    Spec.make("restart", { description: "Restart the background server" }),
    Spec.make("status", { description: "Show background server status" }),
    Spec.make("stop", { description: "Stop the background server" }),
    Spec.make("get", {
      description: "Get service configuration",
      params: { key: Argument.string("key").pipe(Argument.optional) },
    }),
    Spec.make("set", {
      description: "Set service configuration",
      params: { key: Argument.string("key"), value: Argument.string("value") },
    }),
    Spec.make("unset", {
      description: "Unset service configuration",
      params: { key: Argument.string("key") },
    }),
  ],
})
