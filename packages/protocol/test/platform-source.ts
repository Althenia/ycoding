import { ClientApi } from "../src/client.js"
import { Schema } from "effect"
import { RelativePath, NonNegativeInt } from "@ycoding-ai/schema/schema"
import type { HttpApiEndpoint } from "effect/unstable/httpapi"

export const platformGroups = new Set(
  [
    "browser",
    "isolatedBrowser",
    "keepAwake",
    "fs",
    "vcs",
    "projectCopy",
    "pty",
    "shell",
    "health",
    "server",
    "debug",
    "remote",
  ].map((name) => `server.${name}`),
)
export const platformExclusions = { "browser.connect": "EXTERNAL", "pty.connect": "EXTERNAL" } as const
export const assetSource = "packages/protocol/src/groups/fs.ts#FileSystemGroup"
export const AssetMetadata = Schema.Struct({ mime: Schema.String, byteCount: NonNegativeInt }).annotate({
  identifier: "Platform.AssetMetadata",
})

export function platformEndpoints() {
  return Object.values(ClientApi.groups)
    .filter((group) => platformGroups.has(group.identifier))
    .flatMap((group) =>
      Object.values<
        Pick<
          HttpApiEndpoint.Top,
          "identifier" | "method" | "params" | "query" | "payload" | "success" | "error" | "headers" | "path"
        >
      >(group.endpoints).map((endpoint) => ({ group: group.identifier, endpoint })),
    )
    .sort((a, b) => a.endpoint.identifier.localeCompare(b.endpoint.identifier))
}

export function platformRpcEndpoints() {
  return platformEndpoints()
    .filter(({ endpoint }) => !(endpoint.identifier in platformExclusions))
    .map(({ group, endpoint }) => ({
      group,
      endpoint:
        endpoint.identifier === "fs.read"
          ? {
              ...endpoint,
              params: Schema.Struct({ path: RelativePath }).annotate({ identifier: "Platform.AssetPath" }),
              success: new Set([AssetMetadata]),
            }
          : endpoint,
    }))
}
