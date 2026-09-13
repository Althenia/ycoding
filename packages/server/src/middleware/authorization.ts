import { ServerAuth } from "../auth"
import { UnauthorizedError } from "@ycoding-ai/protocol/errors"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"
export { Authorization } from "@ycoding-ai/protocol/middleware/authorization"
import { hasPtyConnectTicketURL } from "@ycoding-ai/protocol/groups/pty"
import { isBrowserConnectURL } from "@ycoding-ai/protocol/groups/browser"
import { Effect, Encoding, Layer, Redacted } from "effect"
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

const AUTH_TOKEN_QUERY = "auth_token"
const WWW_AUTHENTICATE = 'Basic realm="Secure Area"'

function emptyCredential() {
  return { username: "", password: Redacted.make("") }
}

function decodeCredential(input: string) {
  return Effect.fromResult(Encoding.decodeBase64String(input)).pipe(
    Effect.match({
      onFailure: emptyCredential,
      onSuccess: (header) => {
        const separator = header.indexOf(":")
        if (separator === -1) return emptyCredential()
        return { username: header.slice(0, separator), password: Redacted.make(header.slice(separator + 1)) }
      },
    }),
  )
}

function credentialFromRequest(request: HttpServerRequest.HttpServerRequest) {
  const url = new URL(request.url, "http://localhost")
  const token = url.searchParams.get(AUTH_TOKEN_QUERY)
  if (token) return decodeCredential(token)
  const match = /^Basic\s+(.+)$/i.exec(request.headers.authorization ?? "")
  if (match) return decodeCredential(match[1])
  return Effect.succeed(emptyCredential())
}

export function authorizedRequest(request: HttpServerRequest.HttpServerRequest, config: ServerAuth.Info) {
  return credentialFromRequest(request).pipe(Effect.map((credential) => ServerAuth.authorized(credential, config)))
}

export const authorizationLayer = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    if (!ServerAuth.required(config)) return Authorization.of((effect) => effect)
    return Authorization.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        // Browser WebSocket clients cannot set the normal authorization header. The raw
        // PTY and extension handlers authenticate their ticket or first frame instead.
        const url = new URL(request.url, "http://localhost")
        if (hasPtyConnectTicketURL(url) || isBrowserConnectURL(url)) return yield* effect
        if (yield* authorizedRequest(request, config)) return yield* effect
        yield* HttpEffect.appendPreResponseHandler((_request, response) =>
          Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", WWW_AUTHENTICATE)),
        )
        return yield* new UnauthorizedError({ message: "Authentication required" })
      }),
    )
  }),
)
