import { describe, expect, test } from "bun:test"
import { pathToFileURL } from "node:url"
import { readLocalAttachment, readLocalAttachmentWith } from "../../src/component/prompt/local-attachment"
import type { LocalAttachment, LocalFiles } from "../../src/component/prompt/local-attachment"

function files(input: { mime: string; text?: string; bytes?: Uint8Array }): LocalFiles {
  return {
    mime: async () => input.mime,
    readText: async () => input.text ?? "",
    readBytes: async () => input.bytes ?? new Uint8Array(),
  }
}

describe("prompt local attachments", () => {
  test("DOC-001 preserves image, PDF, SVG, and Excel files as file URIs without reading content", async () => {
    const reads: string[] = []
    const localFiles: LocalFiles = {
      mime: async (file) =>
        ({
          "/tmp/image.svg": "image/svg+xml",
          "/tmp/image.png": "image/png",
          "/tmp/file.pdf": "application/pdf",
          "/tmp/legacy.xls": "application/vnd.ms-excel",
          "/tmp/workbook.xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        })[file] ?? "application/octet-stream",
      readText: async (file) => {
        reads.push(file)
        return "unexpected"
      },
      readBytes: async (file) => {
        reads.push(file)
        return Uint8Array.of(1)
      },
    }

    const cases: Array<readonly [string, LocalAttachment]> = [
      [
        "/tmp/image.svg",
        { type: "image", uri: pathToFileURL("/tmp/image.svg").href, name: "image.svg", mime: "image/svg+xml" },
      ],
      [
        "/tmp/image.png",
        { type: "image", uri: pathToFileURL("/tmp/image.png").href, name: "image.png", mime: "image/png" },
      ],
      [
        "/tmp/file.pdf",
        { type: "pdf", uri: pathToFileURL("/tmp/file.pdf").href, name: "file.pdf", mime: "application/pdf" },
      ],
      [
        "/tmp/legacy.xls",
        {
          type: "excel",
          uri: pathToFileURL("/tmp/legacy.xls").href,
          name: "legacy.xls",
          mime: "application/vnd.ms-excel",
        },
      ],
      [
        "/tmp/workbook.xlsx",
        {
          type: "excel",
          uri: pathToFileURL("/tmp/workbook.xlsx").href,
          name: "workbook.xlsx",
          mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      ],
    ]
    await Promise.all(
      cases.map(async ([file, expected]) => {
        expect(await readLocalAttachmentWith(localFiles, file)).toEqual(expected)
      }),
    )
    expect(reads).toEqual([])
  })

  test("preserves SVG attachments as URI metadata", async () => {
    expect(await readLocalAttachmentWith(files({ mime: "image/svg+xml", text: "<svg />" }), "/tmp/image.svg")).toEqual({
      type: "image",
      mime: "image/svg+xml",
      uri: "file:///tmp/image.svg",
      name: "image.svg",
    })
  })

  test("preserves PDF attachments as URI metadata", async () => {
    expect(await readLocalAttachmentWith(files({ mime: "application/pdf" }), "/tmp/file.pdf")).toEqual({
      type: "pdf",
      mime: "application/pdf",
      uri: "file:///tmp/file.pdf",
      name: "file.pdf",
    })
  })

  test("ignores unsupported and unreadable local files", async () => {
    expect(await readLocalAttachmentWith(files({ mime: "text/plain" }), "/tmp/file.txt")).toBeUndefined()
    expect(await readLocalAttachment("/tmp/ycoding-missing-attachment.png")).toBeUndefined()
  })
})
