import { createHash } from "node:crypto"
import path from "node:path"
import { releaseArchives } from "./release-archive"

export type PublishInput = {
  readonly apiURL: string
  readonly uploadURL: string
  readonly token: string
  readonly repository: string
  readonly tag: string
  readonly title: string
  readonly notes: string
  readonly run: string
  readonly files: ReadonlyArray<string>
  readonly manifest: string
}

type RemoteAsset = { id: number; name: string; state: string; size: number; digest: string | null }
type RemoteRelease = { id: number; name: string | null; body: string | null; draft: boolean; prerelease: boolean }
type Rename = { id: number; from: string; to: string }
type LocalAsset = { name: string; content: Uint8Array; sha256: string; size: number }
type OriginalAsset = RemoteAsset & { sha256: string }

export type Manifest = {
  repository: string
  tag: string
  run: string
  status: "running" | "published" | "restored" | "unrestored" | "refused"
  release?: {
    id: number
    name: string | null
    body: string | null
    draft: boolean
    prerelease: boolean
    latestID?: number
  }
  original: Array<{ id: number; name: string; size: number; digest: string | null }>
  staged: Array<{ name: string; staged: string; sha256: string; size: number; id?: number }>
  renames: Rename[]
  final: Array<{ id: number; name: string; size: number; digest: string | null }>
  error?: string
}

export async function publish(input: PublishInput) {
  const manifest: Manifest = {
    repository: input.repository,
    tag: input.tag,
    run: input.run,
    status: "running",
    original: [],
    staged: [],
    renames: [],
    final: [],
  }
  const save = () => Bun.write(input.manifest, `${JSON.stringify(manifest, null, 2)}\n`)
  const github = client(input)
  const local = await Promise.all(
    input.files.map(async (file) => {
      const content = new Uint8Array(await Bun.file(file).arrayBuffer())
      return { name: path.basename(file), content, sha256: sha256(content), size: content.byteLength }
    }),
  )
  const release = await github.release()
  const latest = await github.latestID()
  manifest.release = {
    id: release.id,
    name: release.name,
    body: release.body,
    draft: release.draft,
    prerelease: release.prerelease,
    latestID: latest,
  }
  const before = await github.assets(release.id)
  manifest.original = before.map(describe)
  let originals: OriginalAsset[]
  try {
    originals = await preflight(github, input, release, before, local)
  } catch (error) {
    manifest.status = "refused"
    manifest.error = error instanceof Error ? error.message : String(error)
    manifest.final = manifest.original
    await save()
    return { status: manifest.status, manifest }
  }
  manifest.staged = local.map((file) => ({
    name: file.name,
    staged: `staged-${input.run}-${file.name}`,
    sha256: file.sha256,
    size: file.size,
  }))
  await save()

  const failure = await stage(github, release.id, local, manifest, save)
    .then(() => swap(github, originals, manifest, save))
    .then(() => metadata(github, release.id, input))
    .then(() => verify(github, release.id, input, originals, manifest))
    .then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
  if (failure === undefined) {
    manifest.status = "published"
    manifest.final = (await github.assets(release.id)).map(describe)
    await save()
    return { status: manifest.status, manifest }
  }
  manifest.error = failure
  await save()
  const restored = await restore(github, release, originals, manifest).then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )
  manifest.final = (await github.assets(release.id).catch(() => [])).map(describe)
  manifest.status = restored === undefined ? "restored" : "unrestored"
  if (restored !== undefined) manifest.error = `${failure}; restoration failed: ${restored}`
  await save()
  return { status: manifest.status, manifest }
}

async function preflight(
  github: ReturnType<typeof client>,
  input: PublishInput,
  release: RemoteRelease,
  before: ReadonlyArray<RemoteAsset>,
  local: ReadonlyArray<LocalAsset>,
) {
  if (!/^[1-9]\d*-[1-9]\d*$/.test(input.run)) throw new Error("Publication run must include a numeric run ID and attempt")
  const names = before.map((asset) => asset.name)
  if (new Set(names).size !== names.length || new Set(before.map((asset) => asset.id)).size !== before.length)
    throw new Error("Release has duplicate asset identities")
  const staged = names.filter((name) => name.startsWith("staged-"))
  if (staged.length) throw new Error(`Release has residual staged assets: ${staged.join(", ")}`)
  const historical = before.filter((asset) => asset.name.startsWith("prior-"))
  if (historical.length) {
    const version = input.tag.slice(1)
    const covered = [...releaseArchives(version), "LICENSE", "NOTICE"]
    const checksumName = `ycoding-${version}-checksums.txt`
    const canonical = [...covered, `${input.tag}.md`, checksumName].sort()
    const complete = (files: readonly { name: string }[]) =>
      JSON.stringify(files.map((file) => file.name).sort()) === JSON.stringify(canonical)
    const current = before.filter((asset) => !asset.name.startsWith("prior-"))
    if (release.draft || release.prerelease || !complete(current) || !complete(local))
      throw new Error("Retained backups require a complete public release and a complete successor")
    validateChecksums(local.find((file) => file.name === checksumName)!.content, local, covered, "successor")
    const groups = new Map<string, RemoteAsset[]>()
    for (const asset of historical) {
      const match = /^prior-([1-9]\d*-[1-9]\d*)-(.+)$/.exec(asset.name)
      if (!match || match[1] === input.run) throw new Error(`Ambiguous retained asset: ${asset.name}`)
      const group = groups.get(match[1]!) ?? []
      group.push({ ...asset, name: match[2]! })
      groups.set(match[1]!, group)
    }
    for (const [run, group] of groups)
      if (!complete(group)) throw new Error(`Retained asset set ${run} is incomplete`)
    return (await Promise.all([["current", current] as const, ...groups].map(async ([label, group]) => {
      const snapshots = await snapshotAssets(github, group)
      const checksum = snapshots.find((asset) => asset.name === checksumName)!
      const content = await github.download(checksum.id)
      if (content.byteLength !== checksum.size || sha256(content) !== checksum.sha256)
        throw new Error(`Checksum asset for ${label} does not match its recorded digest and size`)
      validateChecksums(content, snapshots, covered, label)
      return snapshots.map((asset) => label === "current" ? asset : { ...asset, name: `prior-${label}-${asset.name}` })
    }))).flat()
  }
  return snapshotAssets(github, before)
}

async function snapshotAssets(github: ReturnType<typeof client>, assets: ReadonlyArray<RemoteAsset>) {
  return Promise.all(assets.map(async (asset) => {
    if (asset.state !== "uploaded" || asset.size <= 0) throw new Error(`Release asset is not fully uploaded: ${asset.name}`)
    return { ...asset, sha256: await remoteSha256(github, asset) }
  }))
}

function validateChecksums(content: Uint8Array, assets: readonly { name: string; sha256: string }[], covered: readonly string[], label: string) {
  const lines = new TextDecoder().decode(content).replace(/\r?\n$/, "").split(/\r?\n/).sort()
  const expected = covered.map((name) => `${assets.find((asset) => asset.name === name)!.sha256}  ${name}`).sort()
  if (JSON.stringify(lines) !== JSON.stringify(expected)) throw new Error(`Checksum set for ${label} does not match its assets`)
}

async function remoteSha256(github: ReturnType<typeof client>, asset: RemoteAsset) {
  if (asset.digest !== null) {
    if (!/^sha256:[0-9a-f]{64}$/.test(asset.digest)) throw new Error(`Invalid digest for ${asset.name}`)
    return asset.digest.slice(7)
  }
  const content = await github.download(asset.id)
  if (content.byteLength !== asset.size) throw new Error(`Downloaded ${asset.name} does not match its recorded size`)
  return sha256(content)
}

async function verifyOriginals(
  github: ReturnType<typeof client>,
  assets: ReadonlyArray<RemoteAsset>,
  before: ReadonlyArray<OriginalAsset>,
  nameFor: (asset: OriginalAsset) => string,
) {
  for (const original of before) {
    const name = nameFor(original)
    const asset = assets.find((candidate) => candidate.name === name)
    if (!asset || asset.id !== original.id || asset.size !== original.size || asset.state !== original.state ||
      await remoteSha256(github, asset) !== original.sha256) throw new Error(`Asset ${name} does not match original asset ${original.id}`)
  }
}

async function stage(
  github: ReturnType<typeof client>,
  releaseID: number,
  local: ReadonlyArray<LocalAsset>,
  manifest: Manifest,
  save: () => Promise<number>,
) {
  for (const file of local) {
    const entry = manifest.staged.find((staged) => staged.name === file.name)!
    const uploaded = await github.upload(releaseID, entry.staged, file.content)
    const asset = uploaded ?? (await github.assets(releaseID)).find((candidate) => candidate.name === entry.staged)
    if (!asset) throw new Error(`Upload of ${file.name} did not create ${entry.staged}`)
    entry.id = asset.id
    await save()
    if (asset.state !== "uploaded")
      throw new Error(`Upload of ${file.name} left ${entry.staged} in state ${asset.state}`)
  }
  const current = await github.assets(releaseID)
  for (const entry of manifest.staged) {
    const asset = current.find((candidate) => candidate.id === entry.id)
    if (!asset || asset.name !== entry.staged || asset.state !== "uploaded" || asset.size !== entry.size)
      throw new Error(`Staged ${entry.name} does not match the prepared file`)
    const remote = await remoteSha256(github, asset)
    if (remote !== entry.sha256)
      throw new Error(`Staged ${entry.name} has digest sha256:${remote}, expected sha256:${entry.sha256}`)
  }
}

async function swap(
  github: ReturnType<typeof client>,
  before: ReadonlyArray<RemoteAsset>,
  manifest: Manifest,
  save: () => Promise<number>,
) {
  const order = manifest.staged.toSorted(
    (left, right) => Number(left.name.endsWith("-checksums.txt")) - Number(right.name.endsWith("-checksums.txt")),
  )
  for (const entry of order) {
    const prior = before.find((asset) => asset.name === entry.name)
    if (prior) {
      const rename = { id: prior.id, from: entry.name, to: `prior-${manifest.run}-${entry.name}` }
      await github.rename(rename)
      manifest.renames.push(rename)
      await save()
    }
    const rename = { id: entry.id!, from: entry.staged, to: entry.name }
    await github.rename(rename)
    manifest.renames.push(rename)
    await save()
  }
}

async function metadata(github: ReturnType<typeof client>, releaseID: number, input: PublishInput) {
  await github
    .edit(releaseID, { name: input.title, body: input.notes, draft: false, prerelease: false, make_latest: "true" })
    .catch(async (error: unknown) => {
      const current = await github.release()
      if (current.name === input.title && current.body === input.notes && !current.draft && !current.prerelease) return
      throw error
    })
}

async function verify(
  github: ReturnType<typeof client>, releaseID: number, input: PublishInput,
  before: ReadonlyArray<OriginalAsset>, manifest: Manifest,
) {
  const release = await github.release()
  if (release.name !== input.title || release.body !== input.notes || release.draft || release.prerelease)
    throw new Error("Release metadata does not match the published title and notes")
  const assets = await github.assets(releaseID)
  for (const entry of manifest.staged) {
    const asset = assets.find((candidate) => candidate.name === entry.name)
    if (!asset || asset.id !== entry.id || asset.state !== "uploaded" || asset.size !== entry.size)
      throw new Error(`Public ${entry.name} does not point at the verified staged asset`)
    if (await remoteSha256(github, asset) !== entry.sha256)
      throw new Error(`Public ${entry.name} digest changed after the swap`)
  }
  await verifyOriginals(github, assets, before, (asset) => manifest.renames.find((rename) => rename.id === asset.id)?.to ?? asset.name)
  if (assets.length !== before.length + manifest.staged.length) throw new Error("Release has unexpected assets after publication")
  if ((await github.latestID()) !== releaseID) throw new Error("Release is not the latest release after publication")
}

async function restore(
  github: ReturnType<typeof client>,
  release: RemoteRelease,
  before: ReadonlyArray<OriginalAsset>,
  manifest: Manifest,
) {
  for (const rename of manifest.renames.toReversed())
    await github.rename({ id: rename.id, from: rename.to, to: rename.from })
  const current = await github.release()
  if (
    current.name !== release.name ||
    current.body !== release.body ||
    current.draft !== release.draft ||
    current.prerelease !== release.prerelease
  )
    await github.edit(release.id, {
      name: release.name ?? "",
      body: release.body ?? "",
      draft: release.draft,
      prerelease: release.prerelease,
    })
  const latest = manifest.release?.latestID
  if (latest !== undefined && (await github.latestID()) !== latest) await github.edit(latest, { make_latest: "true" })
  for (const entry of manifest.staged.filter((staged) => staged.id !== undefined)) await github.remove(entry.id!)
  const assets = await github.assets(release.id)
  await verifyOriginals(github, assets, before, (asset) => asset.name)
  if (assets.length !== before.length) throw new Error("Release has unexpected assets after restoration")
  const after = await github.release()
  if (after.name !== release.name || after.body !== release.body || after.draft !== release.draft || after.prerelease !== release.prerelease ||
    latest !== undefined && (await github.latestID()) !== latest) throw new Error("Release metadata was not restored")
}

function client(input: PublishInput) {
  const api = (route: string) => `${input.apiURL}/repos/${input.repository}${route}`
  const request = (url: string, init: { method?: string; body?: BodyInit; headers?: Record<string, string> } = {}) =>
    fetch(url, {
      method: init.method,
      body: init.body,
      headers: {
        authorization: `Bearer ${input.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...init.headers,
      },
    }).catch(() => undefined)
  const read = async (url: string): Promise<unknown> => {
    const response = await request(url)
    if (!response?.ok) throw new Error(`GET ${url} failed${response ? ` with HTTP ${response.status}` : ""}`)
    return response.json()
  }
  const asset = async (id: number) => {
    const response = await request(api(`/releases/assets/${id}`))
    if (response?.status === 404) return undefined
    if (!response?.ok) throw new Error(`Reading asset ${id} failed${response ? ` with HTTP ${response.status}` : ""}`)
    return readAsset(await response.json())
  }
  return {
    release: async () => readRelease(await read(api(`/releases/tags/${encodeURIComponent(input.tag)}`))),
    latestID: () =>
      read(api("/releases/latest")).then(
        (release) => readRelease(release).id,
        () => undefined,
      ),
    assets: async (releaseID: number) => {
      const pages: RemoteAsset[] = []
      for (let page = 1; ; page++) {
        const batch = await read(api(`/releases/${releaseID}/assets?per_page=100&page=${page}`))
        if (!Array.isArray(batch)) throw new Error(`Asset list for release ${releaseID} is not an array`)
        pages.push(...batch.map(readAsset))
        if (batch.length < 100) return pages
      }
    },
    download: async (id: number) => {
      const response = await request(api(`/releases/assets/${id}`), { headers: { accept: "application/octet-stream" } })
      if (!response?.ok) throw new Error(`Download of asset ${id} failed`)
      return new Uint8Array(await response.arrayBuffer())
    },
    upload: async (releaseID: number, name: string, content: Uint8Array) => {
      const response = await request(
        `${input.uploadURL}/repos/${input.repository}/releases/${releaseID}/assets?name=${encodeURIComponent(name)}`,
        { method: "POST", body: content, headers: { "content-type": "application/octet-stream" } },
      )
      return response?.ok ? readAsset(await response.json()) : undefined
    },
    rename: async (change: Rename) => {
      const response = await request(api(`/releases/assets/${change.id}`), {
        method: "PATCH",
        body: JSON.stringify({ name: change.to }),
        headers: { "content-type": "application/json" },
      })
      if (response?.ok) return
      const current = await asset(change.id)
      if (current?.name === change.to) return
      throw new Error(
        `Renaming asset ${change.id} from ${change.from} to ${change.to} failed; it is named ${current?.name ?? "missing"}`,
      )
    },
    remove: async (id: number) => {
      const response = await request(api(`/releases/assets/${id}`), { method: "DELETE" })
      if (response?.ok || response?.status === 404) return
      if ((await asset(id)) === undefined) return
      throw new Error(`Deleting staged asset ${id} failed`)
    },
    edit: async (releaseID: number, change: Record<string, unknown>) => {
      const response = await request(api(`/releases/${releaseID}`), {
        method: "PATCH",
        body: JSON.stringify(change),
        headers: { "content-type": "application/json" },
      })
      if (response?.ok) return
      throw new Error(`Updating release ${releaseID} failed${response ? ` with HTTP ${response.status}` : ""}`)
    },
  }
}

function readAsset(value: unknown): RemoteAsset {
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    typeof value.id !== "number" ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !("state" in value) ||
    typeof value.state !== "string" ||
    !("size" in value) ||
    typeof value.size !== "number"
  )
    throw new Error("GitHub returned an asset without id, name, state and size")
  const digest = "digest" in value && typeof value.digest === "string" ? value.digest : null
  return { id: value.id, name: value.name, state: value.state, size: value.size, digest }
}

function readRelease(value: unknown): RemoteRelease {
  if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "number")
    throw new Error("GitHub returned a release without an id")
  return {
    id: value.id,
    name: "name" in value && typeof value.name === "string" ? value.name : null,
    body: "body" in value && typeof value.body === "string" ? value.body : null,
    draft: "draft" in value && value.draft === true,
    prerelease: "prerelease" in value && value.prerelease === true,
  }
}

function describe(asset: RemoteAsset) {
  return { id: asset.id, name: asset.name, size: asset.size, digest: asset.digest }
}

function sha256(content: Uint8Array) {
  return createHash("sha256").update(content).digest("hex")
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const option = (name: string) => {
    const index = args.indexOf(`--${name}`)
    if (index === -1 || index + 1 >= args.length) throw new Error(`Missing --${name}`)
    return args.splice(index, 2)[1]!
  }
  const repository = option("repository")
  const tag = option("tag")
  const title = option("title")
  const notes = await Bun.file(option("notes-file")).text()
  const run = option("run")
  const manifest = option("manifest")
  const token = process.env.GH_TOKEN
  if (!token) throw new Error("GH_TOKEN is required")
  const result = await publish({
    apiURL: "https://api.github.com",
    uploadURL: "https://uploads.github.com",
    token,
    repository,
    tag,
    title,
    notes,
    run,
    files: args,
    manifest,
  })
  console.log(`Release ${tag} publication ${result.status}; manifest ${manifest}`)
  if (result.manifest.error) console.error(result.manifest.error)
  process.exit(result.status === "published" ? 0 : result.status === "unrestored" ? 2 : 1)
}
