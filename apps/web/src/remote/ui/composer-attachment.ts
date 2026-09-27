import { RemoteLimits } from "@ycoding-ai/remote"

export type ComposerAttachment = { readonly id: string; readonly name: string; readonly size: number; readonly mime: string; readonly uri: string }

export function attachmentLimit(files: readonly { readonly size: number; readonly name: string }[]): string | undefined {
  if (files.length > 64) return "A message can contain at most 64 files. Remove an attachment before adding another."
  if (files.some((file) => file.size === 0)) return "An empty file cannot be attached."
  if (files.some((file) => file.name.length > 256)) return "Attachment names must be at most 256 characters."
  if (files.some((file) => file.size > RemoteLimits.maxAttachmentBytes)) return "Each attachment must be 20 MiB or smaller."
  if (files.reduce((bytes, file) => bytes + file.size, 0) > RemoteLimits.maxConnectionAttachmentBytes) return "Attachments in one message must total 40 MiB or less."
  return undefined
}

export async function encodeAttachment(file: File): Promise<ComposerAttachment> {
  const error = attachmentLimit([file])
  if (error) throw new Error(error)
  const bytes = new Uint8Array(await file.arrayBuffer())
  const parts: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 24_576)
    parts.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + 24_576))))
  const mime = file.type || "application/octet-stream"
  return { id: crypto.randomUUID(), name: file.name, size: file.size, mime, uri: `data:${mime};base64,${parts.join("")}` }
}
