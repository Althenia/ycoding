export * as RemoteMcpDemo from "./remote-mcp-demo"

import { createHash, randomUUID } from "node:crypto"
import { RemoteMCPTransport } from "@ycoding-ai/core/remote-mcp/transport"
import previewHTML from "../script/mcp-artifact-demo/index.html" with { type: "text" }

export const demoPNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGNIv77k/6fPX/8zgAgQBwB3aA11ihy37gAAAABJRU5ErkJggg==",
  "base64",
)
export const previewURI = "ui://ycoding/artifact-demo/v1.html"

const previewMime = "text/html;profile=mcp-app"
const emptyInput = { type: "object" as const, additionalProperties: false }

export type Operation = "artifact.demo.preview" | "artifact.demo.export"

export class ExpiredError extends Error {
  constructor() {
    super("Resource unavailable")
    this.name = "ExpiredError"
  }
}

export const tools: readonly RemoteMCPTransport.Tool[] = [
  {
    name: "artifact_demo_preview",
    description:
      "Test this client's MCP Apps support with two switchable variants and an optional isolated-frame probe. This is a fixed feasibility fixture, not generated HTML execution.",
    inputSchema: emptyInput,
    outputSchema: {
      type: "object",
      properties: {
        variants: { type: "array", items: { type: "string" } },
        hostVerification: { const: "required" },
      },
      required: ["variants", "hostVerification"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: { ui: { resourceUri: previewURI } },
  },
  {
    name: "artifact_demo_export",
    description:
      "Export a fixed PNG as an original-byte resource link with integrity metadata. The chat host must fetch it and create its native attachment; an image-inspection response is not a downloadable attachment.",
    inputSchema: emptyInput,
    outputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        filename: { type: "string" },
        mime: { const: "image/png" },
        size: { type: "integer" },
        sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        expiresAt: { type: "integer" },
        delivery: { const: "host-native-attachment-required" },
      },
      required: ["id", "filename", "mime", "size", "sha256", "expiresAt", "delivery"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  },
]

export function create(now = Date.now) {
  const id = `art_${randomUUID().replaceAll("-", "")}`
  const pngURI = `artifact://ycoding-demo/${id}`
  const metadata = {
    id,
    filename: "ycoding-demo.png",
    mime: "image/png",
    size: demoPNG.length,
    sha256: createHash("sha256").update(demoPNG).digest("hex"),
    expiresAt: now() + 15 * 60 * 1000,
    delivery: "host-native-attachment-required",
  }
  const png = { uri: pngURI, name: metadata.filename, mimeType: metadata.mime, size: metadata.size }
  const available = () => now() < metadata.expiresAt
  const requireAvailable = () => {
    if (!available()) throw new ExpiredError()
  }

  return {
    data(operation: Operation) {
      if (operation === "artifact.demo.preview") return { variants: ["list", "cards"], hostVerification: "required" }
      requireAvailable()
      return metadata
    },
    content(operation: Operation) {
      if (operation === "artifact.demo.preview")
        return [
          {
            type: "text" as const,
            text: "Two-variant client demo. Confirm switching variants and the isolated-frame probe in the actual chat.",
          },
        ]
      return [{ type: "resource_link" as const, ...png }]
    },
    list() {
      return [{ uri: previewURI, name: "Artifact client demo", mimeType: previewMime }, ...(available() ? [png] : [])]
    },
    read(uri: string) {
      if (uri === previewURI)
        return {
          contents: [
            {
              uri: previewURI,
              mimeType: previewMime,
              text: String(previewHTML),
              _meta: {
                ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [], frameDomains: [] } },
              },
            },
          ],
        }
      if (uri !== pngURI || !available()) return undefined
      return { contents: [{ uri: pngURI, mimeType: metadata.mime, blob: demoPNG.toString("base64") }] }
    },
  }
}
