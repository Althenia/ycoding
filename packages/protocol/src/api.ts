import { Context } from "effect"
import { HttpApi, HttpApiGroup, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { SchemaErrorMiddleware } from "./middleware/schema-error.js"
import { GenerateGroup } from "./groups/generate.js"
import { MessageGroup } from "./groups/message.js"
import { makeModelGroup } from "./groups/model.js"
import { makeProviderGroup } from "./groups/provider.js"
import { ProviderUsageGroup } from "./groups/provider-usage.js"
import { makeSessionGroup } from "./groups/session.js"
import { makePermissionGroup } from "./groups/permission.js"
import { FileSystemGroup } from "./groups/fs.js"
import { makeFormGroup } from "./groups/form.js"
import { makeGuardrailGroup } from "./groups/guardrail.js"
import { makeReviewGroup } from "./groups/review.js"
import { CommandGroup } from "./groups/command.js"
import { SkillGroup } from "./groups/skill.js"
import { EventGroup, makeEventGroup } from "./groups/event.js"
import type { Definition } from "@ycoding-ai/schema/event"
import { AgentGroup } from "./groups/agent.js"
import { PluginGroup } from "./groups/plugin.js"
import { HealthGroup } from "./groups/health.js"
import { ServerGroup } from "./groups/server.js"
import { UsageGroup } from "./groups/usage.js"
import { KeepAwakeGroup } from "./groups/keep-awake.js"
import { RemoteGroup } from "./groups/remote.js"
import { DebugGroup } from "./groups/debug.js"
import { PtyGroup } from "./groups/pty.js"
import { ShellGroup } from "./groups/shell.js"
import { makeQuestionGroup } from "./groups/question.js"
import { ReferenceGroup } from "./groups/reference.js"
import { Authorization } from "./middleware/authorization.js"
import { LocationGroup } from "./groups/location.js"
import { IntegrationGroup } from "./groups/integration.js"
import { McpGroup } from "./groups/mcp.js"
import { ConfigGroup } from "./groups/config.js"
import { CredentialGroup } from "./groups/credential.js"
import { ProjectGroup } from "./groups/project.js"
import { ProjectCopyGroup } from "./groups/project-copy.js"
import { VcsGroup } from "./groups/vcs.js"
import { ProjectArtifactGroup } from "./groups/project-artifact.js"
import { makeIncidentGroup } from "./groups/incident.js"
import { makeBrowserGroup } from "./groups/browser.js"
import { makeIsolatedBrowserGroup } from "./groups/isolated-browser.js"
import { CoordinationGroup } from "./groups/coordination.js"
import { DotsGroup } from "./groups/dots.js"
import { DecisionGroup } from "./groups/decision.js"

type LocationGroups<LocationId extends HttpApiMiddleware.AnyId> =
  | HttpApiGroup.AddMiddleware<typeof LocationGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof AgentGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof PluginGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof GenerateGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof ProviderUsageGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof IntegrationGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof McpGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof ConfigGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof CredentialGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof ProjectGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof FileSystemGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof CommandGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof SkillGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof PtyGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof ShellGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof ReferenceGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof ProjectCopyGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof VcsGroup, LocationId>
  | HttpApiGroup.AddMiddleware<typeof ProjectArtifactGroup, LocationId>

type SessionGroups<SessionLocationId extends HttpApiMiddleware.AnyId, SessionLocationService> =
  | ReturnType<typeof makeSessionGroup<SessionLocationId, SessionLocationService>>
  | typeof DotsGroup
  | ReturnType<typeof makeGuardrailGroup<SessionLocationId, SessionLocationService>>
  | ReturnType<typeof makeReviewGroup<SessionLocationId, SessionLocationService>>
  | ReturnType<typeof makeBrowserGroup<SessionLocationId, SessionLocationService>>
  | ReturnType<typeof makeIsolatedBrowserGroup<SessionLocationId, SessionLocationService>>
  | HttpApiGroup.AddMiddleware<typeof MessageGroup, SessionLocationId>

type CatalogGroups<
  LocationId extends HttpApiMiddleware.AnyId,
  LocationService,
  CatalogLocationId extends HttpApiMiddleware.AnyId,
  CatalogLocationService,
> =
  | ReturnType<typeof makeModelGroup<LocationId, LocationService, CatalogLocationId, CatalogLocationService>>
  | ReturnType<typeof makeProviderGroup<LocationId, LocationService, CatalogLocationId, CatalogLocationService>>

type FormGroups<
  LocationId extends HttpApiMiddleware.AnyId,
  LocationService,
  FormLocationId extends HttpApiMiddleware.AnyId,
  FormLocationService,
> = ReturnType<typeof makeFormGroup<LocationId, LocationService, FormLocationId, FormLocationService>>

type MixedMiddlewareGroups<
  LocationId extends HttpApiMiddleware.AnyId,
  LocationService,
  SessionLocationId extends HttpApiMiddleware.AnyId,
  SessionLocationService,
> =
  | ReturnType<typeof makePermissionGroup<LocationId, LocationService, SessionLocationId, SessionLocationService>>
  | ReturnType<typeof makeQuestionGroup<LocationId, LocationService, SessionLocationId, SessionLocationService>>
  | ReturnType<typeof makeIncidentGroup<LocationId, LocationService>>

type ApiGroups<
  LocationId extends HttpApiMiddleware.AnyId,
  LocationService,
  CatalogLocationId extends HttpApiMiddleware.AnyId,
  CatalogLocationService,
  FormLocationId extends HttpApiMiddleware.AnyId,
  FormLocationService,
  SessionLocationId extends HttpApiMiddleware.AnyId,
  SessionLocationService,
  Event extends HttpApiGroup.Constraint,
> =
  | typeof HealthGroup
  | typeof ServerGroup
  | typeof UsageGroup
  | typeof RemoteGroup
  | typeof KeepAwakeGroup
  | typeof DebugGroup
  | typeof CoordinationGroup
  | typeof DecisionGroup
  | LocationGroups<LocationId>
  | CatalogGroups<LocationId, LocationService, CatalogLocationId, CatalogLocationService>
  | FormGroups<LocationId, LocationService, FormLocationId, FormLocationService>
  | SessionGroups<SessionLocationId, SessionLocationService>
  | MixedMiddlewareGroups<LocationId, LocationService, SessionLocationId, SessionLocationService>
  | Event

type EventGroupFor<Definitions extends ReadonlyArray<Definition>> = ReturnType<typeof makeEventGroup<Definitions>>

export type Api<
  LocationId extends HttpApiMiddleware.AnyId,
  LocationService,
  CatalogLocationId extends HttpApiMiddleware.AnyId,
  CatalogLocationService,
  FormLocationId extends HttpApiMiddleware.AnyId,
  FormLocationService,
  SessionLocationId extends HttpApiMiddleware.AnyId,
  SessionLocationService,
  Event extends HttpApiGroup.Constraint,
> = HttpApi.HttpApi<
  "server",
  HttpApiGroup.AddMiddleware<
    HttpApiGroup.AddMiddleware<
      ApiGroups<
        LocationId,
        LocationService,
        CatalogLocationId,
        CatalogLocationService,
        FormLocationId,
        FormLocationService,
        SessionLocationId,
        SessionLocationService,
        Event
      >,
      Authorization
    >,
    SchemaErrorMiddleware
  >
>

// Protocol owns middleware placement, while Server injects concrete keys so Core service identities stay downstream.
const makeApiFromGroup = <
  const Group extends HttpApiGroup.Constraint,
  LocationId extends HttpApiMiddleware.AnyId,
  LocationService,
  CatalogLocationId extends HttpApiMiddleware.AnyId,
  CatalogLocationService,
  FormLocationId extends HttpApiMiddleware.AnyId,
  FormLocationService,
  SessionLocationId extends HttpApiMiddleware.AnyId,
  SessionLocationService,
>(
  eventGroup: Group,
  locationMiddleware: Context.Key<LocationId, LocationService>,
  catalogLocationMiddleware: Context.Key<CatalogLocationId, CatalogLocationService>,
  formLocationMiddleware: Context.Key<FormLocationId, FormLocationService>,
  sessionLocationMiddleware: Context.Key<SessionLocationId, SessionLocationService>,
): Api<
  LocationId,
  LocationService,
  CatalogLocationId,
  CatalogLocationService,
  FormLocationId,
  FormLocationService,
  SessionLocationId,
  SessionLocationService,
  Group
> =>
  HttpApi.make("server")
    .add(HealthGroup)
    .add(ServerGroup)
    .add(LocationGroup.middleware(locationMiddleware))
    .add(AgentGroup.middleware(locationMiddleware))
    .add(PluginGroup.middleware(locationMiddleware))
    .add(makeSessionGroup(sessionLocationMiddleware))
    .add(makeGuardrailGroup(sessionLocationMiddleware))
    .add(MessageGroup.middleware(sessionLocationMiddleware))
    .add(makeModelGroup(locationMiddleware, catalogLocationMiddleware))
    .add(GenerateGroup.middleware(locationMiddleware))
    .add(makeProviderGroup(locationMiddleware, catalogLocationMiddleware))
    .add(ProviderUsageGroup.middleware(locationMiddleware))
    .add(IntegrationGroup.middleware(locationMiddleware))
    .add(McpGroup.middleware(locationMiddleware))
    .add(CredentialGroup.middleware(locationMiddleware))
    .add(ProjectGroup.middleware(locationMiddleware))
    .add(makeFormGroup(locationMiddleware, formLocationMiddleware))
    .add(makePermissionGroup(locationMiddleware, sessionLocationMiddleware))
    .add(FileSystemGroup.middleware(locationMiddleware))
    .add(CommandGroup.middleware(locationMiddleware))
    .add(SkillGroup.middleware(locationMiddleware))
    .add(eventGroup)
    .add(PtyGroup.middleware(locationMiddleware))
    .add(ShellGroup.middleware(locationMiddleware))
    .add(makeQuestionGroup(locationMiddleware, sessionLocationMiddleware))
    .add(ReferenceGroup.middleware(locationMiddleware))
    .add(ProjectCopyGroup.middleware(locationMiddleware))
    .add(VcsGroup.middleware(locationMiddleware))
    .add(ProjectArtifactGroup.middleware(locationMiddleware))
    .add(DebugGroup)
    .add(makeBrowserGroup(sessionLocationMiddleware))
    .add(makeIsolatedBrowserGroup(sessionLocationMiddleware))
    .add(UsageGroup)
    .add(makeIncidentGroup(locationMiddleware))
    .add(RemoteGroup)
    .add(KeepAwakeGroup)
    .add(ConfigGroup.middleware(locationMiddleware))
    .add(makeReviewGroup(sessionLocationMiddleware))
    .add(CoordinationGroup)
    .add(DotsGroup)
    .add(DecisionGroup)
    .annotateMerge(
      OpenApi.annotations({
        title: "ycoding HttpApi",
        version: "0.0.1",
        description: "Experimental HttpApi surface for selected instance routes.",
      }),
    )
    .middleware(Authorization)
    .middleware(SchemaErrorMiddleware)

export const makeApi = <
  const Definitions extends ReadonlyArray<Definition>,
  LocationId extends HttpApiMiddleware.AnyId,
  LocationService,
  CatalogLocationId extends HttpApiMiddleware.AnyId,
  CatalogLocationService,
  FormLocationId extends HttpApiMiddleware.AnyId,
  FormLocationService,
  SessionLocationId extends HttpApiMiddleware.AnyId,
  SessionLocationService,
>(options: {
  readonly definitions: Definitions
  readonly locationMiddleware: Context.Key<LocationId, LocationService>
  readonly catalogLocationMiddleware: Context.Key<CatalogLocationId, CatalogLocationService>
  readonly formLocationMiddleware: Context.Key<FormLocationId, FormLocationService>
  readonly sessionLocationMiddleware: Context.Key<SessionLocationId, SessionLocationService>
}): Api<
  LocationId,
  LocationService,
  CatalogLocationId,
  CatalogLocationService,
  FormLocationId,
  FormLocationService,
  SessionLocationId,
  SessionLocationService,
  EventGroupFor<Definitions>
> =>
  makeApiFromGroup(
    makeEventGroup(options.definitions),
    options.locationMiddleware,
    options.catalogLocationMiddleware,
    options.formLocationMiddleware,
    options.sessionLocationMiddleware,
  )

export const makeDefaultApi = <
  LocationId extends HttpApiMiddleware.AnyId,
  LocationService,
  CatalogLocationId extends HttpApiMiddleware.AnyId,
  CatalogLocationService,
  FormLocationId extends HttpApiMiddleware.AnyId,
  FormLocationService,
  SessionLocationId extends HttpApiMiddleware.AnyId,
  SessionLocationService,
>(options: {
  readonly locationMiddleware: Context.Key<LocationId, LocationService>
  readonly catalogLocationMiddleware: Context.Key<CatalogLocationId, CatalogLocationService>
  readonly formLocationMiddleware: Context.Key<FormLocationId, FormLocationService>
  readonly sessionLocationMiddleware: Context.Key<SessionLocationId, SessionLocationService>
}): Api<
  LocationId,
  LocationService,
  CatalogLocationId,
  CatalogLocationService,
  FormLocationId,
  FormLocationService,
  SessionLocationId,
  SessionLocationService,
  typeof EventGroup
> =>
  makeApiFromGroup(
    EventGroup,
    options.locationMiddleware,
    options.catalogLocationMiddleware,
    options.formLocationMiddleware,
    options.sessionLocationMiddleware,
  )
