import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { prepareRunFile } from "../../src/run/run"

describe("run file preparation", () => {
  test("keeps -f text, image, PDF, SVG, and Excel inputs as file URIs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ycoding-run-files-"))
    const names = ["note.txt", "image.png", "document.pdf", "diagram.svg", "legacy.xls", "workbook.xlsx"]
    try {
      await Promise.all(names.map((name) => Bun.write(path.join(root, name), `content:${name}`)))

      const prepared = await Promise.all(names.map((name) => prepareRunFile(name, root)))

      expect(prepared.map((file) => file.url)).toEqual(names.map((name) => pathToFileURL(path.join(root, name)).href))
      expect(prepared.every((file) => file.url.startsWith("file://"))).toBe(true)
      expect(JSON.stringify(prepared)).not.toContain("data:")
      expect(prepared.map((file) => file.mime)).toEqual([
        "text/plain",
        "image/png",
        "application/pdf",
        "image/svg+xml",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects directories before prompt admission", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ycoding-run-directory-"))
    try {
      const error = await prepareRunFile(".", root).then(
        () => undefined,
        (error) => error,
      )
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).toContain("Cannot attach a directory, special file, or file larger than 10 MiB")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
