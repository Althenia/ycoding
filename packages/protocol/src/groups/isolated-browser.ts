import { Browser } from "@ycoding-ai/schema/browser"
import { IsolatedBrowser } from "@ycoding-ai/schema/isolated-browser"
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
const { sessionID: _observeSessionID, ...ObservePayload } = IsolatedBrowser.ObserveInput.fields
const { sessionID: _actionSessionID, ...ActionPayload } = IsolatedBrowser.ActionInput.fields

export const makeIsolatedBrowserGroup = <SessionLocationId extends HttpApiMiddleware.AnyId, SessionLocationService>(
  sessionLocationMiddleware: Context.Key<SessionLocationId, SessionLocationService>,
) =>
  HttpApiGroup.make("server.isolatedBrowser")
    .add(
      HttpApiEndpoint.get("isolatedBrowser.status", "/api/session/:sessionID/browser/isolated", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: IsolatedBrowser.Status }),
        error: SessionNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.isolatedBrowser.status",
          summary: "Inspect temporary isolated-browser status",
          description: "Return safe process-local lifecycle state without host paths or launch arguments.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("isolatedBrowser.start", "/api/session/:sessionID/browser/isolated/start", {
        params: { sessionID: Session.ID },
        payload: IsolatedBrowser.StartPayload,
        success: Schema.Struct({ data: IsolatedBrowser.Status }),
        error: operationErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.isolatedBrowser.start",
          summary: "Start temporary isolated headless Chrome",
          description: "Start one Session-owned disposable browser at an authenticated user-supplied safe URL.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("isolatedBrowser.tabs", "/api/session/:sessionID/browser/isolated/tabs", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Schema.Array(Browser.Tab) }),
        error: SessionNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.isolatedBrowser.tabs",
          summary: "List the Session-owned isolated tab",
          description: "Return bounded query-free metadata for the temporary isolated page.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("isolatedBrowser.observe", "/api/session/:sessionID/browser/isolated/observe", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct(ObservePayload),
        success: Schema.Struct({ data: IsolatedBrowser.Observation }),
        error: operationErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.isolatedBrowser.observe",
          summary: "Observe the isolated page semantically",
          description: "Return bounded accessibility metadata without raw DOM, storage, or input values.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("isolatedBrowser.action", "/api/session/:sessionID/browser/isolated/action", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct(ActionPayload),
        success: Schema.Struct({ data: IsolatedBrowser.ActionResult }),
        error: operationErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.isolatedBrowser.action",
          summary: "Run one fenced isolated-browser action",
          description: "Run a strict semantic action without exposing raw CDP or evaluation.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("isolatedBrowser.control", "/api/session/:sessionID/browser/isolated/control", {
        params: { sessionID: Session.ID },
        payload: IsolatedBrowser.ControlInput,
        success: Schema.Struct({ data: IsolatedBrowser.Status }),
        error: operationErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.isolatedBrowser.control",
          summary: "Pause or resume isolated-browser control",
          description: "Pause dispatch or resume only after a fresh observation boundary.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.delete("isolatedBrowser.stop", "/api/session/:sessionID/browser/isolated", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: operationErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.isolatedBrowser.stop",
          summary: "Stop and destroy temporary isolated Chrome",
          description: "Cancel owned work and destroy only the Session-owned disposable context and process.",
        }),
      ),
    )
    .middleware(sessionLocationMiddleware)
    .annotateMerge(
      OpenApi.annotations({
        title: "isolatedBrowser",
        description: "Temporary Session-owned isolated headless browser routes.",
      }),
    )
