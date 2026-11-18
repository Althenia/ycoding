import type { PromptFile } from "./contract"

export const composerFileLimit = 20
export const composerByteLimit = 20 * 1024 * 1024
const mediaType = /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/

export function inlineFileSize(uri: string) {
  const comma = uri.indexOf(",")
  if (comma < 14 || comma > 138 || !uri.startsWith("data:") || !uri.slice(0, comma).endsWith(";base64")) return undefined
  const mime = uri.slice(5, comma - 7)
  if (!mediaType.test(mime) || mime.toLowerCase() === "application/x-directory") return undefined
  const payload = uri.slice(comma + 1)
  if (payload.length > Math.ceil(composerByteLimit / 3) * 4 || payload.length % 4 !== 0) return undefined
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0
  return /[^A-Za-z0-9+/]/.test(padding ? payload.slice(0, -padding) : payload) ? undefined : payload.length * .75 - padding
}

export function hasTransferFiles(data: DataTransfer | null) {
  return !!data && (data.types.includes("Files") || data.files.length > 0 || Array.from(data.items).some(item => item.kind === "file"))
}

export async function transferredFiles(data: DataTransfer): Promise<PromptFile[]> {
  const files = data.files.length ? Array.from(data.files) : Array.from(data.items).flatMap(item => {
    const file = item.kind === "file" ? item.getAsFile() : null
    return file ? [file] : []
  })
  if (files.length > composerFileLimit || files.reduce((total, file) => total + file.size, 0) > composerByteLimit)
    throw new Error("Attach up to 20 files and 20 MiB at a time.")
  if (files.some(file => file.name.length > 255 || /[/\u0000-\u001f]/.test(file.name))) throw new Error("A file name cannot be attached. Rename the file and try again.")
  return Promise.all(files.map(file => new Promise<PromptFile>((resolve, reject) => {
    const reader = new FileReader()
    const mime = mediaType.test(file.type) && file.type.toLowerCase() !== "application/x-directory" ? file.type : "application/octet-stream"
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== "string" || !result.includes(",")) return reject(new Error("The attachment could not be read."))
      resolve({ name: file.name || "Attachment", uri: `data:${mime};base64,${result.slice(result.indexOf(",") + 1)}` })
    }
    reader.onerror = reader.onabort = () => reject(new Error("The attachment could not be read. Try again."))
    reader.readAsDataURL(file)
  })))
}
