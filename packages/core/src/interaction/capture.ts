export * as InteractionCapture from "./capture"

import { Effect, Layer } from "effect"
import { AttachmentStore } from "../attachment-store"
import { makeGlobalNode } from "../effect/app-node"
import { Session } from "../session"
import { InteractionRuntime } from "./index"

const layer = Layer.effectDiscard(Effect.gen(function* () {
  const authority = yield* InteractionRuntime.Service
  const session = yield* Session.Service
  const attachments = yield* AttachmentStore.Service
  const release = authority.admitCaptures((sessionID, _generation, capture) => Effect.runPromise(Effect.gen(function* () {
    const content = yield* attachments.import(Buffer.from(capture.frame.base64, "base64"))
    const page = [capture.title, capture.url && `<${capture.url}>`].filter(Boolean).join(" ")
    yield* session.prompt({
      sessionID,
      text: `Interaction capture from ${capture.label}${page ? `: ${page}` : ""}`,
      files: [{ uri: AttachmentStore.managedURI(content), name: capture.frame.mimeType === "image/png" ? "interaction-capture.png" : "interaction-capture.jpg" }],
      delivery: "steer",
    })
  })))
  yield* Effect.addFinalizer(() => Effect.sync(release))
}))

export const node = makeGlobalNode({ name: "interaction-capture", layer, deps: [InteractionRuntime.node, Session.node, AttachmentStore.node] })
