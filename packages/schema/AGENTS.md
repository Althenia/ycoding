# Schema Package Guide

`@ycoding-ai/schema` owns browser-safe wire and storage contracts shared by Protocol, Server, Core, and generated Clients. Keep runtime behavior, service layers, side effects, and host-local implementation details in the domain package that owns them.

## Package Boundary

- Preserve the dependency direction: `@ycoding-ai/schema <- @ycoding-ai/protocol <- @ycoding-ai/server`.
- Schema values should be serializable contract definitions, not service implementations or runtime registries.
- A domain may keep a minimal public wire contract here when Client generation needs it, but do not move the broader runtime model into Schema just because an event is public. Schema may own the minimum browser-safe event payload, while plugin runtime behavior stays outside Schema.
- The root barrel exports canonical current domain contracts. Specialized event modules, manifests, and infrastructure modules use direct entrypoints when they should not become first-class root exports.

## V2-only contracts

- This repository is V2 only. Do not add or restore V1 contracts, compatibility barrels, event facades, or migration-only runtime shapes.
- Current contracts use canonical names such as `Session`, `Permission`, and `Question`.
- `@ycoding-ai/protocol` defines the HTTP surface and `@ycoding-ai/client` exposes generated and composed client APIs.

## Events

- Classify event definitions by protocol role before adding them to a public manifest: `current`, `shared transitional`, or `V1-only`.
- Include an event in Protocol only when a current Client or runtime contract requires it.
- Do not restore removed legacy events such as `message.updated` or `message.part.*`.
- Preserve a single canonical event definition. Do not duplicate definitions for generation convenience.

## Module Shape

- Use one canonical exported value for each contract. Avoid bridge aliases such as `PluginID`, `PluginEvent`, `PtyInfo`, and `PtyEvent`.
- Prefer importing the schema module namespace and reading canonical members, for example `Plugin.ID` or `Question.Info`.
- Core may compose Schema contracts with runtime behavior into a deliberate domain facade, but the facade must re-export the exact canonical Schema value. Do not create a second schema identity.
- Use flat top-level exports plus the package's existing namespace projection pattern, for example `export * as SessionMessage from "./session-message"`.
- Keep standalone ID modules only when they prevent real cycles or heavy dependency edges. Inline one-off IDs into their owning contract module when no cycle exists.

## Public Re-exports

- Public leaf packages re-export the canonical domain namespaces used by their APIs so consumers install and version one package. Keep the list curated by public API reachability rather than mirroring the Schema root.
- Re-export directly from `@ycoding-ai/schema/<domain>` and preserve the exact canonical values and types. Do not wrap schemas, duplicate definitions, or route exports through another facade package.
- Internal packages import contracts directly from their canonical Schema owner. Import a Core domain facade only when runtime behavior from that facade is required.
- Resolve name collisions by retaining the domain namespace and qualifying its members, such as `Session.Info` and `Agent.Info`. Do not introduce aliases such as `SessionSchema`, `AgentSchema`, or `ModelSchema`.

## Naming

- Exported schema values and namespace objects use `PascalCase`.
- Schema-building functions and combinators use `camelCase`.
- The package's static-method combinator is `statics(...)`.
- Keep descriptive schema value names such as `PositiveInt`, `NonNegativeInt`, `AbsolutePath`, `RelativePath`, and `DateTimeUtcFromMillis`.

## Optional Fields And Defaults

- Use the package `optional(...)` helper for optional object properties, including nested structs and event payloads, so encoded objects omit `undefined` keys.
- Use raw `Schema.optional(...)` only when preserving `undefined` as an explicitly encoded property is intentional and documented.
- External convenience defaults are normally decode-only with `Schema.withDecodingDefault(...)`.
- Add constructor defaults only when the domain value itself requires construction-time normalization.

## Public Types

- Public `Schema.Struct` records use same-name interfaces:

  ```ts
  export interface Info extends Schema.Schema.Type<typeof Info> {}
  export const Info = Schema.Struct({ ... })
  ```

- Use type aliases for unions, scalars, arrays, branded scalar types, and event payload helper types.
- Closed documented string sets use `Schema.Literals(...)`. If arbitrary strings are valid, document the field as arbitrary rather than listing a closed set.

## Mutability

- Public Schema contracts are readonly by default.
- Do not use `Schema.mutable(...)` in public contracts for runtime convenience.
- Runtime code that needs mutation should opt in at the boundary with `Types.DeepMutable`, a purpose-built draft type, or another explicit mutable API.

## Unknown Values

- Current public contracts avoid `Schema.Any`.
- Use `Schema.Json` for values that must be JSON-serializable.
- Use `Schema.Unknown` for genuinely opaque values that require consumer-side narrowing.
- Keep `Schema.Any` only at an explicitly unsafe compatibility boundary with a documented reason.

## IDs And Identifiers

- Current ID constructors expose `create()`.
- Directional constructors such as `ascending()` or `descending()` remain only where ordering semantics are part of the public contract or compatibility requires the old method.
- New generated ID schemas must validate exactly the prefix they emit, including the underscore.
- Do not tighten legacy loose ID validators without an explicit compatibility and migration decision; existing callers and tests may rely on accepted non-canonical IDs.
- Reusable exported public schemas get stable, domain-qualified identifiers such as `Model.Ref` or `Agent.Color`.
- Public schema identifiers and brands must be unique and stable. Private one-use nested schemas may remain anonymous.

## Tests For Contract Changes

- Add focused tests when changing contract behavior or generated surface.
- Cover optional properties omitting `undefined`, no accidental current-contract `Schema.Any`, stable and unique public identifiers, exact facade/schema identity, and current Protocol manifests excluding V1-only events.
