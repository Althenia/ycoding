import { describe, expect } from "bun:test"
import { Credential } from "@ycoding-ai/core/credential"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Integration } from "@ycoding-ai/core/integration"
import { Location } from "@ycoding-ai/core/location"
import { Project } from "@ycoding-ai/core/project"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@ycoding-ai/protocol/middleware/schema-error"
import { Context, Effect, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { testEffect } from "../../core/test/lib/effect"
import { Api } from "../src/api"
import { CredentialHandler } from "../src/handlers/credential"
import { IntegrationHandler } from "../src/handlers/integration"
import { LocationMiddleware, type LocationServices } from "../src/location"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Integration.node, Credential.node, EventRuntime.node])))

const acme = Integration.ID.make("acme")
const other = Integration.ID.make("other")
const keyOnly = Integration.ID.make("keyonly")
const methodID = Integration.MethodID.make("browser")
const envName = "SYNTHETIC_KEYONLY_API_KEY"

type TokenRequest = Record<string, string>

const tokenEndpoint = () => {
  const requests: TokenRequest[] = []
  const state = { refresh: "ok" as "ok" | "invalid_grant" }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const form = Object.fromEntries(new URLSearchParams(await request.text()))
      requests.push(form)
      if (form.grant_type === "refresh_token") {
        if (state.refresh === "invalid_grant")
          return Response.json(
            { error: "invalid_grant", error_description: "Refresh token revoked by synthetic issuer" },
            { status: 400 },
          )
        return Response.json({ access_token: "at-synthetic-2", refresh_token: "rt-synthetic-2", expires_in: 3600 })
      }
      if (form.code === "good")
        return Response.json({ access_token: "at-synthetic-new", refresh_token: "rt-synthetic-new", expires_in: 3600 })
      return Response.json({ error: "invalid_grant", error_description: "Authorization code rejected" }, { status: 400 })
    },
  })
  return { requests, state, server }
}

const exchange = (url: string, body: Record<string, string>) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, { method: "POST", body: new URLSearchParams(body) })
      const json: Record<string, string | number> = await response.json()
      if (!response.ok) throw new Error(`Token endpoint ${response.status}: ${json.error}: ${json.error_description}`)
      return Credential.OAuth.make({
        type: "oauth",
        methodID,
        access: String(json.access_token),
        refresh: String(json.refresh_token),
        expires: Date.now() + Number(json.expires_in) * 1000,
      })
    },
    catch: (error) => error,
  })

const setup = Effect.fn(function* () {
  const integrations = yield* Integration.Service
  const credentials = yield* Credential.Service
  const token = tokenEndpoint()
  yield* Effect.addFinalizer(() => Effect.promise(() => token.server.stop(true)))
  const authorizations: Integration.Inputs[] = []
  const url = `http://127.0.0.1:${token.server.port}/token`
  yield* integrations.transform((editor) => {
    editor.update(acme, (integration) => (integration.name = "Acme"))
    editor.update(other, (integration) => (integration.name = "Other"))
    editor.update(keyOnly, (integration) => (integration.name = "Key Only"))
    editor.method.update({ integrationID: acme, method: { type: "key" } })
    editor.method.update({ integrationID: keyOnly, method: { type: "key" } })
    editor.method.update({ integrationID: keyOnly, method: { type: "env", names: [envName] } })
    editor.method.update({ integrationID: other, method: { type: "key" } })
    editor.method.update({
      integrationID: acme,
      method: { id: methodID, type: "oauth", label: "Browser" },
      authorize: (inputs) =>
        Effect.sync(() => {
          authorizations.push(inputs)
          return {
            mode: "code" as const,
            url: "https://auth.synthetic.test/authorize",
            instructions: "Paste the code",
            callback: (code: string) => exchange(url, { grant_type: "authorization_code", code }),
          }
        }),
      refresh: (value) => exchange(url, { grant_type: "refresh_token", refresh_token: value.refresh }),
    })
  })
  const context = Context.make(
    Location.Service,
    new Location.Info({
      directory: AbsolutePath.make("/synthetic-reconnect"),
      project: { id: Project.ID.make("prj_reconnect"), directory: AbsolutePath.make("/synthetic-reconnect") },
    }),
  ).pipe(Context.add(Integration.Service, integrations))
  const handler = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(
      HttpApi.make("server").add(Api.groups["server.credential"]).add(Api.groups["server.integration"]),
    ).pipe(
      Layer.provide(Layer.mergeAll(CredentialHandler, IntegrationHandler)),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(LocationMiddleware, (effect) =>
            Effect.provide(effect, Context.makeUnsafe<LocationServices>(context.mapUnsafe)),
          ),
          Layer.succeed(Authorization, (effect) => effect),
          Layer.succeed(SchemaErrorMiddleware, (effect) => effect),
        ),
      ),
      Layer.provide(HttpServer.layerServices),
    ),
  )
  yield* Effect.addFinalizer(() => Effect.promise(() => handler.dispose()))
  const web: { handler: (request: Request, context?: any) => Promise<Response> } = handler
  const transcript: string[] = []
  const request = (method: string, path: string, body?: unknown) =>
    Effect.promise(async () => {
      const response = await web.handler(
        new Request(`http://localhost${path}`, {
          method,
          headers: body === undefined ? undefined : { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
        Context.empty(),
      )
      const text = await response.text()
      transcript.push(text)
      return { status: response.status, json: text ? (JSON.parse(text)) : undefined }
    })
  const connections = (integrationID: Integration.ID) =>
    request("GET", "/api/integration").pipe(
      Effect.map(
        (response) => {
          const integrations: Array<{ id: string; connections: Array<Record<string, unknown>> }> = response.json.data
          return integrations.find((integration) => integration.id === integrationID)?.connections
        },
      ),
    )
  const oauth = (input: { label: string; access?: string; refresh?: string; expires?: number }) =>
    credentials.create({
      integrationID: acme,
      label: input.label,
      value: Credential.OAuth.make({
        type: "oauth",
        methodID,
        access: input.access ?? "at-synthetic-1",
        refresh: input.refresh ?? "rt-synthetic-1",
        expires: input.expires ?? Date.now() + 7_200_000,
      }),
    })
  return { credentials, token, request, connections, oauth, transcript, authorizations }
})

describe("credential refresh, reconnect, and key replacement over HTTP", () => {
  it.live("AC-1a refreshes a connected OAuth profile with its stored refresh token", () =>
    Effect.gen(function* () {
      const { credentials, token, request, connections, oauth } = yield* setup()
      const work = yield* oauth({ label: "work" })
      const before = Date.now()

      const response = yield* request("POST", `/api/credential/${work.id}/refresh`)

      expect(response.status).toBe(200)
      expect(response.json.data.status).toBe("refreshed")
      expect(response.json.data.expires).toBeGreaterThan(before + 3_000_000)
      expect(token.requests).toEqual([{ grant_type: "refresh_token", refresh_token: "rt-synthetic-1" }])
      expect((yield* credentials.get(work.id))?.value).toMatchObject({
        access: "at-synthetic-2",
        refresh: "rt-synthetic-2",
        expires: response.json.data.expires,
      })
      expect((yield* credentials.get(work.id))?.accountGeneration).toBe(work.accountGeneration)
      expect(yield* connections(acme)).toEqual([
        { type: "credential", id: work.id, label: "work", active: true, kind: "oauth", status: "connected" },
      ])
    }),
  )

  it.live("AC-1b reports the token endpoint failure and projects refresh_failed until a later refresh succeeds", () =>
    Effect.gen(function* () {
      const { credentials, token, request, connections, oauth } = yield* setup()
      const work = yield* oauth({ label: "work" })
      token.state.refresh = "invalid_grant"

      const failed = yield* request("POST", `/api/credential/${work.id}/refresh`)

      expect(failed.status).toBe(200)
      expect(failed.json.data.status).toBe("failed")
      expect(failed.json.data.message).toContain("invalid_grant")
      expect(failed.json.data.message).toContain("Refresh token revoked by synthetic issuer")
      expect((yield* credentials.get(work.id))?.value).toEqual(work.value)
      expect(yield* connections(acme)).toEqual([
        {
          type: "credential",
          id: work.id,
          label: "work",
          active: true,
          kind: "oauth",
          status: "refresh_failed",
          message: failed.json.data.message,
        },
      ])

      token.state.refresh = "ok"
      expect((yield* request("POST", `/api/credential/${work.id}/refresh`)).json.data.status).toBe("refreshed")
      expect(yield* connections(acme)).toEqual([
        { type: "credential", id: work.id, label: "work", active: true, kind: "oauth", status: "connected" },
      ])
      expect(token.requests).toHaveLength(2)

      const home = yield* oauth({ label: "home" })
      token.state.refresh = "invalid_grant"
      expect((yield* request("POST", `/api/credential/${home.id}/refresh`)).json.data.status).toBe("failed")
      const replaced = yield* request("POST", `/api/integration/${acme}/connect/key`, {
        key: "sk-synthetic-home",
        credentialID: home.id,
      })
      expect(replaced.status).toBe(204)
      expect((yield* connections(acme))?.find((connection) => connection.id === home.id)).toEqual(
        { type: "credential", id: home.id, label: "home", active: true, kind: "key", status: "connected" },
      )
    }),
  )

  it.live("AC-1c refuses to refresh a key profile or an unknown credential without touching the key", () =>
    Effect.gen(function* () {
      const { credentials, token, request } = yield* setup()
      const key = yield* credentials.create({
        integrationID: acme,
        label: "api",
        value: Credential.Key.make({ type: "key", key: "sk-synthetic-key" }),
      })

      const response = yield* request("POST", `/api/credential/${key.id}/refresh`)
      const unknown = yield* request("POST", `/api/credential/cred_synthetic_missing/refresh`)

      expect(response.status).toBe(200)
      expect(response.json.data).toEqual({ status: "failed", message: "API keys do not refresh; replace the key instead" })
      expect(unknown.json.data.status).toBe("failed")
      expect((yield* credentials.get(key.id))?.value).toEqual(key.value)
      expect(token.requests).toEqual([])
    }),
  )

  it.live("AC-1d reconnect replaces the targeted profile in place and makes it active", () =>
    Effect.gen(function* () {
      const { credentials, request, oauth } = yield* setup()
      const work = yield* oauth({ label: "work" })
      const personal = yield* oauth({ label: "personal", access: "at-synthetic-personal" })

      const attempt = yield* request("POST", `/api/integration/${acme}/connect/oauth`, {
        methodID,
        inputs: {},
        credentialID: work.id,
      })
      expect(attempt.status).toBe(200)
      const complete = yield* request(
        "POST",
        `/api/integration/${acme}/connect/oauth/${attempt.json.data.attemptID}/complete`,
        { code: "good" },
      )
      const status = yield* request("GET", `/api/integration/${acme}/connect/oauth/${attempt.json.data.attemptID}`)

      expect(complete.status).toBe(204)
      expect(status.json.data.status).toBe("complete")
      expect(yield* credentials.list(acme)).toHaveLength(2)
      expect(yield* credentials.get(work.id)).toMatchObject({
        label: "work",
        active: true,
        value: { access: "at-synthetic-new", refresh: "rt-synthetic-new" },
      })
      expect(yield* credentials.get(personal.id)).toMatchObject({ label: "personal", active: false, value: personal.value })
    }),
  )

  it.live("AC-1e cancelling a reconnect leaves the old credential and status intact", () =>
    Effect.gen(function* () {
      const { credentials, request, connections, oauth, token } = yield* setup()
      const work = yield* oauth({ label: "work" })
      const listed = yield* connections(acme)

      const attempt = yield* request("POST", `/api/integration/${acme}/connect/oauth`, {
        methodID,
        inputs: {},
        credentialID: work.id,
      })
      const cancel = yield* request("DELETE", `/api/integration/${acme}/connect/oauth/${attempt.json.data.attemptID}`)

      expect(cancel.status).toBe(204)
      expect((yield* credentials.list(acme)).map((credential) => [credential.id, credential.value])).toEqual([
        [work.id, work.value],
      ])
      expect(yield* connections(acme)).toEqual(listed)
      expect(token.requests).toEqual([])
    }),
  )

  it.live("AC-1f a failed reconnect callback fails the attempt and keeps the old credential", () =>
    Effect.gen(function* () {
      const { credentials, request, oauth } = yield* setup()
      const work = yield* oauth({ label: "work" })

      const attempt = yield* request("POST", `/api/integration/${acme}/connect/oauth`, {
        methodID,
        inputs: {},
        credentialID: work.id,
      })
      const complete = yield* request(
        "POST",
        `/api/integration/${acme}/connect/oauth/${attempt.json.data.attemptID}/complete`,
        { code: "bad" },
      )
      const status = yield* request("GET", `/api/integration/${acme}/connect/oauth/${attempt.json.data.attemptID}`)

      expect(complete.status).toBe(400)
      expect(status.json.data.status).toBe("failed")
      expect((yield* credentials.list(acme)).map((credential) => [credential.id, credential.value])).toEqual([
        [work.id, work.value],
      ])
    }),
  )

  it.live("AC-1g rejects reconnect and key replacement targets that are unknown or belong to another integration", () =>
    Effect.gen(function* () {
      const { credentials, request, oauth, authorizations } = yield* setup()
      yield* oauth({ label: "work" })
      const foreign = yield* credentials.create({
        integrationID: other,
        label: "foreign",
        value: Credential.Key.make({ type: "key", key: "sk-synthetic-foreign" }),
      })
      const before = yield* credentials.all()

      const responses = [
        yield* request("POST", `/api/integration/${acme}/connect/oauth`, {
          methodID,
          inputs: {},
          credentialID: foreign.id,
        }),
        yield* request("POST", `/api/integration/${acme}/connect/oauth`, {
          methodID,
          inputs: {},
          credentialID: "cred_synthetic_missing",
        }),
        yield* request("POST", `/api/integration/${acme}/connect/key`, {
          key: "sk-synthetic-replacement",
          credentialID: foreign.id,
        }),
        yield* request("POST", `/api/integration/${acme}/connect/key`, {
          key: "sk-synthetic-replacement",
          credentialID: "cred_synthetic_missing",
        }),
      ]

      expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400])
      expect(responses.map((response) => response.json.kind)).toEqual(Array(4).fill("integration_authorization"))
      expect(authorizations).toEqual([])
      expect(yield* credentials.all()).toEqual(before)
    }),
  )

  it.live("AC-3a/AC-3b/AC-3c sets a key, replaces it in place, and never returns the key text", () =>
    Effect.gen(function* () {
      const { credentials, request, connections, transcript } = yield* setup()

      const set = yield* request("POST", `/api/integration/${keyOnly}/connect/key`, {
        key: "sk-synthetic-key",
        label: "main",
      })
      const first = yield* connections(keyOnly)
      const id = Credential.ID.make(String(first?.[0]?.id))

      expect(set.status).toBe(204)
      expect(first).toEqual([{ type: "credential", id, label: "main", active: true, kind: "key", status: "connected" }])

      const replace = yield* request("POST", `/api/integration/${keyOnly}/connect/key`, {
        key: "sk-synthetic-key-2",
        credentialID: id,
      })

      expect(replace.status).toBe(204)
      expect(yield* connections(keyOnly)).toEqual(first)
      expect((yield* credentials.list(keyOnly)).map((credential) => [credential.id, credential.label, credential.value])).toEqual([
        [id, "main", { type: "key", key: "sk-synthetic-key-2" }],
      ])
      expect(transcript.join("\n")).not.toContain("sk-synthetic")
    }),
  )

  it.live("AC-4 projects expired OAuth profiles, statusless env connections, and unconnected integrations", () =>
    Effect.gen(function* () {
      const { request, oauth } = yield* setup()
      const stale = yield* oauth({ label: "stale", expires: Date.now() - 1_000 })
      process.env[envName] = "sk-synthetic-env"
      yield* Effect.addFinalizer(() => Effect.sync(() => delete process.env[envName]))

      const listed: Array<{ id: string; connections: unknown[] }> = (yield* request("GET", "/api/integration")).json.data
      const fetched: { connections: unknown[] } = (yield* request("GET", `/api/integration/${acme}`)).json.data

      const expected = [
        { type: "credential", id: stale.id, label: "stale", active: true, kind: "oauth", status: "expired" },
      ]
      expect(listed.find((integration) => integration.id === acme)?.connections).toEqual(expected)
      expect(fetched.connections).toEqual(expected)
      expect(listed.find((integration) => integration.id === other)?.connections).toEqual([])
      expect(listed.find((integration) => integration.id === keyOnly)?.connections).toEqual([
        { type: "env", name: envName },
      ])
    }),
  )
})
