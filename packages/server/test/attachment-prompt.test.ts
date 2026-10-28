import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Context, Effect, Layer } from "effect"
import { NodeHttpServer } from "@effect/platform-node"
import { HttpRouter } from "effect/unstable/http"
import { Session } from "@ycoding-ai/core/session"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { createRoutes } from "../src/routes"

const LIMIT = 20 * 1024 * 1024
const workbookName = "GISX_Renewal_Report Specification List_V.3.0_Draft.xlsx"
const workbook = (size: number) =>
  Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]), Buffer.alloc(size - 8, 0xa7)])

let root: string
let sessionID: Session.ID | undefined
let counter = 0

const headers = {
  "content-type": "application/json",
  authorization: `Basic ${Buffer.from("ycoding:fixture").toString("base64")}`,
}

const prompt = (files: unknown) =>
  handler.handler(
    new Request(`http://localhost/api/session/${sessionID}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: `msg_attachment_${++counter}`, text: "Read this", files, resume: false }),
    }),
    Context.empty(),
  )

function createHandler(directory: string) {
  return HttpRouter.toWebHandler(
    createRoutes({
      password: "fixture",
      database: { path: join(root, "session.db") },
      config: { directory: join(root, "config"), project: false },
      models: { fetch: false },
      fs: { filewatcher: false, fff: false },
    }).pipe(
      Layer.provide(NodeHttpServer.layerHttpServices),
      Layer.tap((context) =>
        Effect.gen(function* () {
          sessionID = (yield* Context.get(context, Session.Service).create({
            location: { directory: AbsolutePath.make(directory) },
            title: "Synthetic",
          })).id
        }),
      ),
    ),
  )
}

let handler: ReturnType<typeof createHandler>

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ycoding-attachment-prompt-"))
  const directory = join(root, "workspace")
  await mkdir(directory)
  handler = createHandler(directory)
  await handler.handler(new Request("http://localhost/api/session", { headers }), Context.empty())
}, 30_000)

afterAll(async () => {
  await handler.dispose()
  await rm(root, { recursive: true, force: true })
})

describe("session prompt file attachments over HTTP", () => {
  for (const size of [4096, 8 * 1024 * 1024])
    test(`admits a ${size} byte workbook whose name has spaces and dots`, async () => {
      const file = join(root, workbookName)
      await writeFile(file, workbook(size))

      const response = await prompt([{ uri: pathToFileURL(file).href, name: workbookName }])

      expect(response.status).toBe(200)
      const files = (await response.json()).data.data.files
      expect(files).toHaveLength(1)
      expect(files[0]).toMatchObject({ name: workbookName, content: { type: "managed", bytes: size } })
    }, 30_000)

  const dataURL = (size: number) => `data:application/vnd.ms-excel;base64,${workbook(size).toString("base64")}`

  test("admits a workbook sent as a data URL at the size limit without reading any path", async () => {
    const response = await prompt([{ uri: dataURL(LIMIT), name: workbookName }])

    expect(response.status).toBe(200)
    expect((await response.json()).data.data.files[0]).toMatchObject({
      name: workbookName,
      content: { type: "managed", bytes: LIMIT },
    })
  }, 60_000)

  test("rejects a data URL above the size limit as a files error naming the limit", async () => {
    const response = await prompt([{ uri: dataURL(LIMIT + 1), name: workbookName }])

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      _tag: "InvalidRequestError",
      field: "files",
      message: expect.stringContaining(`Attachment exceeds the ${LIMIT} byte limit`),
    })
  }, 60_000)

  test("admits a directory as a directory attachment", async () => {
    const response = await prompt([{ uri: pathToFileURL(root).href, name: "workspace" }])

    expect(response.status).toBe(200)
    expect((await response.json()).data.data.files[0]).toMatchObject({ mime: "application/x-directory" })
  })

  test("rejects a file above the size limit as a files error naming the limit", async () => {
    const file = join(root, "Too Big V.1.xlsx")
    await writeFile(file, workbook(LIMIT + 1))
    const uri = pathToFileURL(file).href

    const response = await prompt([{ uri, name: "Too Big V.1.xlsx" }])

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      _tag: "InvalidRequestError",
      field: "files",
      message: `Attachment exceeds the ${LIMIT} byte limit: ${uri}`,
    })
  }, 30_000)

  test("rejects a missing file as a files error naming the URI", async () => {
    const uri = pathToFileURL(join(root, "Missing File V.1.xlsx")).href

    const response = await prompt([{ uri, name: "Missing File V.1.xlsx" }])

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      _tag: "InvalidRequestError",
      field: "files",
      message: `Unable to read attachment: ${uri}`,
    })
  })
})
