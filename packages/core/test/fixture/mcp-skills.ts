import { z } from "zod"
import { Buffer } from "node:buffer"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js"
import { Config } from "@ycoding-ai/core/config"
import { ConfigMCP } from "@ycoding-ai/core/config/mcp"
import { Credential } from "@ycoding-ai/core/credential"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventV2 } from "@ycoding-ai/core/event"
import { Form } from "@ycoding-ai/core/form"
import { FSUtil } from "@ycoding-ai/core/fs-util"
import { Integration } from "@ycoding-ai/core/integration"
import { Location } from "@ycoding-ai/core/location"
import { MCP } from "@ycoding-ai/core/mcp/index"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SkillDiscovery } from "@ycoding-ai/core/skill/discovery"
import { SkillV2 } from "@ycoding-ai/core/skill"
import { Effect, Layer, Stream } from "effect"
import { location } from "./location"

export type SkillFile = {
  readonly name: string
  readonly text: string
  readonly mimeType?: string
}

export type Skill = {
  readonly uri: string
  /** Rendered into the served `SKILL.md` body and into the entry's frontmatter copy. */
  readonly frontmatter: Record<string, unknown>
  readonly files: ReadonlyArray<SkillFile>
}

export type SkillServerOptions = {
  /** Skill entries this server publishes; each `files` set includes `SKILL.md` first. */
  readonly skills?: ReadonlyArray<Skill>
  /** Raw `skills/list` entries to publish instead of computed ones. */
  readonly rawSkills?: ReadonlyArray<unknown>
  /** Omit the `io.modelcontextprotocol/skills` capability entirely. */
  readonly undeclared?: boolean
  /** Declare the skills extension without the base Resources capability it requires. */
  readonly noResources?: boolean
  /** Declare the extension without `directoryRead`. */
  readonly noDirectoryRead?: boolean
  /** Serve `skills/list` from two pages. */
  readonly paginate?: boolean
  /** Alter served bytes without altering the advertised manifest. */
  readonly corrupt?: "size" | "digest"
  /** Serve one resource as valid but non-canonical base64 with whitespace after its padding. */
  readonly nonCanonicalBlob?: { readonly resource: string; readonly suffix: string }
  /**
   * Advertise a `description` that disagrees with the served `SKILL.md`, whose bytes still match the
   * manifest: only the frontmatter comparison can detect this.
   */
  readonly corruptFrontmatter?: boolean | "frontmatter"
  /** Advertise an extra manifest entry outside the skill directory. */
  readonly escapeUri?: string
  /** Advertise more than the per-skill resource limit. */
  readonly overflowResources?: boolean
  /** Advertise a manifest whose total size exceeds the per-skill byte limit. */
  readonly overflowBytes?: boolean
  /** Advertise the same file URI twice, with distinct digests. */
  readonly duplicate?: boolean
  /** Advertise the manifest `"dynamic"` marker. */
  readonly dynamic?: boolean
  /** List only the first N skills while still serving `skills/get` for all of them. */
  readonly partial?: number
  /** Return a different skill URI from `skills/get` than the one requested. */
  readonly getUriOverride?: string
  /** Omit the REQUIRED `resultType`/`ttlMs`/`cacheScope` fields from listing results. */
  readonly omitResultFields?: boolean
  /** Children returned by `resources/directory/read`. */
  readonly directoryEntries?: ReadonlyArray<{ uri: string; name?: string; mimeType?: string }>
  /** Serve directory children from two pages. */
  readonly paginateDirectory?: boolean
  /** Return the standard non-cacheable directory result without list-cache fields. */
  readonly omitDirectoryCacheFields?: boolean
}

const hash = async (text: string) => {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  return { digest: `sha256:${hex}`, size: bytes.byteLength }
}

const root = (uri: string) => uri.replace(/\/SKILL\.md$/, "")

const frontmatterText = (frontmatter: Record<string, unknown>) =>
  ["---", ...Object.entries(frontmatter).map(([key, value]) => `${key}: ${JSON.stringify(value)}`), "---", ""].join(
    "\n",
  )

/**
 * A real HTTP MCP server implementing the Skills extension at base revision 2026-07-28, including the
 * REQUIRED `resultType`/`ttlMs`/`cacheScope` fields. Tests drive this over a real transport so capability
 * advertisement, custom methods, and pagination are verified executably rather than assumed.
 */
export function skillServer(input: SkillServerOptions = {}) {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const state = { listCalls: 0, getCalls: 0, readCalls: 0, directoryCalls: 0 }
      let current = [...(input.skills ?? [])]

      const manifest = async (skill: Skill) => {
        if (input.dynamic) return "dynamic" as const
        if (input.overflowResources) {
          return Array.from({ length: 513 }, (_, index) => ({
            uri: `${root(skill.uri)}/file-${index}.md`,
            digest: `sha256:${"a".repeat(64)}`,
            size: 1,
          }))
        }
        if (input.overflowBytes) {
          return [
            { uri: skill.uri, digest: `sha256:${"a".repeat(64)}`, size: 1 },
            { uri: `${root(skill.uri)}/big.md`, digest: `sha256:${"b".repeat(64)}`, size: 17 * 1024 * 1024 },
          ]
        }
        const entries = await Promise.all(
          skill.files.map(async (file) => ({ uri: `${root(skill.uri)}/${file.name}`, ...(await hash(file.text)) })),
        )
        if (input.escapeUri) entries.push({ uri: input.escapeUri, digest: `sha256:${"0".repeat(64)}`, size: 1 })
        if (input.duplicate) entries.push({ ...entries[0], digest: `sha256:${"c".repeat(64)}` })
        return entries
      }

      const entry = async (skill: Skill) => ({
        uri: skill.uri,
        frontmatter: input.corruptFrontmatter ? { ...skill.frontmatter, description: "tampered" } : skill.frontmatter,
        resources: await manifest(skill),
      })

      const createProtocol = () => {
        const protocol = new Server(
          { name: "mcp-skills", version: "1.0.0" },
          {
            capabilities: {
              ...(input.noResources ? {} : { resources: {} }),
              ...(input.undeclared
                ? {}
                : {
                    extensions: {
                      "io.modelcontextprotocol/skills": input.noDirectoryRead ? {} : { directoryRead: true },
                    },
                  }),
            },
          },
        )

        protocol.setRequestHandler(
          z.object({
            method: z.literal("skills/list"),
            params: z.object({ cursor: z.string().optional() }).optional(),
          }),
          async (request: { params?: { cursor?: string } }) => {
            state.listCalls += 1
            if (input.rawSkills)
              return { resultType: "complete" as const, skills: input.rawSkills, ttlMs: 300000, cacheScope: "public" }
            const all = await Promise.all(current.map(entry))
            const listed = input.partial === undefined ? all : all.slice(0, input.partial)
            if (input.omitResultFields) return { skills: listed }
            // Each page is a fresh object graph so callers cannot mutate a shared manifest.
            if (!input.paginate)
              return { resultType: "complete" as const, skills: listed, ttlMs: 300000, cacheScope: "public" }
            return request.params?.cursor === "page-2"
              ? { resultType: "complete" as const, skills: listed.slice(1), ttlMs: 300000, cacheScope: "public" }
              : {
                  resultType: "complete" as const,
                  skills: listed.slice(0, 1),
                  nextCursor: "page-2",
                  ttlMs: 300000,
                  cacheScope: "public",
                }
          },
        )

        protocol.setRequestHandler(
          z.object({ method: z.literal("skills/get"), params: z.object({ uri: z.string() }) }),
          async (request: { params: { uri: string } }) => {
            state.getCalls += 1
            const skill = current.find((candidate) => candidate.uri === request.params.uri)
            if (!skill) throw new McpError(ErrorCode.InvalidParams, "No skill is served at that URI")
            return {
              resultType: "complete" as const,
              skill: { ...(await entry(skill)), uri: input.getUriOverride ?? skill.uri },
              ttlMs: 300000,
              cacheScope: "public",
            }
          },
        )

        if (!input.noResources) {
          protocol.setRequestHandler(
            z.object({
              method: z.literal("resources/directory/read"),
              params: z.object({ uri: z.string(), cursor: z.string().optional() }),
            }),
            (request: { params: { uri: string; cursor?: string } }) => {
              state.directoryCalls += 1
              const resources = input.paginateDirectory
                ? request.params.cursor === "page-2"
                  ? (input.directoryEntries ?? []).slice(1)
                  : (input.directoryEntries ?? []).slice(0, 1)
                : (input.directoryEntries ?? [])
              const result = {
                resultType: "complete" as const,
                resources,
                ...(input.paginateDirectory && request.params.cursor === undefined ? { nextCursor: "page-2" } : {}),
              }
              return Promise.resolve(
                input.omitDirectoryCacheFields ? result : { ...result, ttlMs: 300000, cacheScope: "public" },
              )
            },
          )

          protocol.setRequestHandler(
            z.object({ method: z.literal("resources/read"), params: z.object({ uri: z.string() }) }),
            (request: { params: { uri: string } }) => {
              state.readCalls += 1
              const skill = current.find((candidate) => request.params.uri.startsWith(`${root(candidate.uri)}/`))
              const file = skill?.files.find(
                (candidate) => `${root(skill.uri)}/${candidate.name}` === request.params.uri,
              )
              if (!file) throw new McpError(ErrorCode.InvalidParams, "Unknown resource")
              const text =
                input.corrupt === "size"
                  ? `${file.text}\n`
                  : input.corrupt === "digest"
                    ? // Same byte length as the served file, so only the digest can detect the change.
                      file.text.replace("Git workflow", "Hit workflow")
                    : file.text
              const content =
                input.nonCanonicalBlob?.resource === file.name
                  ? { blob: `${Buffer.from(text, "utf8").toString("base64")}${input.nonCanonicalBlob.suffix}` }
                  : { text }
              return Promise.resolve({
                contents: [{ uri: request.params.uri, ...content, mimeType: file.mimeType ?? "text/markdown" }],
              })
            },
          )
        }
        return protocol
      }

      // A fresh protocol per session: the SDK binds one server instance to one transport, and tests
      // connect more than once against the same fixture.
      const sessions = new Map<string, { protocol: Server; transport: WebStandardStreamableHTTPServerTransport }>()
      const http = Bun.serve({
        port: 0,
        fetch: async (request) => {
          const sessionID = request.headers.get("mcp-session-id")
          const existing = sessionID === null ? undefined : sessions.get(sessionID)
          if (existing) return existing.transport.handleRequest(request)
          const protocol = createProtocol()
          const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            enableJsonResponse: true,
            onsessioninitialized: (id) => {
              sessions.set(id, { protocol, transport })
            },
          })
          await protocol.connect(transport)
          return transport.handleRequest(request)
        },
      })

      return {
        state,
        url: http.url.toString(),
        replaceSkills: (next: ReadonlyArray<Skill>) => {
          current = [...next]
        },
        close: async () => {
          await Promise.all([...sessions.values()].map((session) => session.protocol.close().catch(() => {})))
          await http.stop(true)
        },
      }
    }),
    (server) => Effect.promise(server.close),
  )
}

/** Builds the served `SKILL.md` body for a skill, matching its advertised frontmatter. */
export const skillBody = (frontmatter: Record<string, unknown>, body: string) =>
  `${frontmatterText(frontmatter)}${body}`

/**
 * Replacement set that runs the real `SkillV2` service against one fixture MCP server. The MCP,
 * filesystem, discovery, and event nodes are replaced so the projection is exercised without a full
 * Location graph.
 */
export const skillsMcpReplacements = (url: string) =>
  [
    [MCP.node, skillsMcpLayer(url)],
    [SkillDiscovery.node, Layer.mock(SkillDiscovery.Service, {})],
    [
      EventV2.node,
      Layer.mock(EventV2.Service, {
        subscribe: () => Stream.never,
        publish: (definition, data) =>
          Effect.succeed({
            id: EventV2.ID.create(),
            type: definition.type,
            data,
          } as EventV2.Payload<typeof definition>),
      }),
    ],
  ] satisfies LayerNode.Replacements

/**
 * Builds the real `SkillV2` service against one fixture MCP server. Skill discovery and the
 * filesystem are not exercised: only the MCP projection is.
 */
export const skillsNode = (url: string) => AppNodeBuilder.build(SkillV2.node, skillsMcpReplacements(url))

/**
 * MCP service layer connected to one fixture server, mirroring the resource-server layer in
 * `mcp.test.ts`. The server is registered under the fixed label `skills`, which is the host-assigned
 * identity the extension requires alongside each skill URI.
 */
export const skillsMcpLayer = (url: string) => {
  const directory = AbsolutePath.make(import.meta.dir)
  const unused = () => Effect.die("unused integration service")
  return MCP.layer.pipe(
    Layer.provideMerge(Form.layer),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          Config.Service,
          Config.Service.of({
            entries: () =>
              Effect.succeed([
                new Config.Document({
                  type: "document",
                  info: new Config.Info({
                    mcp: new ConfigMCP.Info({
                      servers: { skills: new ConfigMCP.Remote({ type: "remote", url, oauth: false }) },
                    }),
                  }),
                }),
              ]),
          }),
        ),
        Layer.succeed(Location.Service, Location.Service.of(location({ directory }))),
        Layer.mock(SessionAutonomy.Service, { get: () => Effect.succeed(SessionAutonomy.defaultState) }),
        Layer.mock(EventV2.Service, {
          subscribe: () => Stream.never,
          publish: (definition, data) =>
            Effect.succeed({
              id: EventV2.ID.create(),
              type: definition.type,
              data,
            } as EventV2.Payload<typeof definition>),
        }),
        Layer.mock(Integration.Service, {
          connection: {
            active: unused,
            resolve: unused,
            key: unused,
            update: unused,
            activate: unused,
            remove: unused,
          },
          oauth: { connect: unused, status: unused, complete: unused, cancel: unused },
          command: { connect: unused, status: unused, cancel: unused },
        }),
        Layer.mock(Credential.Service, {}),
      ),
    ),
  )
}
