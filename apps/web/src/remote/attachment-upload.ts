import { RemoteLimits, isWellFormedBase64, serializeRequest } from "@ycoding-ai/remote"
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
    let offset = 0
    for (let start = 0, index = 0; start < payload.length; start += RemoteLimits.maxAttachmentChunkChars, index++) {
      if (input.signal?.aborted) throw new Error("Attachment upload cancelled.")
      const end = Math.min(start + RemoteLimits.maxAttachmentChunkChars, payload.length)
      const last = end === payload.length
      const data = Uint8Array.from(atob(payload.slice(start, end)), (byte) => byte.charCodeAt(0))
      const chunk = { uploadID, index, offset, last, data }
      const outcome = await input.request("session.attachment.upload", { sessionID: input.sessionID, input: chunk, ...(index === 0 ? { timeoutMs: 10_000 } : {}) })
      if (input.signal?.aborted) throw new Error("Attachment upload cancelled.")
      if ((outcome.status === "unknown" && index === 0) || (outcome.status === "failed" && outcome.error.code === "unknown_operation"))
        throw new Error("This machine may need a newer YCoding. Update YCoding on that machine and retry the attachment.")
      if (outcome.status !== "ok") throw new Error(outcome.status === "unavailable" ? "Attachment upload lost its machine connection." : outcome.error.message)
      if (last && (typeof outcome.value !== "object" || outcome.value === null || Reflect.get(outcome.value, "uri") !== `ycoding-upload://${uploadID}`))
        throw new Error("The machine did not confirm the attachment upload.")
      offset += data.byteLength
      input.onProgress?.(file.name ?? "Attachment", Math.round(end / payload.length * 100))
    }
    uploaded.push({ ...file, uri: `ycoding-upload://${uploadID}` })
  }
  return uploaded
}

function encodedBytes(uri: string) {
  const comma = uri.indexOf(",")
  const encoded = comma < 0 ? "" : uri.slice(comma + 1)
  if (comma < 0 || !/^data:[^,;]+(?:;[^,;]+)*;base64,/i.test(uri.slice(0, comma + 1)) ||
    !isWellFormedBase64(encoded) || !encoded.length)
    throw new Error("Attachment data is not canonical base64.")
  const bytes = encoded.length / 4 * 3 - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0)
  if (bytes > RemoteLimits.maxAttachmentBytes) throw new Error("Each attachment must be 20 MiB or smaller.")
  return bytes
}
