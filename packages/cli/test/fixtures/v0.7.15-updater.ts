import { Readable } from "node:stream"
import { createGunzip } from "node:zlib"

const maxArchiveBytes = 512 * 1024 * 1024
const extension = "ycoding-chrome-extension"

export const releasedExtensionFiles = [
  "icons/ycoding-128.png",
  "icons/ycoding-16.png",
  "icons/ycoding-32.png",
  "icons/ycoding-48.png",
  "manifest.json",
  "popup.css",
  "popup.html",
  "popup.js",
  "protocol.js",
  "service-worker.js",
]

export async function releasedUpdaterAcceptsLinuxArchive(archive: Uint8Array) {
  const directories = [extension, `${extension}/icons`]
  const names = ["ycoding", ...releasedExtensionFiles.map((file) => `${extension}/${file}`)].sort()
  await inspectArchive(archive, names, directories)
  const archiveFiles = await new Bun.Archive(archive).files()
  const files = [...archiveFiles.keys()].sort()
  if (files.length !== names.length || files.some((entry, index) => entry !== names[index])) {
    throw new Error(`Release archive did not contain the exact direct entries: ${names.join(", ")}`)
  }
}

async function inspectArchive(archive: Uint8Array, files: string[], directoryNames: ReadonlyArray<string>) {
  const directories = directoryNames.map((directory) => `${directory}/`)
  const expected = [...files, ...directories].sort()
  const entries: string[] = []
  const header = new Uint8Array(512)
  let headerBytes = 0
  let skip = 0
  let expanded = 0
  let ended = false
  for await (const chunk of Readable.from([archive]).pipe(createGunzip())) {
    expanded += chunk.length
    if (expanded > maxArchiveBytes + 1024 * 1024) throw new Error("Release archive is too large when expanded")
    for (let offset = 0; offset < chunk.length; ) {
      if (skip > 0) {
        const consumed = Math.min(skip, chunk.length - offset)
        skip -= consumed
        offset += consumed
        continue
      }
      const consumed = Math.min(512 - headerBytes, chunk.length - offset)
      header.set(chunk.subarray(offset, offset + consumed), headerBytes)
      headerBytes += consumed
      offset += consumed
      if (headerBytes !== 512) continue
      headerBytes = 0
      if (header.every((byte) => byte === 0)) {
        ended = true
        continue
      }
      if (ended) throw new Error("Release archive has entries after its terminator")
      const name = Buffer.from(header.subarray(0, 100)).toString("utf8").split("\0", 1)[0]
      const prefix = Buffer.from(header.subarray(345, 500)).toString("utf8").split("\0", 1)[0]
      const sizeField = Buffer.from(header.subarray(124, 136)).toString("ascii").replace(/\0.*$/, "").trim()
      if (prefix || !/^[0-7]+$/.test(sizeField)) throw new Error("Release archive has invalid entry metadata")
      const size = Number.parseInt(sizeField, 8)
      const type = header[156]
      if (type === 120 && size <= 16 * 1024 && entries.length <= expected.length) {
        skip = Math.ceil(size / 512) * 512
        continue
      }
      if (
        (type === 53 && directories.includes(name) && size === 0) ||
        ((type === 48 || type === 0) && files.includes(name) && size > 0 && size <= maxArchiveBytes)
      ) {
        entries.push(name)
        if (entries.length > expected.length) throw new Error("Release archive has unexpected entries")
        skip = Math.ceil(size / 512) * 512
        continue
      }
      if ((type === 48 || type === 0) && files.includes(name)) {
        throw new Error("Release archive entries must be bounded regular nonempty direct files")
      }
      throw new Error(`Release archive did not contain the exact direct entries: ${expected.join(", ")}`)
    }
  }
  if (headerBytes !== 0 || skip !== 0 || !ended || entries.sort().some((entry, index) => entry !== expected[index]) || entries.length !== expected.length) {
    throw new Error(`Release archive did not contain the exact direct entries: ${expected.join(", ")}`)
  }
}
