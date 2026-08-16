import { stat } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

export type LocalFiles = Readonly<{
  readText(path: string): Promise<string>
  readBytes(path: string): Promise<Uint8Array>
  mime(path: string): Promise<string>
}>

export type LocalAttachment =
  | Readonly<{ type: "image"; mime: string; uri: string; name: string }>
  | Readonly<{ type: "pdf"; mime: "application/pdf"; uri: string; name: string }>
  | Readonly<{ type: "excel"; mime: string; uri: string; name: string }>

export async function readLocalAttachment(file: string) {
  const info = await stat(file).catch(() => undefined)
  if (!info?.isFile()) return
  return readLocalAttachmentWith(
    {
      readText: async () => "",
      readBytes: async () => new Uint8Array(),
      mime: async (value) => mimeTypes[path.extname(value).toLowerCase()] ?? "application/octet-stream",
    },
    file,
  )
}

const mimeTypes: Record<string, string> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
}

export async function readLocalAttachmentWith(files: LocalFiles, file: string): Promise<LocalAttachment | undefined> {
  const mime = await files.mime(file).catch(() => undefined)
  if (!mime) return
  const attachment = { mime, uri: pathToFileURL(file).href, name: path.basename(file) }
  if (mime.startsWith("image/")) return { type: "image", ...attachment }
  if (mime === "application/pdf") return { type: "pdf", ...attachment, mime }
  if (
    mime === "application/vnd.ms-excel" ||
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  )
    return { type: "excel", ...attachment }
}
