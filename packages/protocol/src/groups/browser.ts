import { Browser } from "@ycoding-ai/schema/browser"
import { Session } from "@ycoding-ai/schema/session"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import {
  ConflictError,
  ForbiddenError,
  InvalidRequestError,
  ServiceUnavailableError,
  SessionNotFoundError,
} from "../errors.js"

const operationErrors = [
  SessionNotFoundError,
  ForbiddenError,
  ConflictError,
  InvalidRequestError,
  ServiceUnavailableError,
] as const
const { sessionID: _observeSessionID, ...ObservePayload } = Browser.ObserveInput.fields
const { sessionID: _actionSessionID, ...ActionPayload } = Browser.ActionInput.fields

const BROWSER_CONNECT_PATH = /^\/api\/session\/[^/]+\/browser\/connect$/

// Both server authentication layers skip only this secret-free WebSocket path. The raw
// handler then requires an exact Chrome-extension Origin and a bounded one-time or durable
// credential in the first frame before it upgrades the connection into a usable bridge.
export function isBrowserConnectURL(url: URL) {
  return BROWSER_CONNECT_PATH.test(url.pathname) && url.search === ""
}

export const makeBrowserGroup = <SessionLocationId extends HttpApiMiddleware.AnyId, SessionLocationService>(
  sessionLocationMiddleware: Context.Key<SessionLocationId, SessionLocationService>,
) =>
  HttpApiGroup.make("server.browser")
    .add(
      HttpApiEndpoint.get("browser.status", "/api/session/:sessionID/browser", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Browser.Status }),
        error: SessionNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.browser.status",
          summary: "Inspect selected-tab browser bridge status",
          description: "Return safe process-local bridge state for the owning Session.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("browser.tabs", "/api/session/:sessionID/browser/tabs", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Schema.Array(Browser.Tab) }),
        error: SessionNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.browser.tabs",
          summary: "List explicitly shared Chrome tabs",
          description: "List bounded, query-free metadata for tabs shared with the owning Session.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("browser.start", "/api/session/:sessionID/browser/start", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Browser.Pairing }),
        error: operationErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.browser.start",
          summary: "Create a one-time Chrome pairing secret",
          description: "Create a short-lived secret for one manually installed extension connection.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("browser.observe", "/api/session/:sessionID/browser/observe", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct(ObservePayload),
        success: Schema.Struct({ data: Browser.Observation }),
        error: operationErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.browser.observe",
          summary: "Observe one shared tab semantically",
          description: "Read one bounded accessibility observation without raw DOM or input values.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("browser.action", "/api/session/:sessionID/browser/action", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct(ActionPayload),
        success: Schema.Struct({ data: Browser.ActionResult }),
        error: operationErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.browser.action",
          summary: "Run one generation-fenced browser action",
          description:
            "Dispatch one strict semantic action using its original call identity; uncertain mutations are never replayed.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("browser.control", "/api/session/:sessionID/browser/control", {
        params: { sessionID: Session.ID },
        payload: Browser.ControlInput,
        success: Schema.Struct({ data: Browser.Status }),
        error: operationErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.browser.control",
          summary: "Pause or resume selected-tab automation",
          description: "Pause dispatch or explicitly hand control back after a fresh observation boundary.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.delete("browser.stop", "/api/session/:sessionID/browser", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: operationErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.browser.stop",
          summary: "Stop the owning browser bridge",
          description: "Revoke only this bridge and its explicitly shared debugger attachments.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.delete("browser.forget", "/api/session/:sessionID/browser/pairing", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: operationErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.browser.forget",
          summary: "Forget the Chrome extension pairing",
          description: "Revoke durable trust for this Session and disconnect its selected-tab bridge.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("browser.connect", "/api/session/:sessionID/browser/connect", {
        params: { sessionID: Session.ID },
        success: Schema.Boolean,
        error: [ForbiddenError, SessionNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.browser.connect",
          summary: "Connect the Chrome selected-tab bridge",
          description:
            "Establish a Chrome-extension-origin WebSocket; authentication occurs in its first bounded frame.",
          transform: (operation) => ({ ...operation, "x-websocket": true }),
        }),
      ),
    )
    .middleware(sessionLocationMiddleware)
    .annotateMerge(
      OpenApi.annotations({ title: "browser", description: "Experimental Session-owned selected-tab Chrome routes." }),
    )
