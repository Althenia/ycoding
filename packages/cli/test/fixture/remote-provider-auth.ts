import { define } from "@ycoding-ai/plugin/effect/plugin"
import { Credential } from "@ycoding-ai/schema/credential"
import { Integration } from "@ycoding-ai/schema/integration"
import { Effect } from "effect"

export default define({ id: "test.remote-provider-auth", effect: Effect.fn(function* (ctx) {
  yield* ctx.catalog.transform((draft) => draft.provider.update("auth-fixture", (provider) => { provider.name = "Auth fixture"; provider.integrationID = Integration.ID.make("auth-fixture") }))
  yield* ctx.integration.transform((draft) => {
    draft.update("auth-fixture", (integration) => { integration.name = "Auth fixture" })
    draft.method.update({ integrationID: "auth-fixture", method: { type: "key" } })
    draft.method.update({ integrationID: "auth-fixture", method: { type: "command", id: "command", label: "Registered command", command: [process.execPath, "-e", 'process.stderr.write("synthetic-private-diagnostic");process.stdout.write("synthetic-command-secret")'] } })
    draft.method.update({ integrationID: "auth-fixture", method: { type: "oauth", id: "code", label: "Remote authorization code", remote: true },
      refresh: (credential) => Effect.tryPromise({
        try: async () => {
          const response = await fetch(process.env.AUTH_FIXTURE_TOKEN_URL!, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: credential.refresh }) })
          const body: { access_token?: string; expires_in?: number; error?: string } = await response.json()
          if (!response.ok || !body.access_token) throw new Error(body.error ?? "token endpoint rejected the refresh")
          return Credential.OAuth.make({ type: "oauth", methodID: credential.methodID, access: body.access_token, refresh: credential.refresh, expires: Date.now() + (body.expires_in ?? 3600) * 1000 })
        },
        catch: (cause) => cause,
      }),
      authorize: () => Effect.succeed({
      mode: "code" as const, url: "https://example.com/authorize", instructions: "Enter the synthetic authorization code.",
      callback: (code: string) => code === "synthetic-code" ? Effect.succeed(Credential.OAuth.make({ type: "oauth", methodID: Integration.MethodID.make("code"), access: "synthetic-access-secret", refresh: "synthetic-refresh-secret", expires: Date.now() + 60000 })) : Effect.fail(new Error("synthetic-private-diagnostic")),
    }) })
  })
}) })
