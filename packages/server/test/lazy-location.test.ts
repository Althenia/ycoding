import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, parse } from "node:path"
import { Context, Effect, Layer } from "effect"
import { NodeHttpServer } from "@effect/platform-node"
import { HttpRouter } from "effect/unstable/http"
import { Catalog } from "@ycoding-ai/core/catalog"
import { AttachmentStore } from "@ycoding-ai/core/attachment-store"
import { Database } from "@ycoding-ai/core/database/database"
import { LocationWatcher } from "@ycoding-ai/core/filesystem/location-watcher"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { MCP } from "@ycoding-ai/core/mcp/index"
import { CatalogContributions } from "@ycoding-ai/core/plugin/catalog-contributions"
import { PluginSupervisor } from "@ycoding-ai/core/plugin/supervisor"
import { Project } from "@ycoding-ai/core/project"
import { ProjectDirectoryTable, ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionMessageTable, SessionTable } from "@ycoding-ai/core/session/sql"
import { Workspace } from "@ycoding-ai/core/workspace"
import { createRoutes } from "../src/routes"

async function withServer(
  run: (input: {
    directory: string
    sessionDirectory: string
    request: (path: string, init?: RequestInit) => Promise<Response>
    loaded: () => Promise<readonly LocationServiceMap.Loaded[]>
    sessionID: () => Session.ID
    standaloneID: Session.ID
    digest: string
    messageID: SessionMessage.ID
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "ycoding-lazy-location-"))
  const directory = join(root, "workspace")
  const sessionDirectory = join(root, "session-workspace")
  await mkdir(directory)
  await mkdir(sessionDirectory)
  let locations: LocationServiceMap.Interface | undefined
  const sessionID = Session.ID.make("ses_lazy_bound")
  const standaloneID = Session.ID.make("ses_lazy_standalone")
  const messageID = SessionMessage.ID.make("msg_lazy_history")
  const attachments = AttachmentStore.make(root)
  const content = await Effect.runPromise(attachments.import(Buffer.from("Synthetic attachment")))
  const handler = HttpRouter.toWebHandler(
    createRoutes(
      {
        password: "fixture",
        database: { path: join(root, "session.db") },
        config: { directory: join(root, "config"), project: false },
        models: { fetch: false },
        fs: { filewatcher: false, fff: false },
      },
      undefined,
      undefined,
      undefined,
      [[AttachmentStore.node, Layer.succeed(AttachmentStore.Service, attachments)]],
    ).pipe(
      Layer.provide(NodeHttpServer.layerHttpServices),
      Layer.tap((context) =>
        Effect.gen(function* () {
          locations = Context.get(context, LocationServiceMap.Service)
          const db = Context.get(context, Database.Service).db
          yield* db
            .insert(ProjectTable)
            .values({ id: Project.ID.global, worktree: AbsolutePath.make(parse(root).root), sandboxes: [] })
            .run()
          yield* db
            .insert(ProjectDirectoryTable)
            .values({ project_id: Project.ID.global, directory: AbsolutePath.make(directory) })
            .run()
          yield* db
            .insert(SessionTable)
            .values([
              {
                id: sessionID,
                project_id: Project.ID.global,
                directory: sessionDirectory,
                workspace_id: Workspace.ID.make("wrk_lazy"),
                title: "Synthetic",
              },
              {
                id: standaloneID,
                project_id: Project.ID.global,
                directory: sessionDirectory,
                scope: "standalone",
                title: "Standalone",
              },
            ])
            .run()
          const message = { text: "Synthetic history", files: [{ mime: "text/plain", content }], time: { created: 0 } }
          yield* db
            .insert(SessionMessageTable)
            .values({
              id: messageID,
              session_id: sessionID,
              seq: 0,
              type: "user",
              data: message,
            })
            .run()
        }),
      ),
    ),
  )
  const headers = { authorization: `Basic ${Buffer.from("ycoding:fixture").toString("base64")}` }
  try {
    await handler.handler(new Request("http://localhost/api/health", { headers }), Context.empty())
    await run({
      directory,
      sessionDirectory,
      request: (path, init) =>
        handler.handler(
          new Request(`http://localhost${path}`, {
            ...init,
            headers: { ...headers, ...Object.fromEntries(new Headers(init?.headers)) },
          }),
          Context.empty(),
        ),
      loaded: () => Effect.runPromise(locations!.loaded()),
      sessionID: () => sessionID,
      standaloneID,
      digest: content.digest,
      messageID,
    })
  } finally {
    await handler.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

const query = (directory: string) => `location[directory]=${encodeURIComponent(directory)}`

for (const read of [
  "metadata",
  "snapshot",
  "compaction",
  "diagnostics",
  "attachment",
  "context",
  "file-change",
  "message",
  "log",
] as const) {
  test(`a cold DB-only Session ${read} read preserves its payload without loading Location services`, async () => {
    await withServer(async ({ sessionDirectory, request, loaded, sessionID, standaloneID, digest, messageID }) => {
      expect(await loaded()).toEqual([])
      const base = `/api/session/${sessionID()}`
      const path =
        read === "metadata"
          ? base
          : read === "attachment"
            ? `${base}/attachment/${digest}`
            : read === "message"
              ? `${base}/message/${messageID}`
              : read === "log"
                ? `/api/experimental/session/${sessionID()}/log?follow=false`
                : `${base}/${read}`
      const response = await request(path)
      expect(response.status).toBe(200)
      if (read === "log") expect(await response.text()).toContain('"type":"log.synced"')
      else {
        const body = await response.json()
        if (read === "metadata")
          expect(body).toMatchObject({
            data: {
              id: sessionID(),
              title: "Synthetic",
              scope: "bound",
              location: { directory: sessionDirectory, workspaceID: "wrk_lazy" },
            },
          })
        if (read === "snapshot")
          expect(body).toMatchObject({
            session: { id: sessionID() },
            messages: [{ id: messageID, text: "Synthetic history" }],
            watermark: { type: "log.synced", aggregateID: sessionID() },
          })
        if (read === "compaction")
          expect(body).toEqual({
            data: [],
            truncated: false,
            completedBefore: 0,
            completedCount: 0,
            totalSavedTokens: 0,
          })
        if (read === "diagnostics") expect(body).toEqual({ data: null })
        if (read === "attachment")
          expect(body).toEqual({
            mime: "text/plain",
            bytes: 20,
            data: Buffer.from("Synthetic attachment").toString("base64"),
          })
        if (read === "context") expect(body).toMatchObject({ data: [{ id: messageID, text: "Synthetic history" }] })
        if (read === "file-change") expect(body).toEqual({ data: [] })
        if (read === "message") expect(body).toMatchObject({ data: { id: messageID, text: "Synthetic history" } })
      }
      expect((await loaded()).filter((entry) => entry.ref.directory === sessionDirectory)).toEqual([])
      if (read !== "metadata") {
        const standalone = await request(path.replace(sessionID(), standaloneID))
        expect(standalone.status).toBe(400)
        expect(await standalone.json()).toMatchObject({
          _tag: "InvalidRequestError",
          message: "Standalone Session operation is unavailable",
        })
      }
    })
  }, 60_000)
}

for (const path of ["", "/snapshot"]) {
  test(`DB-only Session ${path || "metadata"} reads preserve access and recorded placement checks`, async () => {
    await withServer(async ({ sessionDirectory, request, loaded, sessionID, standaloneID }) => {
      const base = `/api/session/${sessionID()}${path}`
      const denied = await request(base, { headers: { authorization: "" } })
      expect(denied.status).toBe(401)
      expect(await denied.json()).toMatchObject({ _tag: "UnauthorizedError" })
      const invalid = await request(`/api/session/invalid${path}`)
      expect(invalid.status).toBe(400)
      expect(await invalid.json()).toMatchObject({ _tag: "InvalidRequestError", field: "sessionID" })
      const missing = await request(`/api/session/ses_missing${path}`)
      expect(missing.status).toBe(404)
      expect(await missing.json()).toMatchObject({ _tag: "SessionNotFoundError", sessionID: "ses_missing" })
      for (const [suffix, headers] of [
        [`?${query("/other")}`, {}],
        ["", { "x-ycoding-directory": encodeURIComponent("/other") }],
        ["?location[workspace]=wrk_other", {}],
        ["", { "x-ycoding-workspace": "wrk_other" }],
        [`?${query(sessionDirectory)}&${query("/other")}`, {}],
        ["?location[workspace]=wrk_lazy&location[workspace]=wrk_other", {}],
        [`?${query(sessionDirectory)}`, { "x-ycoding-directory": "/other" }],
        ["?location[workspace]=wrk_lazy", { "x-ycoding-workspace": "wrk_other" }],
      ] as const) {
        const response = await request(`${base}${suffix}`, { headers })
        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({
          _tag: "InvalidRequestError",
          message: "Session location does not match the recorded placement",
        })
      }
      const matching = await request(`${base}?${query(sessionDirectory)}&location[workspace]=wrk_lazy`, {
        headers: { "x-ycoding-directory": encodeURIComponent(sessionDirectory), "x-ycoding-workspace": "wrk_lazy" },
      })
      expect(matching.status).toBe(200)
      const standalone = await request(`/api/session/${standaloneID}${path}`)
      expect(standalone.status).toBe(path ? 400 : 200)
      expect(await standalone.json()).toMatchObject(
        path
          ? { _tag: "InvalidRequestError", message: "Standalone Session operation is unavailable" }
          : { data: { id: standaloneID, scope: "standalone" } },
      )
      expect(await loaded()).toEqual([])
    })
  }, 60_000)
}

for (const read of ["list", "inventory", "directories", "current"] as const) {
  test(`a cold Project ${read} request avoids the full Location graph`, async () => {
    await withServer(async ({ directory, sessionDirectory, request, loaded }) => {
      expect(await loaded()).toEqual([])
      const path =
        read === "list"
          ? "/api/project"
          : read === "inventory"
            ? "/api/project/inventory"
            : read === "current"
              ? `/api/project/current?${query(directory)}`
              : `/api/project/${Project.ID.global}/directories`
      const denied = await request(path, { headers: { authorization: "" } })
      expect(denied.status).toBe(401)
      expect(await denied.json()).toMatchObject({ _tag: "UnauthorizedError" })
      expect(await loaded()).toEqual([])
      const response = await request(path)
      expect(response.status).toBe(200)
      const body = await response.json()
      if (read === "list")
        expect(body).toContainEqual(expect.objectContaining({ id: Project.ID.global, worktree: parse(directory).root }))
      if (read === "inventory")
        expect(body).toMatchObject({
          data: expect.arrayContaining([expect.objectContaining({ directory: sessionDirectory, sessions: 2 })]),
        })
      if (read === "directories") expect(body).toEqual([{ directory }])
      if (read === "current") expect(body).toEqual({ id: Project.ID.global, directory: parse(directory).root })
      const entries = await loaded()
      expect(entries).toHaveLength(read === "current" ? 1 : 0)
      for (const entry of entries) {
        expect(entry.ref.directory).toBe(AbsolutePath.make(directory))
        expect(entry.built).not.toContain(MCP.node.name)
        expect(entry.built).not.toContain(LocationWatcher.node.name)
        expect(entry.built).not.toContain(PluginSupervisor.node.name)
        expect(entry.built).not.toContain(Catalog.node.name)
      }
    })
  }, 60_000)
}

test("a cold Project forget request preserves full Location middleware and authorization", async () => {
  await withServer(async ({ directory, request, loaded }) => {
    expect(await loaded()).toEqual([])
    const path = `/api/project/${Project.ID.global}/directories`
    const init = {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ directory }),
    }
    const denied = await request(`${path}?${query(directory)}`, {
      ...init,
      headers: { ...init.headers, authorization: "" },
    })
    expect(denied.status).toBe(401)
    expect(await denied.json()).toMatchObject({ _tag: "UnauthorizedError" })
    expect(await loaded()).toEqual([])
    expect(await (await request(path)).json()).toEqual([{ directory }])
    const response = await request(`${path}?${query(directory)}`, init)
    expect(response.status).toBe(204)
    expect(await (await request(path)).json()).toEqual([])
    const entries = await loaded()
    expect(entries).toHaveLength(1)
    expect(entries[0].ref.directory).toBe(AbsolutePath.make(directory))
    expect(entries[0].built).toEqual(
      expect.arrayContaining([
        Catalog.node.name,
        CatalogContributions.node.name,
        MCP.node.name,
        LocationWatcher.node.name,
        PluginSupervisor.node.name,
      ]),
    )
  })
}, 60_000)

test("a model list request builds only the catalog slice of a fresh Location", async () => {
  await withServer(async ({ directory, request, loaded }) => {
    const response = await request(`/api/model?${query(directory)}`)
    expect(response.status).toBe(200)
    const entries = (await loaded()).filter((item) => item.ref.directory === directory)
    expect(entries).toHaveLength(1)
    const built = entries[0]!.built
    expect(built).toContain(Catalog.node.name)
    expect(built).toContain(CatalogContributions.node.name)
    expect(built).not.toContain(MCP.node.name)
    expect(built).not.toContain(LocationWatcher.node.name)
    expect(built).not.toContain(PluginSupervisor.node.name)
  })
}, 60_000)

test("a provider list request stays within the catalog slice", async () => {
  await withServer(async ({ directory, request, loaded }) => {
    const response = await request(`/api/provider?${query(directory)}`)
    expect(response.status).toBe(200)
    const built = (await loaded()).find((item) => item.ref.directory === directory)!.built
    expect(built).toContain(CatalogContributions.node.name)
    expect(built).not.toContain(MCP.node.name)
    expect(built).not.toContain(PluginSupervisor.node.name)
  })
}, 60_000)

test("a session request builds the full Location graph", async () => {
  await withServer(async ({ sessionDirectory, request, loaded, sessionID }) => {
    const response = await request(`/api/session/${sessionID()}/pending`)
    expect(response.status).toBe(200)
    const entries = await loaded()
    const entry = entries.find((item) => item.ref.directory === sessionDirectory)
    expect(entry).toBeDefined()
    expect(entry!.built).toEqual(
      expect.arrayContaining([
        Catalog.node.name,
        CatalogContributions.node.name,
        MCP.node.name,
        LocationWatcher.node.name,
        PluginSupervisor.node.name,
      ]),
    )
  })
}, 60_000)

test("a full request after a catalog request extends the same Location", async () => {
  await withServer(async ({ directory, request, loaded }) => {
    await request(`/api/model?${query(directory)}`)
    const find = async () => (await loaded()).filter((item) => item.ref.directory === directory)
    expect((await find())[0]!.built).not.toContain(MCP.node.name)
    expect((await request(`/api/location?${query(directory)}`)).status).toBe(200)
    const entries = await find()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.built).toContain(MCP.node.name)
  })
}, 60_000)

test("debug evict of an idle Location releases it without rebuilding it", async () => {
  await withServer(async ({ directory, request, loaded }) => {
    await request(`/api/model?${query(directory)}`)
    const listed = await request("/api/debug/location")
    expect(listed.status).toBe(200)
    expect(await listed.json()).toContainEqual({ directory })

    const evicted = await request(`/api/debug/location?${query(directory)}`, { method: "DELETE" })
    expect(evicted.status).toBe(204)
    expect((await loaded()).filter((item) => item.ref.directory === directory)).toEqual([])
    expect(await (await request("/api/debug/location")).json()).not.toContainEqual({ directory })
  })
}, 60_000)
