export * as DotsAttachments from "./attachments"

import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { PromptInput } from "@ycoding-ai/schema/prompt-input"
import { Effect, Schema } from "effect"
import { AttachmentStore } from "../attachment-store"
import { Mime } from "../mime"
import type { DotsTransport } from "./transport"

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("DotsAttachments.InvalidError", {
  message: Schema.String,
}) {}

export type Read = (file: PromptInput.FileAttachment) => Effect.Effect<DotsTransport.Attachment, InvalidError>

export function make(options: { readonly store: Pick<AttachmentStore.Interface, "resolveURI" | "read"> }): Read {
  return (file) => {
    if (file.uri.startsWith("ycoding-attachment://"))
      return options.store.resolveURI(file.uri).pipe(
        Effect.flatMap((content) => options.store.read(content)),
        Effect.flatMap((bytes) =>
          Effect.try({
            try: () => attachment(file.name ?? "attachment", Mime.detect(bytes), bytes),
            catch: invalid,
          }),
        ),
        Effect.mapError((error) => new InvalidError({ message: `Attachment is unavailable: ${error.message}` })),
      )
    if (file.uri.startsWith("data:")) return Effect.try({ try: () => fromDataURL(file), catch: invalid })
    if (file.uri.startsWith("file:")) return Effect.tryPromise({ try: () => fromFile(file), catch: invalid })
    return Effect.fail(
      new InvalidError({ message: "Attachments must be local files, pasted data, or stored attachments" }),
    )
  }
}

function fromDataURL(file: PromptInput.FileAttachment) {
  const comma = file.uri.indexOf(",")
  if (comma === -1) throw new InvalidError({ message: "Attachment data is malformed" })
  const metadata = file.uri.slice(5, comma).split(";")
  const payload = file.uri.slice(comma + 1)
  const base64 = metadata.some((part) => part.toLowerCase() === "base64")
  const bytes = base64 ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload))
  if (base64 && bytes.toString("base64") !== payload)
    throw new InvalidError({ message: "Attachment data is not canonical base64" })
  return attachment(file.name ?? "attachment", metadata[0] || Mime.detect(bytes), bytes)
}

async function fromFile(file: PromptInput.FileAttachment) {
  const target = fileURLToPath(file.uri)
  const info = await stat(target)
  if (!info.isFile()) throw new InvalidError({ message: "Attachment is not a regular file" })
  if (info.size > AttachmentStore.MAX_BYTES)
    throw new InvalidError({ message: `Attachment exceeds the ${AttachmentStore.MAX_BYTES} byte limit` })
  const bytes = new Uint8Array(await readFile(target))
  return attachment(file.name ?? path.basename(target), Mime.detect(bytes), bytes)
}

function attachment(name: string, mime: string, bytes: Uint8Array) {
  if (bytes.byteLength === 0) throw new InvalidError({ message: "An empty file cannot be attached" })
  if (bytes.byteLength > AttachmentStore.MAX_BYTES)
    throw new InvalidError({ message: `Attachment exceeds the ${AttachmentStore.MAX_BYTES} byte limit` })
  return { name, mime, bytes }
}

function invalid(cause: unknown) {
  return cause instanceof InvalidError ? cause : new InvalidError({ message: "Attachment could not be read" })
}
