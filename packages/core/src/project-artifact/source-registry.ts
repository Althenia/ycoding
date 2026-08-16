export * as ProjectArtifactStandardSourceRegistry from "./source-registry"

import { ProjectArtifact } from "@ycoding-ai/schema/project-artifact"
import { Project } from "@ycoding-ai/schema/project"
import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"

export interface StandardSource {
  readonly scope: "project" | "global"
  readonly managedScopeID?: ProjectArtifact.ScopeID
  readonly managedVersionID?: ProjectArtifact.VersionID
  readonly managedDigest?: ProjectArtifact.Digest
}

export interface StandardSourceResolver {
  readonly resolve: (input: {
    readonly scope: "project" | "global"
    readonly projectID?: Project.ID
    readonly kind: ProjectArtifact.Kind
    readonly id: ProjectArtifact.ID
  }) => Effect.Effect<ReadonlyArray<StandardSource>>
}

export type Record = StandardSource & {
  readonly projectID?: Project.ID
  readonly kind: ProjectArtifact.Kind
  readonly id: ProjectArtifact.ID
  readonly path?: string
}

export interface Registry {
  readonly replace: (location: string, records: ReadonlyArray<Record>) => void
  readonly remove: (location: string) => void
  readonly resolve: StandardSourceResolver["resolve"]
  readonly size: () => number
}

export function make(): Registry {
  const snapshots = new Map<string, ReadonlyArray<Record>>()
  return {
    replace: (location, records) => snapshots.set(location, records),
    remove: (location) => snapshots.delete(location),
    resolve: (input) =>
      Effect.sync(() => {
        const records = Array.from(snapshots.values()).flat().filter((record) =>
          record.scope === input.scope &&
          record.kind === input.kind &&
          record.id === input.id &&
          (record.scope === "global" || record.projectID === input.projectID),
        )
        const unique = new Map<string, StandardSource>()
        for (const record of records) {
          const value: StandardSource = {
            scope: record.scope,
            ...(record.managedScopeID === undefined ? {} : { managedScopeID: record.managedScopeID }),
            ...(record.managedVersionID === undefined ? {} : { managedVersionID: record.managedVersionID }),
            ...(record.managedDigest === undefined ? {} : { managedDigest: record.managedDigest }),
          }
          unique.set(JSON.stringify(value), value)
        }
        return Array.from(unique.values())
      }),
    size: () => snapshots.size,
  }
}

export class StandardSourceRegistry extends Context.Service<StandardSourceRegistry, Registry>()(
  "@ycoding/ProjectArtifactStandardSourceRegistry",
) {}

export const layer = Layer.sync(StandardSourceRegistry, () => StandardSourceRegistry.of(make()))
export const registryNode = makeGlobalNode({ service: StandardSourceRegistry, layer, deps: [] })
