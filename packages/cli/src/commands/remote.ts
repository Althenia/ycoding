import { Argument, Flag } from "effect/unstable/cli"
import { Spec } from "../framework/spec"
import { ServerParams } from "./run"

// `ycoding remote` gives an enrolled machine owner access to the backend's
// Sessions through the authenticated outbound relay.

export const RemoteCommand = Spec.make("remote", {
  description: "Control this machine's YCoding agent from the YCoding web app",
  commands: [
    Spec.make("enroll", {
      description: "Enroll this machine with the YCoding relay",
      params: {
        enrollmentID: Argument.string("enrollmentID").pipe(
          Argument.withDescription("Enrollment ID shown on the YCoding devices page"),
        ),
        name: Flag.string("name").pipe(
          Flag.withDescription("Device name shown to the signed-in user"),
          Flag.optional,
        ),
        relay: Flag.string("relay").pipe(
          Flag.withDescription("Relay origin, for example https://ycoding.example"),
          Flag.optional,
        ),
        replace: Flag.boolean("replace").pipe(
          Flag.withDescription("Replace the device identity already stored on this machine"),
          Flag.withDefault(false),
        ),
      },
    }),
    Spec.make("connect", {
      description: "Connect this machine to the relay and serve backend sessions",
      params: {
        ...ServerParams,
        relay: Flag.string("relay").pipe(
          Flag.withDescription("Relay origin; it must match the enrolled device's relay"),
          Flag.optional,
        ),
      },
    }),
    Spec.make("status", {
      description: "Show device enrollment and backend session access",
      params: ServerParams,
    }),
    Spec.make("sessions", {
      description: "List the backend sessions available to the enrolled machine owner",
      params: ServerParams,
    }),
  ],
})
