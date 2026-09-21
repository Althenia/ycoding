import { Argument, Flag } from "effect/unstable/cli"
import { Spec } from "../framework/spec"
import { ServerParams } from "./run"

// `ycoding remote` shares explicitly chosen local Sessions with the YCoding web
// app through the hosted relay. The device identity and the shared-Session
// allowlist live outside the repository under the global YCoding directories.

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
      description: "Connect this machine to the relay and serve shared sessions",
      params: {
        ...ServerParams,
        relay: Flag.string("relay").pipe(
          Flag.withDescription("Relay origin; it must match the enrolled device's relay"),
          Flag.optional,
        ),
      },
    }),
    Spec.make("status", {
      description: "Show device enrollment and shared sessions",
    }),
    Spec.make("sessions", {
      description: "List the sessions shared with the relay",
    }),
    Spec.make("allow", {
      description: "Share one local session with the relay",
      params: {
        ...ServerParams,
        sessionID: Argument.string("sessionID").pipe(Argument.withDescription("Session ID to share")),
        directory: Flag.string("directory").pipe(
          Flag.withDescription("Directory holding the session, when it cannot be discovered automatically"),
          Flag.optional,
        ),
      },
    }),
    Spec.make("deny", {
      description: "Stop sharing one local session with the relay",
      params: {
        sessionID: Argument.string("sessionID").pipe(Argument.withDescription("Session ID to stop sharing")),
      },
    }),
  ],
})
