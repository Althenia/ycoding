import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { publish, type Manifest } from "./release-publish"

type Asset = { id: number; name: string; state: "uploaded" | "starter"; content: Uint8Array; digest?: string | null }
type Fault = "reject" | "applied-reject" | "starter" | "corrupt"
type Call = { method: string; path: string; name?: string }

const repository = "example/ycoding"
const tag = "v0.11.0"
const releaseID = 42
const otherID = 41
const temporary: string[] = []
const servers: Array<{ stop: (force: boolean) => unknown }> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)))
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const sha256 = (content: Uint8Array) => createHash("sha256").update(content).digest("hex")
const bytes = (text: string) => new TextEncoder().encode(text)
const byText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)

function github(
  options: {
    readonly assets: ReadonlyArray<{ name: string; content: string }>
    readonly fault?: (call: Call) => Fault | undefined
    readonly digests?: "present" | "null"
    readonly latest?: () => number
  } = { assets: [] },
) {
  let nextID = 1000
  const calls: Call[] = []
  const release = {
    id: releaseID,
    tag_name: tag,
    name: "YCoding 0.11.0",
    body: "old notes",
    draft: false,
    prerelease: false,
  }
  const assets = new Map<number, Asset>(
    options.assets.map((asset, index) => [
      index + 1,
      { id: index + 1, name: asset.name, state: "uploaded", content: bytes(asset.content) },
    ]),
  )
  let latest = releaseID
  const view = (asset: Asset) => ({
    id: asset.id,
    name: asset.name,
    state: asset.state,
    size: asset.content.byteLength,
    digest: options.digests === "null" ? null : `sha256:${sha256(asset.content)}`,
    browser_download_url: `https://example.invalid/${asset.name}`,
  })
  const releaseView = () => ({ ...release, assets: [...assets.values()].map(view) })
  const named = (name: string) => [...assets.values()].find((asset) => asset.name === name)
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const route = url.pathname.replace(`/repos/${repository}`, "")
      const parsed: unknown = request.method === "PATCH" ? await request.json() : undefined
      const body = new Map<string, unknown>(typeof parsed === "object" && parsed !== null ? Object.entries(parsed) : [])
      const call: Call = {
        method: request.method,
        path: route,
        name:
          url.searchParams.get("name") ??
          ((value) => (typeof value === "string" ? value : undefined))(body.get("name")),
      }
      calls.push(call)
      const fault = options.fault?.(call)
      if (fault === "reject") return new Response("injected failure", { status: 500 })
      if (request.method === "GET" && route === `/releases/tags/${tag}`) return Response.json(releaseView())
      if (request.method === "GET" && route === "/releases/latest")
        return Response.json({ ...releaseView(), id: options.latest?.() ?? latest })
      if (request.method === "GET" && route === `/releases/${releaseID}/assets`)
        return Response.json(
          url.searchParams.get("page") === "1" || !url.searchParams.get("page") ? [...assets.values()].map(view) : [],
        )
      const assetRoute = /^\/releases\/assets\/(\d+)$/.exec(route)
      if (assetRoute) {
        const asset = assets.get(Number(assetRoute[1]))
        if (!asset) return new Response("missing", { status: 404 })
        if (request.method === "GET")
          return request.headers.get("accept") === "application/octet-stream"
            ? new Response(asset.content)
            : Response.json(view(asset))
        if (request.method === "DELETE") {
          assets.delete(asset.id)
          return fault === "applied-reject"
            ? new Response("lost", { status: 502 })
            : new Response(null, { status: 204 })
        }
        if (request.method === "PATCH") {
          const name = String(body.get("name"))
          if (named(name) && named(name)!.id !== asset.id) return new Response("exists", { status: 422 })
          asset.name = name
          if (fault === "corrupt") asset.content = bytes("tampered")
          return fault === "applied-reject" ? new Response("lost", { status: 502 }) : Response.json(view(asset))
        }
      }
      if (request.method === "POST" && route === `/releases/${releaseID}/assets`) {
        const name = url.searchParams.get("name")!
        if (named(name)) return new Response("exists", { status: 422 })
        const content = new Uint8Array(await request.arrayBuffer())
        const stored: Asset = {
          id: nextID++,
          name,
          state: fault === "starter" ? "starter" : "uploaded",
          content: fault === "corrupt" ? bytes("tampered") : content,
        }
        assets.set(stored.id, stored)
        if (fault === "applied-reject" || fault === "starter") return new Response("upstream failure", { status: 502 })
        return Response.json(view(stored), { status: 201 })
      }
      if (request.method === "PATCH" && route === `/releases/${releaseID}`) {
        Object.assign(release, {
          ...(body.get("name") === undefined ? {} : { name: body.get("name") }),
          ...(body.get("body") === undefined ? {} : { body: body.get("body") }),
          ...(body.get("draft") === undefined ? {} : { draft: body.get("draft") }),
          ...(body.get("prerelease") === undefined ? {} : { prerelease: body.get("prerelease") }),
        })
        if (body.get("make_latest") === "true") latest = releaseID
        return fault === "applied-reject" ? new Response("lost", { status: 502 }) : Response.json(releaseView())
      }
      if (request.method === "PATCH" && route === `/releases/${otherID}`) {
        if (body.get("make_latest") === "true") latest = otherID
        return Response.json({ id: otherID })
      }
      return new Response("unhandled", { status: 404 })
    },
  })
  servers.push(server)
  const base = `http://127.0.0.1:${server.port}`
  return {
    calls,
    release,
    assets,
    names: () => Object.fromEntries([...assets.values()].map((asset) => [asset.name, asset.id])),
    mutations: () => calls.filter((call) => call.method !== "GET"),
    base,
  }
}

const original = [
  { name: "ycoding-0.11.0-darwin-arm64.tar.gz", content: "old darwin" },
  { name: "ycoding-0.11.0-checksums.txt", content: "old sums" },
  { name: "LICENSE", content: "license" },
]

async function files(entries: ReadonlyArray<{ name: string; content: string }>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-release-publish-"))
  temporary.push(root)
  await Promise.all(entries.map((entry) => writeFile(path.join(root, entry.name), entry.content)))
  return { root, paths: entries.map((entry) => path.join(root, entry.name)) }
}

const replacement = [
  { name: "ycoding-0.11.0-darwin-arm64.tar.gz", content: "new darwin" },
  { name: "ycoding-0.11.0-checksums.txt", content: "new sums" },
  { name: "LICENSE", content: "license 2" },
]

async function run(server: ReturnType<typeof github>, entries = replacement) {
  const local = await files(entries)
  const manifestPath = path.join(local.root, "manifest.json")
  const result = await publish({
    apiURL: server.base,
    uploadURL: server.base,
    token: "test-token",
    repository,
    tag,
    title: "YCoding 0.11.0",
    notes: "new notes",
    run: "77-1",
    files: local.paths,
    manifest: manifestPath,
  })
  const manifest: Manifest = await Bun.file(manifestPath).json()
  return { result, manifest }
}

const originalIDs: Record<string, number> = {
  "ycoding-0.11.0-darwin-arm64.tar.gz": 1,
  "ycoding-0.11.0-checksums.txt": 2,
  LICENSE: 3,
}

function expectOriginalPublicNames(server: ReturnType<typeof github>) {
  const names = server.names()
  for (const [name, id] of Object.entries(originalIDs)) expect(names[name]).toBe(id)
}

test("a failed staged upload leaves public names unchanged and removes the staged assets", async () => {
  const server = github({
    assets: original,
    fault: (call) => (call.method === "POST" && call.name?.endsWith("checksums.txt") ? "reject" : undefined),
  })
  const { result, manifest } = await run(server)
  expect(result.status).toBe("restored")
  expectOriginalPublicNames(server)
  expect(Object.keys(server.names()).filter((name) => name.startsWith("staged-"))).toEqual([])
  expect(server.mutations().some((call) => call.method === "PATCH")).toBe(false)
  expect(manifest.status).toBe("restored")
})

test("a staged digest mismatch blocks every rename", async () => {
  const server = github({
    assets: original,
    fault: (call) => (call.method === "POST" && call.name?.endsWith("darwin-arm64.tar.gz") ? "corrupt" : undefined),
  })
  const { result } = await run(server)
  expect(result.status).toBe("restored")
  expectOriginalPublicNames(server)
  expect(server.mutations().some((call) => call.method === "PATCH")).toBe(false)
})

test("without a reported digest the staged bytes are downloaded and a mismatch blocks every rename", async () => {
  const server = github({
    assets: original,
    digests: "null",
    fault: (call) => (call.method === "POST" && call.name?.endsWith("LICENSE") ? "corrupt" : undefined),
  })
  const { result } = await run(server)
  expect(result.status).toBe("restored")
  expectOriginalPublicNames(server)
  expect(server.calls.some((call) => call.method === "GET" && /^\/releases\/assets\/\d+$/.test(call.path))).toBe(true)
  expect(server.mutations().some((call) => call.method === "PATCH")).toBe(false)
})

test("a verified swap points every public name at a new asset, renames the checksums last and retains prior assets", async () => {
  const server = github({ assets: original, digests: "null" })
  const { result, manifest } = await run(server)
  expect(result.status).toBe("published")
  const names = server.names()
  for (const entry of replacement) {
    const asset = server.assets.get(names[entry.name]!)!
    expect(new TextDecoder().decode(asset.content)).toBe(entry.content)
    expect(names[`prior-77-1-${entry.name}`]).toBe(originalIDs[entry.name])
  }
  const publicRenames = server.calls.filter(
    (call) => call.method === "PATCH" && call.path.startsWith("/releases/assets/") && !call.name?.startsWith("prior-"),
  )
  expect(publicRenames.at(-1)?.name).toBe("ycoding-0.11.0-checksums.txt")
  expect(server.release).toMatchObject({ name: "YCoding 0.11.0", body: "new notes", draft: false, prerelease: false })
  expect(manifest.status).toBe("published")
  expect(manifest.final.map((asset) => asset.name).toSorted(byText)).toEqual(
    [...replacement.map((entry) => entry.name), ...replacement.map((entry) => `prior-77-1-${entry.name}`)].toSorted(
      byText,
    ),
  )
  expect(manifest.original.map((asset) => asset.id).toSorted((left, right) => left - right)).toEqual([1, 2, 3])
})

test("a rename failure restores every public name to its original asset", async () => {
  const server = github({
    assets: original,
    fault: (call) =>
      call.method === "PATCH" && call.name === "LICENSE" && Number(call.path.split("/").at(-1)) >= 1000
        ? "reject"
        : undefined,
  })
  const { result, manifest } = await run(server)
  expect(result.status).toBe("restored")
  expectOriginalPublicNames(server)
  expect(Object.keys(server.names()).some((name) => name.startsWith("prior-"))).toBe(false)
  expect(manifest.status).toBe("restored")
})

test("an upload whose response is lost is reconciled from the release instead of being uploaded again", async () => {
  const server = github({
    assets: original,
    fault: (call) => (call.method === "POST" && call.name?.endsWith("LICENSE") ? "applied-reject" : undefined),
  })
  const { result } = await run(server)
  expect(result.status).toBe("published")
  expect(server.calls.filter((call) => call.method === "POST" && call.name?.endsWith("LICENSE"))).toHaveLength(1)
})

test("an upload left incomplete by the service is not replayed and blocks every rename", async () => {
  const server = github({
    assets: original,
    fault: (call) => (call.method === "POST" && call.name?.endsWith("LICENSE") ? "starter" : undefined),
  })
  const { result, manifest } = await run(server)
  expect(result.status).toBe("restored")
  expectOriginalPublicNames(server)
  expect(server.calls.filter((call) => call.method === "POST" && call.name?.endsWith("LICENSE"))).toHaveLength(1)
  expect(server.mutations().some((call) => call.method === "PATCH")).toBe(false)
  expect(manifest.error).toContain("LICENSE")
})

test("a rename whose response is lost is reconciled from the asset instead of being sent again", async () => {
  const server = github({
    assets: original,
    fault: (call) => (call.method === "PATCH" && call.name === "LICENSE" ? "applied-reject" : undefined),
  })
  const { result } = await run(server)
  expect(result.status).toBe("published")
  expect(server.calls.filter((call) => call.method === "PATCH" && call.name === "LICENSE")).toHaveLength(1)
})

test("a failed restoration is reported unrestored with the exact public names left in place", async () => {
  const server = github({
    assets: original,
    fault: (call) =>
      call.method === "PATCH" &&
      (call.name === "LICENSE" || call.name === "ycoding-0.11.0-darwin-arm64.tar.gz") &&
      server.calls.filter((entry) => entry.method === "PATCH" && entry.name === "LICENSE").length > 0
        ? "reject"
        : undefined,
  })
  const { result, manifest } = await run(server)
  expect(result.status).toBe("unrestored")
  expect(manifest.status).toBe("unrestored")
  expect(manifest.final.length).toBeGreaterThan(0)
  for (const asset of manifest.final) expect(server.names()[asset.name]).toBe(asset.id)
  expect(manifest.error).toBeDefined()
})

test("a failed metadata update restores the original public names", async () => {
  const server = github({
    assets: original,
    fault: (call) =>
      call.method === "PATCH" && call.path === `/releases/${releaseID}` && call.name === "YCoding 0.11.0"
        ? "reject"
        : undefined,
  })
  const { result } = await run(server)
  expect(result.status).toBe("restored")
  expectOriginalPublicNames(server)
  expect(server.release.body).toBe("old notes")
})

test("a final verification failure restores the original assets and metadata", async () => {
  const server = github({ assets: original, latest: () => otherID })
  const { result, manifest } = await run(server)
  expect(result.status).toBe("restored")
  expectOriginalPublicNames(server)
  expect(server.release).toMatchObject({ name: "YCoding 0.11.0", body: "old notes" })
  expect(manifest.error).toContain("latest")
})

test("a public asset that no longer matches its verified digest after the swap restores the original assets", async () => {
  const server = github({
    assets: original,
    fault: (call) =>
      call.method === "PATCH" && call.name === "LICENSE" && Number(call.path.split("/").at(-1)) >= 1000
        ? "corrupt"
        : undefined,
  })
  const { result, manifest } = await run(server)
  expect(result.status).toBe("restored")
  expectOriginalPublicNames(server)
  expect(server.release).toMatchObject({ name: "YCoding 0.11.0", body: "old notes" })
  expect(manifest.error).toContain("LICENSE")
})

test("leftover staged or prior assets from an earlier run stop publication before any change", async () => {
  const server = github({ assets: [...original, { name: "staged-76-1-LICENSE", content: "earlier" }] })
  const { result, manifest } = await run(server)
  expect(result.status).toBe("refused")
  expect(server.mutations()).toEqual([])
  expect(manifest.error).toContain("staged-76-1-LICENSE")
})
