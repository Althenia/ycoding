export * as DotsTransport from "./transport"

import { Context, Schema, type Effect, type Scope, type Stream } from "effect"
import type { Dots } from "@ycoding-ai/schema/dots"

export class Error extends Schema.TaggedErrorClass<Error>()("DotsTransport.Error", {
  reason: Schema.Literals(["unauthorized", "unavailable", "rejected", "disconnected", "invalid-response", "target-changed"]),
  message: Schema.String,
}) {}

export interface Credentials {
  readonly access: string
  readonly accountID: string
}

export interface Destination {
  readonly dotID: string
  readonly threadID: string
  readonly generation: string
  readonly label: string
}

export interface Attachment {
  readonly name: string
  readonly mime: string
  readonly bytes: Uint8Array
}

export interface Outgoing {
  readonly threadID: string
  readonly messageID: string
  readonly groupID: string
  readonly causalMessageID?: string
  readonly text: string
  readonly files: ReadonlyArray<Attachment>
}

export interface Receipt {
  readonly status: "accepted" | "unknown"
  readonly turnID?: string
}

export type Inbound =
  | {
      readonly type: "message.revision"
      readonly threadID: string
      readonly itemID: string
      readonly revision: string
      readonly text: string
      readonly causalMessageID?: string
    }
  | {
      readonly type: "turn.started"
      readonly threadID: string
      readonly turnID: string
      readonly clientMessageID?: string
    }
  | {
      readonly type: "user.message"
      readonly threadID: string
      readonly turnID?: string
      readonly clientMessageID: string
    }
  | {
      readonly type: "message.delta"
      readonly threadID: string
      readonly turnID?: string
      readonly itemID: string
      readonly delta: string
      readonly causalMessageID?: string
    }
  | {
      readonly type: "message.snapshot"
      readonly threadID: string
      readonly turnID?: string
      readonly itemID: string
      readonly text: string
      readonly causalMessageID?: string
    }
  | {
      readonly type: "message"
      readonly threadID: string
      readonly turnID?: string
      readonly itemID: string
      readonly text: string
      readonly causalMessageID?: string
    }
  | { readonly type: "turn.completed"; readonly threadID: string; readonly turnID: string }

export interface Connection {
  readonly subscribe: (threadID: string) => Effect.Effect<ReadonlyArray<Inbound>, Error>
  readonly send: (input: Outgoing) => Effect.Effect<Receipt, Error>
  readonly inbound: Stream.Stream<Inbound, Error>
}

export interface Interface {
  readonly destinations: (credentials: Credentials) => Effect.Effect<ReadonlyArray<Destination>, Error>
  readonly runtimeState: (
    credentials: Credentials,
    target: { readonly dotID: string; readonly threadID: string },
  ) => Effect.Effect<Dots.RuntimeState, Error>
  readonly control: (
    credentials: Credentials,
    input: { readonly dotID: string; readonly threadID: string; readonly action: "pause" | "resume" },
    isCurrent: () => boolean,
    onDispatch?: () => void,
  ) => Effect.Effect<Dots.RuntimeState, Error>
  readonly connect: (credentials: Credentials) => Effect.Effect<Connection, Error, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/DotsTransport") {}
