import { readFile, readdir, stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Mime } from "@ycoding-ai/core/mime"
import { mimeTypes } from "../component/prompt/local-attachment"

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

export class AttachmentReadError extends Error {
  override readonly name = "AttachmentReadError"
}

export type LocalAttachmentInput = { uri: string; name?: string; local?: true }

type Resolved<T> = Omit<T, "local"> & { name?: string }

export async function resolveLocalAttachments<T extends LocalAttachmentInput>(files: readonly T[] | undefined) {
  if (files === undefined) return undefined
  return Promise.all(
    files.map(async ({ local, ...file }): Promise<Resolved<T>> => {
      if (!local) return file
      return (await resolveFile(file)) as Resolved<T>
    }),
  )
}

async function resolveFile<T extends { uri: string; name?: string }>(file: T): Promise<T> {
  if (!file.uri.startsWith("file:")) return file
  const url = (() => {
    try {
      return new URL(file.uri)
    } catch {
      throw new AttachmentReadError(`Invalid file URI: ${file.uri}`)
    }
  })()
  const start = positiveInt(url.searchParams.get("start"))
  const end = positiveInt(url.searchParams.get("end"))
  url.search = ""
  url.hash = ""
  const target = (() => {
    try {
      return fileURLToPath(url)
    } catch {
      throw new AttachmentReadError(`Invalid file URI: ${file.uri}`)
    }
  })()
  const name = path.basename(target)
  const info = await stat(target).catch((error: unknown) => unreadable(target, error))
  if (info.isDirectory()) {
    const entries = await readdir(target, { withFileTypes: true }).catch((error: unknown) => unreadable(target, error))
    const listing = entries
      .flatMap((entry) =>
        entry.isDirectory()
          ? [{ name: entry.name, directory: true }]
          : entry.isFile()
            ? [{ name: entry.name, directory: false }]
            : [],
      )
      .sort((a, b) => (a.directory === b.directory ? a.name.localeCompare(b.name) : a.directory ? -1 : 1))
      .map((entry) => entry.name + (entry.directory ? path.sep : ""))
      .join("\n")
    return { ...file, name: file.name ?? name, uri: dataURL("application/x-directory", Buffer.from(listing)) }
  }
  if (!info.isFile()) throw new AttachmentReadError(`${name} is not a file`)
  if (info.size > MAX_ATTACHMENT_BYTES)
    throw new AttachmentReadError(`${name} is larger than the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MiB attachment limit`)
  const bytes = await readFile(target).catch((error: unknown) => unreadable(target, error))
  const sniffed = Mime.detect(bytes)
  const content =
    sniffed === "text/plain" && start !== undefined
      ? Buffer.from(bytes.toString("utf8").split("\n").slice(start - 1, end).join("\n"))
      : bytes
  return {
    ...file,
    name: file.name ?? name,
    uri: dataURL(mimeTypes[path.extname(target).toLowerCase()] ?? sniffed, content),
  }
}

function dataURL(mime: string, bytes: Uint8Array) {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`
}

function unreadable(target: string, error: unknown): never {
  const reason = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "unreadable"
  throw new AttachmentReadError(`Unable to read ${target}: ${reason}`)
}

function positiveInt(value: string | null) {
  if (value === null) return
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}
