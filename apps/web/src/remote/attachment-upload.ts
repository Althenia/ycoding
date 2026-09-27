import { RemoteLimits, serializeRequest } from "@ycoding-ai/remote"
import type { FileAttachmentInput } from "./catalog"
import type { RemoteTransport } from "./transport"

export function assertRemoteRequestSize(operation: "session.prompt" | "session.command", sessionID: string, input: Readonly<Record<string, unknown>>) {
  const frame = serializeRequest({ type: "request", id: "x".repeat(RemoteLimits.maxRequestIDChars), operation, sessionID,
    input: { ...input, id: "m".repeat(128), ...(operation === "session.prompt" ? { resume: true } : {}) } })
  if (frame.length > RemoteLimits.maxClientMessageChars)
    throw new Error("The message and attachments exceed the 32,768-character remote request limit. Shorten the message or remove an attachment.")
}

export async function uploadAttachments(input: {
  readonly sessionID: string
  readonly files: readonly FileAttachmentInput[]
  readonly request: RemoteTransport["request"]
  readonly signal?: AbortSignal
  readonly onProgress?: (name: string, percent: number) => void
}): Promise<FileAttachmentInput[]> {
  const totalBytes = input.files.reduce((total, file) => total + (file.uri.startsWith("data:") ? encodedBytes(file.uri) : 0), 0)
  if (totalBytes > RemoteLimits.maxConnectionAttachmentBytes) throw new Error("Attachments in one message must total 40 MiB or less.")
  const uploaded: FileAttachmentInput[] = []
  for (const file of input.files) {
    if (!file.uri.startsWith("data:")) { uploaded.push(file); continue }
    const payload = file.uri.slice(file.uri.indexOf(",") + 1)
    const uploadID = crypto.randomUUID()
    for (let offset = 0, index = 0; offset < payload.length; offset += RemoteLimits.maxAttachmentChunkChars, index++) {
      if (input.signal?.aborted) throw new Error("Attachment upload cancelled.")
      const last = offset + RemoteLimits.maxAttachmentChunkChars >= payload.length
      const chunk = { uploadID, index, last, data: payload.slice(offset, offset + RemoteLimits.maxAttachmentChunkChars) }
      if (serializeRequest({ type: "request", id: "x".repeat(RemoteLimits.maxRequestIDChars), operation: "session.attachment.upload", sessionID: input.sessionID, input: chunk }).length > RemoteLimits.maxClientMessageChars)
        throw new Error("Attachment chunk exceeds the remote frame limit.")
      const outcome = await input.request("session.attachment.upload", { sessionID: input.sessionID, input: chunk, ...(index === 0 ? { timeoutMs: 10_000 } : {}) })
      if (input.signal?.aborted) throw new Error("Attachment upload cancelled.")
      if ((outcome.status === "unknown" && index === 0) || (outcome.status === "failed" && outcome.error.code === "unknown_operation"))
        throw new Error("This machine may need a newer YCoding. Update YCoding on that machine and retry the attachment.")
      if (outcome.status !== "ok") throw new Error(outcome.status === "unavailable" ? "Attachment upload lost its machine connection." : outcome.error.message)
      if (last && (typeof outcome.value !== "object" || outcome.value === null || Reflect.get(outcome.value, "uri") !== `ycoding-upload://${uploadID}`))
        throw new Error("The machine did not confirm the attachment upload.")
      input.onProgress?.(file.name ?? "Attachment", Math.round(Math.min(1, (offset + chunk.data.length) / payload.length) * 100))
    }
    uploaded.push({ ...file, uri: `ycoding-upload://${uploadID}` })
  }
  return uploaded
}

function encodedBytes(uri: string) {
  const comma = uri.indexOf(",")
  const encoded = comma < 0 ? "" : uri.slice(comma + 1)
  if (comma < 0 || !/^data:[^,;]+(?:;[^,;]+)*;base64,/i.test(uri.slice(0, comma + 1)) ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded) || !encoded.length)
    throw new Error("Attachment data is not canonical base64.")
  const bytes = encoded.length / 4 * 3 - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0)
  if (bytes > RemoteLimits.maxAttachmentBytes) throw new Error("Each attachment must be 20 MiB or smaller.")
  return bytes
}
