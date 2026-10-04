import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLocalServer, LocalFailure } from "../src/remote-local"
import { password, startServer } from "../test/remote-harness"

test("catalog reads succeed concurrently at a previously opened Location without a Session", async () => {
  const home = await mkdtemp(join(tmpdir(), "ycoding-remote-catalog-"))
  const config = join(home, "server-config")
  const workspace = join(home, "workspace")
  const openedOnly = join(home, "opened-only")
  const priorConfig = process.env.YCODING_CONFIG_DIR
  let server: Awaited<ReturnType<typeof startServer>> | undefined
  const provider = Bun.serve({ port: 0, fetch: () => new Response("not found", { status: 404 }) })
  try {
    await Promise.all([mkdir(config), mkdir(workspace), mkdir(openedOnly)])
    await writeFile(
      join(config, "ycoding.json"),
      JSON.stringify({
        model: "flow-local/flow-model",
        default_agent: "flow-approval",
        agents: {
          "flow-approval": {
            description: "Approval agent",
            mode: "primary",
            permissions: [{ action: "shell", resource: "*", effect: "ask" }],
          },
          "flow-guard": {
            description: "Guardrail agent",
            mode: "primary",
            permissions: [{ action: "shell", resource: "*", effect: "allow" }],
          },
          "flow-child": { description: "Managed child", mode: "subagent" },
        },
        providers: {
          "flow-local": {
            package: "aisdk:@ai-sdk/openai-compatible",
            name: "Flow Local Stand-in",
            settings: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "flow-stand-in-key" },
            models: { "flow-model": { name: "Flow Model" } },
          },
        },
      }),
    )
    process.env.YCODING_CONFIG_DIR = config
    const started = await startServer(config)
    server = started
    const created = await started.request("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "ses_catalog_existing",
        location: { directory: workspace },
        model: { providerID: "flow-local", id: "flow-model" },
      }),
    })
    expect(created.status).toBe(200)
    const opened = await started.request("/api/location", {
      headers: { "x-ycoding-directory": encodeURIComponent(openedOnly) },
    })
    expect(opened.status).toBe(200)

    const local = createLocalServer({ url: started.base, auth: { type: "basic", username: "ycoding", password } })
    const location = { directory: openedOnly }
    const reads = [
      ["agent.list", "/api/agent", () => local.agentList(location)],
      ["model.list", "/api/model", () => local.modelList(location)],
      ["model.default", "/api/model/default", () => local.modelDefault(location)],
      ["provider.list", "/api/provider", () => local.providerList(location)],
      ["command.list", "/api/command", () => local.commandList(location)],
      ["skill.list", "/api/skill", () => local.skillList(location)],
      ["reference.list", "/api/reference", () => local.referenceList(location)],
      ["mcp.resource.catalog", "/api/mcp/resource", () => local.resourceCatalog(location)],
    ] as const
    const settled = await Promise.allSettled(reads.map(([, , read]) => read()))
    const failures = await Promise.all(
      settled
        .flatMap((result, index) => (result.status === "fulfilled" ? [] : [index]))
        .map(async (index) => {
          const result = settled[index]
          if (result?.status !== "rejected") throw new Error("Catalog result was not a rejection")
          const response = await started.request(reads[index][1], {
            headers: { "x-ycoding-directory": encodeURIComponent(openedOnly) },
          })
          const body: unknown = await response.json().catch(() => undefined)
          const tag = typeof body === "object" && body !== null ? Reflect.get(body, "_tag") : undefined
          return {
            endpoint: reads[index][0],
            kind: result.reason instanceof LocalFailure ? result.reason.kind : "other",
            httpStatus: response.status,
            serverClass: typeof tag === "string" && /^[A-Za-z][A-Za-z0-9]{0,79}Error$/.test(tag) ? tag : "unreported",
          }
        }),
    )
    expect(failures).toEqual([])
  } finally {
    await server?.close()
    await provider.stop(true)
    if (priorConfig === undefined) delete process.env.YCODING_CONFIG_DIR
    else process.env.YCODING_CONFIG_DIR = priorConfig
    await rm(home, { recursive: true, force: true })
  }
}, 30_000)
