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
    draft.method.update({ integrationID: "auth-fixture", method: { type: "oauth", id: "code", label: "Remote authorization code", remote: true }, authorize: () => Effect.succeed({
      mode: "code" as const, url: "https://example.com/authorize", instructions: "Enter the synthetic authorization code.",
      callback: (code: string) => code === "synthetic-code" ? Effect.succeed(Credential.OAuth.make({ type: "oauth", methodID: Integration.MethodID.make("code"), access: "synthetic-access-secret", refresh: "synthetic-refresh-secret", expires: Date.now() + 60000 })) : Effect.fail(new Error("synthetic-private-diagnostic")),
    }) })
  })
}) })
