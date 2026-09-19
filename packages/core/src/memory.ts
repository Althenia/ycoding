export * as Memory from "./memory"

import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Context, Effect, Exit, Layer } from "effect"
import { Config } from "./config"
import { ConfigMemory } from "./config/memory"
import { makeLocationNode } from "./effect/app-node"
import { Git } from "./git"
import { Global } from "./global"
import { Location } from "./location"
import { AbsolutePath } from "./schema"
import { Hash } from "./util/hash"
import { Flock } from "./util/flock"
import { MemoryFormat } from "./memory/format"
import { MemoryGraph } from "./memory/graph"
import { MemoryError, memoryError } from "./memory/error"
import { executeMutation, native } from "./project-artifact/filesystem"

export { MemoryError } from "./memory/error"
export type Scope = "repository" | "knowledge"
export type Interface = ReturnType<typeof make>
export class Service extends Context.Service<Service, Interface>()("@ycoding/Memory") {}

/** Minimal Git surface memory needs; the real Git service satisfies it structurally. */
export interface GitAccess {
  readonly repo: { readonly discover: (input: AbsolutePath) => Effect.Effect<Git.Repository | undefined> }
  readonly worktree: {
    readonly list: (repository: Git.Repository) => Effect.Effect<readonly Git.Worktree[], Git.WorktreeError>
  }
}

export interface RepositoryInfo {
  readonly id: string
  readonly directory: string
  readonly commonDirectory: string
  readonly worktrees: readonly string[]
}

export interface State {
  readonly enabled: boolean
  readonly scope: Scope
  readonly directory: string
  readonly base: string
  readonly root: string
  readonly knowledgeRoot: string
  readonly repository?: RepositoryInfo
  readonly limits: ConfigMemory.Resolved
}

/** Marks a generated index so vacuum and regeneration recognize their own output, never handwritten files. */
const generatedIndexMarker = "Generated index. Edit concept Markdown, not this file."
const reserved = ["index.md", "log.md", "graph.html", "_meta.json"]
const trashDirectory = "trash"
const sidecarLimitBytes = 4096

export function make(input: {
  readonly directory: string
  readonly home: string
  readonly data: string
  readonly git: GitAccess
  readonly settings: () => Effect.Effect<ConfigMemory.Resolved>
}) {
  const state = (scope: Scope = "repository") =>
    input.settings().pipe(Effect.flatMap((settings) => attempt(() => resolve(input, settings, scope))))

  const operate = <A>(
    scope: Scope | undefined,
    expectedRoot: string | undefined,
    use: (state: State, signal: AbortSignal) => Promise<A>,
  ) =>
    state(scope).pipe(
      Effect.flatMap((resolved) =>
        attempt((signal) => {
          if (!resolved.enabled) throw new MemoryError({ code: "Disabled", message: "Workspace memory is disabled." })
          if (expectedRoot !== undefined && resolved.root !== expectedRoot)
            throw new MemoryError({
              code: "UnsafePath",
              message: "Memory location changed during approval; retry the operation.",
            })
          return use(resolved, signal)
        }),
      ),
    )

  /**
   * Runs a committed mutation under the collection lock, then rebuilds derived files best-effort.
   * `validate` runs before any storage exists, so a refused operation leaves no trace; a derived
   * rebuild failure after commit reports the committed result with an `index-out-of-date` warning.
   */
  const mutate = <A>(
    scope: Scope | undefined,
    expectedRoot: string | undefined,
    options: { ensure: boolean; validate?: (state: State) => Promise<void> },
    use: (
      state: State,
      signal: AbortSignal,
    ) => Promise<{ result: A; id: string; concepts?: readonly MemoryFormat.Concept[] }>,
  ) =>
    operate(scope, expectedRoot, async (resolved, signal) => {
      if (options.validate) await options.validate(resolved)
      signal.throwIfAborted()
      if (options.ensure) await createRoot(resolved.root)
      return Flock.withLock(
        resolved.root,
        async () => {
          signal.throwIfAborted()
          const { result, id, concepts } = await use(resolved, signal)
          const warnings = await refreshDerived(resolved, concepts, signal).then(
            () => [],
            () => [{ id, code: "index-out-of-date" }],
          )
          return { ...result, warnings }
        },
        { dir: path.join(resolved.root, ".locks"), signal },
      )
    })

  return {
    status: (scope: Scope = "repository") => state(scope),
    list: (options: { scope?: Scope; limit?: number; offset?: number }, expectedRoot?: string) =>
      operate(options.scope, expectedRoot, async (resolved) => {
        range(options.limit ?? 20, 1, 100)
        range(options.offset ?? 0, 0, Number.MAX_SAFE_INTEGER)
        const bundle = await scan(resolved.root, resolved.limits)
        const offset = options.offset ?? 0
        const limit = options.limit ?? 20
        return {
          concepts: bundle.concepts.slice(offset, offset + limit).map(MemoryFormat.summary),
          total: bundle.concepts.length,
          warnings: bundle.warnings,
        }
      }),
    search: (
      options: { scope?: Scope; query: string; limit?: number; type?: string; tag?: string },
      expectedRoot?: string,
    ) =>
      operate(options.scope, expectedRoot, async (resolved) => {
        range(options.limit ?? 10, 1, 50)
        if (!options.query.trim() || options.query.length > 1024)
          throw new MemoryError({
            code: "InvalidConcept",
            message: "Search query must contain text and be at most 1024 characters.",
          })
        const bundle = await scan(resolved.root, resolved.limits)
        const terms = [...new Set(MemoryFormat.words(options.query))]
        const hits = bundle.concepts
          .filter(
            (concept) =>
              (!options.type || concept.type === options.type) && (!options.tag || concept.tags?.includes(options.tag)),
          )
          .map((concept) => {
            const fields = [
              { text: `${concept.title ?? ""} ${concept.id}`, weight: 4 },
              { text: `${concept.type} ${(concept.tags ?? []).join(" ")} ${concept.description ?? ""}`, weight: 2 },
              { text: concept.body, weight: 1 },
            ]
            const score = fields.reduce((total, field) => {
              const words = new Set(MemoryFormat.words(field.text))
              return total + terms.filter((term) => words.has(term)).length * field.weight
            }, 0)
            const first =
              terms
                .map((term) => concept.body.toLowerCase().indexOf(term))
                .filter((index) => index >= 0)
                .sort((a, b) => a - b)[0] ?? 0
            return {
              ...MemoryFormat.summary(concept),
              score,
              snippet: concept.body.slice(Math.max(0, first - 60), Math.max(0, first - 60) + 320).trim(),
            }
          })
          .filter((hit) => hit.score > 0)
          .sort((a, b) => b.score - a.score || MemoryFormat.compare(a.id, b.id))
          .slice(0, options.limit ?? 10)
        return { hits, warnings: bundle.warnings }
      }),
    read: (options: { scope?: Scope; id: string }, expectedRoot?: string) =>
      operate(options.scope, expectedRoot, async (resolved) => {
        const concept = await readConcept(resolved.root, resolved.limits, options.id)
        return { id: concept.id, content: concept.content, digest: concept.digest }
      }),
    write: (options: { scope?: Scope; id: string; content: string; expectedDigest?: string }, expectedRoot?: string) =>
      mutate(
        options.scope,
        expectedRoot,
        {
          ensure: true,
          // Validate and parse before any storage is created, so an invalid write leaves no trace.
          validate: async () => {
            MemoryFormat.requireID(options.id)
            await MemoryFormat.parse(options.id, options.content)
          },
        },
        async (resolved, signal) => {
          const bytes = Buffer.byteLength(options.content)
          if (bytes > resolved.limits.max_concept_bytes) throw tooLarge()
          const concept = await MemoryFormat.parse(options.id, options.content)
          const target = path.join(resolved.root, `${options.id}.md`)
          const exists = await safePath(resolved.root, target)
          const before = exists ? await readContent(resolved.root, resolved.limits, target) : undefined
          if (before !== undefined && before !== options.content && Hash.sha256(before) !== options.expectedDigest)
            throw new MemoryError({
              code: "StaleContent",
              message: "Concept changed or already exists; read it and supply its current digest.",
            })
          if (before === undefined && options.expectedDigest !== undefined)
            throw new MemoryError({
              code: "StaleContent",
              message: "Concept changed or no longer exists; read it before replacing.",
            })
          const bundle = await scan(resolved.root, resolved.limits)
          if (
            bundle.count + (exists ? 0 : 1) > resolved.limits.max_concepts ||
            bundle.bytes - (before === undefined ? 0 : Buffer.byteLength(before)) + bytes >
              resolved.limits.max_bundle_bytes
          )
            throw tooLarge()
          const concepts = [...bundle.concepts.filter((item) => item.id !== options.id), concept].sort((a, b) =>
            MemoryFormat.compare(a.id, b.id),
          )
          await createParents(resolved.root, path.dirname(target))
          if (before !== options.content) await atomic(resolved.root, target, options.content, signal)
          return { result: { id: options.id, digest: concept.digest, created: !exists }, id: options.id, concepts }
        },
      ),
    graph: (options: { scope?: Scope } = {}, expectedRoot?: string) =>
      operate(options.scope, expectedRoot, async (resolved, signal) => {
        signal.throwIfAborted()
        await createRoot(resolved.root)
        return Flock.withLock(
          resolved.root,
          async () => {
            const exported = await exportGraph(resolved, signal)
            const indexFailure = await indexes(resolved, exported.repository.concepts, signal).then(
              () => [],
              () => [{ id: "", code: "index-out-of-date" }],
            )
            return {
              path: exported.path,
              digest: Hash.sha256(exported.html),
              nodes: exported.graph.nodes,
              edges: exported.graph.edges,
              warnings: [
                ...exported.repository.warnings,
                ...exported.knowledge.warnings,
                ...exported.graph.warnings,
                ...indexFailure,
              ],
            }
          },
          { dir: path.join(resolved.root, ".locks"), signal },
        )
      }),
    delete: (options: { scope?: Scope; id: string; expectedDigest: string }, expectedRoot?: string) =>
      mutate(
        options.scope,
        expectedRoot,
        {
          ensure: false,
          validate: async (resolved) => {
            MemoryFormat.requireID(options.id)
            await requireRoot(resolved.root)
          },
        },
        async (resolved, signal) => {
          const target = path.join(resolved.root, `${options.id}.md`)
          const before = await readContent(resolved.root, resolved.limits, target)
          if (Hash.sha256(before) !== options.expectedDigest)
            throw new MemoryError({
              code: "StaleContent",
              message: "Concept changed; read it and supply its current digest before deleting.",
            })
          const trashID = trashIDFor(options.id, options.expectedDigest)
          const stored = path.join(resolved.root, trashDirectory, `${trashID}.md`)
          const archived = await safePath(resolved.root, stored)
          // An identical receipt reuses its archived copy, so a repeat deletion consumes no new
          // trash budget. Only a genuinely new receipt is admitted against the inventory limits.
          if (!archived) {
            const trash = await listTrash(resolved)
            // Fail closed on any incomplete inventory: a truncated or unreadable listing cannot
            // prove the archive fits, so admitting would exceed the configured bound.
            if (trash.warnings.length > 0) throw tooLarge()
            if (
              trash.entries.length + 1 > resolved.limits.max_concepts ||
              trash.bytes + Buffer.byteLength(before) > resolved.limits.max_bundle_bytes
            )
              throw tooLarge()
          }
          // Refuse before commit when the remaining collection cannot be read or would exceed limits.
          await scan(resolved.root, resolved.limits)
          await createParents(resolved.root, path.dirname(stored))
          // Receipts bind id and archived bytes, so an identical re-created concept maps to the same
          // recoverable copy: keep it and remove only the active duplicate.
          if (archived) {
            // A missing or tampered receipt must not turn a live concept into an un-restorable
            // archive, so the original identity is validated before the active duplicate is removed.
            const entry = await readTrash(resolved, trashID)
            if (entry.id !== options.id)
              throw new MemoryError({
                code: "StaleContent",
                message: "Trash receipt identifies a different concept; refusing to archive over it.",
              })
            if (entry.content !== before)
              throw new MemoryError({
                code: "StaleContent",
                message: "Trash receipt collides with different archived bytes; refusing to overwrite it.",
              })
            await fs.rm(target, { force: false })
          } else {
            await atomic(
              resolved.root,
              path.join(resolved.root, trashDirectory, `${trashID}.json`),
              JSON.stringify({ version: 1, id: options.id }) + "\n",
              signal,
            )
            // The concept rename is the deletion commit; derived rebuilds never gate it.
            await executeMutation(native, {
              operation: "rename",
              sourceRoot: resolved.root,
              destinationRoot: resolved.root,
              source: target,
              destination: stored,
            })
          }
          const concepts = await remaining(resolved)
          return {
            result: { id: options.id, trashID, digest: options.expectedDigest },
            id: options.id,
            ...(concepts === undefined ? {} : { concepts }),
          }
        },
      ),
    trash: (options: { scope?: Scope; offset?: number; limit?: number }, expectedRoot?: string) =>
      operate(options.scope, expectedRoot, async (resolved) => {
        range(options.limit ?? 20, 1, 100)
        range(options.offset ?? 0, 0, Number.MAX_SAFE_INTEGER)
        const listing = await listTrash(resolved)
        const offset = options.offset ?? 0
        const limit = options.limit ?? 20
        return {
          entries: listing.entries.slice(offset, offset + limit),
          total: listing.entries.length,
          warnings: listing.warnings,
        }
      }),
    restore: (options: { scope?: Scope; trashID: string; expectedDigest: string }, expectedRoot?: string) =>
      mutate(
        options.scope,
        expectedRoot,
        {
          ensure: false,
          validate: async (resolved) => {
            await requireRoot(resolved.root)
          },
        },
        async (resolved) => {
          const entry = await readTrash(resolved, options.trashID)
          if (entry.digest !== options.expectedDigest)
            throw new MemoryError({
              code: "StaleContent",
              message: "Trash entry changed; list trash and supply its current digest before restoring.",
            })
          const target = path.join(resolved.root, `${entry.id}.md`)
          if (await safePath(resolved.root, target))
            throw new MemoryError({
              code: "StaleContent",
              message: "A concept already occupies this ID; restore never overwrites it.",
            })
          // Capacity and readability are checked before the rename, so a refusal never loses the entry.
          const active = await scan(resolved.root, resolved.limits)
          if (
            active.count + 1 > resolved.limits.max_concepts ||
            active.bytes + Buffer.byteLength(entry.content) > resolved.limits.max_bundle_bytes
          )
            throw tooLarge()
          await createParents(resolved.root, path.dirname(target))
          await executeMutation(native, {
            operation: "rename",
            sourceRoot: resolved.root,
            destinationRoot: resolved.root,
            source: path.join(resolved.root, trashDirectory, `${entry.trashID}.md`),
            destination: target,
          })
          await removeSidecar(resolved, entry.trashID)
          const concepts = await remaining(resolved)
          return {
            result: { id: entry.id, digest: entry.digest },
            id: entry.id,
            ...(concepts === undefined ? {} : { concepts }),
          }
        },
      ),
    purge: (options: { scope?: Scope; trashID: string; expectedDigest: string }, expectedRoot?: string) =>
      mutate(
        options.scope,
        expectedRoot,
        {
          ensure: false,
          validate: async (resolved) => {
            await requireRoot(resolved.root)
          },
        },
        async (resolved) => {
          const entry = await readTrash(resolved, options.trashID)
          if (entry.digest !== options.expectedDigest)
            throw new MemoryError({
              code: "StaleContent",
              message: "Trash entry changed; list trash and supply its current digest before purging.",
            })
          const stored = path.join(resolved.root, trashDirectory, `${entry.trashID}.md`)
          await safePath(resolved.root, stored)
          await fs.rm(stored, { force: false })
          await removeSidecar(resolved, entry.trashID)
          const concepts = await remaining(resolved)
          return {
            result: { trashID: entry.trashID, purged: true },
            id: entry.id,
            ...(concepts === undefined ? {} : { concepts }),
          }
        },
      ),
    vacuum: (options: { scope?: Scope; dryRun?: boolean; expectedDigest?: string }, expectedRoot?: string) =>
      operate(options.scope, expectedRoot, async (resolved, signal) => {
        const dryRun = options.dryRun ?? true
        if (!(await safePath(resolved.root, resolved.root))) {
          const digest = inventoryDigest([], [], { entries: [] })
          if (!dryRun) {
            if (options.expectedDigest !== digest) throw stalePreview()
            await createRoot(resolved.root)
          }
          return { dryRun, digest, removed: [], warnings: [] }
        }
        // Preview stays strictly read-only: no storage creation and no lock files.
        if (dryRun) {
          const bundle = await scan(resolved.root, resolved.limits)
          const trash = await listTrash(resolved)
          const obsolete = await findObsolete(resolved, bundle.concepts)
          return {
            dryRun,
            digest: inventoryDigest(obsolete, bundle.concepts, trash),
            removed: obsolete.map((item) => item.path),
            warnings: [...bundle.warnings, ...trash.warnings],
          }
        }
        if (options.expectedDigest === undefined) throw stalePreview()
        await createRoot(resolved.root)
        return Flock.withLock(
          resolved.root,
          async () => {
            signal.throwIfAborted()
            const bundle = await scan(resolved.root, resolved.limits)
            const trash = await listTrash(resolved)
            const obsolete = await findObsolete(resolved, bundle.concepts)
            const digest = inventoryDigest(obsolete, bundle.concepts, trash)
            if (options.expectedDigest !== digest) throw stalePreview()
            for (const item of obsolete) {
              signal.throwIfAborted()
              const target = path.join(resolved.root, item.path)
              await safePath(resolved.root, target)
              await fs.rm(target, { force: true })
            }
            await removeEmptyDirectories(
              resolved.root,
              obsolete.map((item) => item.path),
            )
            await indexes(resolved, bundle.concepts, signal)
            return {
              dryRun,
              digest,
              removed: obsolete.map((item) => item.path),
              warnings: [...bundle.warnings, ...trash.warnings],
            }
          },
          { dir: path.join(resolved.root, ".locks"), signal },
        )
      }),
  }
}

async function resolve(
  input: { directory: string; home: string; data: string; git: GitAccess },
  settings: ConfigMemory.Resolved,
  scope: Scope,
): Promise<State> {
  const directory = await fs.realpath(input.directory)
  const repository = await discoverRepository(input.git, directory)
  if (scope === "repository" && !repository)
    throw new MemoryError({
      code: "NotFound",
      message: "No Git repository found for this location; repository memory is not available. Use the knowledge scope.",
    })
  const association = repository
    ? {
        id: `repo_${Hash.sha256(await canonical(repository.commonDirectory))}`,
        directory: await canonical(repository.worktree),
        commonDirectory: await canonical(repository.commonDirectory),
        worktrees: await worktreeDirectories(input.git, repository),
      }
    : undefined
  const anchor = association ? association.worktrees[0] ?? association.directory : directory
  const base = await baseOf(input, settings, anchor)
  const knowledgeRoot = path.join(base, "knowledge")
  const root = scope === "knowledge" ? knowledgeRoot : path.join(base, "repository", association!.id)
  return { enabled: settings.enabled, scope, directory, base, root, knowledgeRoot, repository: association, limits: settings }
}

async function baseOf(input: { data: string; home: string }, settings: ConfigMemory.Resolved, anchor: string) {
  if (settings.path === undefined) return canonical(path.join(input.data, "memory"))
  const configured = settings.path
  const expanded =
    configured === "~" ? input.home : configured.startsWith("~/") ? path.join(input.home, configured.slice(2)) : configured
  return canonical(path.isAbsolute(expanded) ? expanded : path.resolve(anchor, expanded))
}

async function discoverRepository(git: GitAccess, directory: string) {
  const exit = await Effect.runPromise(Effect.exit(git.repo.discover(AbsolutePath.make(directory))))
  return Exit.isSuccess(exit) ? exit.value : undefined
}

async function worktreeDirectories(git: GitAccess, repository: Git.Repository) {
  const exit = await Effect.runPromise(Effect.exit(git.worktree.list(repository)))
  if (Exit.isFailure(exit) || exit.value.length === 0) return [await canonical(repository.worktree)]
  return await Promise.all(exit.value.map((worktree) => canonical(worktree.directory)))
}

function attempt<A>(run: (signal: AbortSignal) => Promise<A>) {
  return Effect.tryPromise({ try: run, catch: memoryError })
}

async function canonical(target: string): Promise<string> {
  return fs.realpath(target).catch(async (error: unknown) => {
    if (!missing(error)) throw error
    return path.join(await canonical(path.dirname(target)), path.basename(target))
  })
}

function missing(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

async function info(target: string) {
  return fs.lstat(target).catch((error: unknown) => {
    if (missing(error)) return undefined
    throw error
  })
}

async function requireRoot(root: string) {
  if (!(await safePath(root, root))) throw notFound()
}

async function safePath(root: string, target: string) {
  const relative = path.relative(root, target)
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw unsafe()
  const paths = [
    root,
    ...relative
      .split(path.sep)
      .filter(Boolean)
      .map((_, index, parts) => path.join(root, ...parts.slice(0, index + 1))),
  ]
  for (const [index, current] of paths.entries()) {
    const stat = await info(current)
    if (!stat) return false
    if (stat.isSymbolicLink() || (index < paths.length - 1 && !stat.isDirectory())) throw unsafe()
    if ((await fs.realpath(current)) !== current) throw unsafe()
  }
  return true
}

async function createRoot(root: string) {
  await fs.mkdir(path.dirname(root), { recursive: true, mode: 0o700 })
  if ((await fs.realpath(path.dirname(root))) !== path.dirname(root)) throw unsafe()
  const existing = await info(root)
  if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) throw unsafe()
  if (!existing)
    await fs.mkdir(root, { mode: 0o700 }).catch((error: unknown) => {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "EEXIST") throw error
    })
  await safePath(root, root)
  if (process.platform !== "win32") await fs.chmod(root, 0o700)
  const lock = path.join(root, ".locks")
  await safePath(root, lock)
  await fs.mkdir(lock, { recursive: true, mode: 0o700 })
}

async function createParents(root: string, directory: string) {
  const parts = path.relative(root, directory).split(path.sep).filter(Boolean)
  for (const [index] of parts.entries()) {
    const target = path.join(root, ...parts.slice(0, index + 1))
    if (!(await safePath(root, target))) await fs.mkdir(target, { mode: 0o700 })
  }
}

/** Reads one bounded regular file without following a symlink. */
async function readBounded(target: string, limit: number) {
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw unsafe()
    if (stat.size > limit) throw tooLarge()
    const buffer = Buffer.alloc(stat.size + 1)
    const result = await handle.read(buffer, 0, buffer.length, 0)
    if (result.bytesRead !== stat.size)
      throw new MemoryError({ code: "StaleContent", message: "Content changed while reading; retry." })
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, result.bytesRead))
    } catch {
      throw new MemoryError({ code: "InvalidConcept", message: "Concept is not valid UTF-8." })
    }
  } finally {
    await handle.close()
  }
}

async function readContent(root: string, limits: ConfigMemory.Resolved, target: string) {
  if (!(await safePath(root, target))) throw notFound()
  return readBounded(target, limits.max_concept_bytes)
}

async function readConcept(root: string, limits: ConfigMemory.Resolved, id: string) {
  MemoryFormat.requireID(id)
  return MemoryFormat.parse(id, await readContent(root, limits, path.join(root, `${id}.md`)))
}

async function scan(root: string, limits: ConfigMemory.Resolved) {
  const concepts: MemoryFormat.Concept[] = []
  const warnings: MemoryFormat.Warning[] = []
  const totals = { bytes: 0, count: 0 }
  if (!(await safePath(root, root))) return { concepts, warnings, ...totals }
  const visit = async (directory: string): Promise<void> => {
    const directoryInfo = await info(directory)
    if (!directoryInfo) return
    if (!directoryInfo.isDirectory()) throw unsafe()
    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => MemoryFormat.compare(a.name, b.name))) {
      if (entry.name.startsWith(".") || reserved.includes(entry.name) || entry.name === trashDirectory) continue
      const target = path.join(directory, entry.name)
      const id = path.relative(root, target).split(path.sep).join("/").replace(/\.md$/, "")
      if (entry.isSymbolicLink()) {
        warnings.push({ id, code: "unsafe-link" })
        continue
      }
      if (entry.isDirectory()) {
        await safePath(root, target)
        await visit(target)
        continue
      }
      if (!entry.name.endsWith(".md")) continue
      totals.count++
      if (totals.count > limits.max_concepts) throw tooLarge()
      const stat = await fs.lstat(target)
      totals.bytes += stat.size
      if (stat.size > limits.max_concept_bytes || totals.bytes > limits.max_bundle_bytes) throw tooLarge()
      try {
        concepts.push(await readConcept(root, limits, id))
      } catch (error) {
        if (error instanceof MemoryError && error.code === "TooLarge") throw error
        warnings.push({
          id,
          code: error instanceof MemoryError && error.code === "InvalidConcept" ? "invalid-concept" : "unreadable-concept",
        })
      }
    }
  }
  await visit(root)
  concepts.sort((a, b) => MemoryFormat.compare(a.id, b.id))
  return { concepts, warnings, ...totals }
}

/** Post-commit scan: a failure must not turn a committed mutation into a reported failure. */
async function remaining(state: State) {
  return scan(state.root, state.limits).then(
    (bundle) => bundle.concepts,
    () => undefined,
  )
}

async function atomic(root: string, target: string, content: string, signal: AbortSignal) {
  await safePath(root, target)
  const temporary = path.join(path.dirname(target), `.${randomUUID()}.tmp`)
  try {
    signal.throwIfAborted()
    await fs.writeFile(temporary, content, { flag: "wx", mode: 0o600 })
    signal.throwIfAborted()
    await executeMutation(native, {
      operation: "rename",
      sourceRoot: root,
      destinationRoot: root,
      source: temporary,
      destination: target,
      replace: true,
    })
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

interface TrashEntry {
  readonly id: string
  readonly trashID: string
  readonly digest: string
}

async function readSidecar(directory: string, trashID: string) {
  const target = path.join(directory, `${trashID}.json`)
  const stat = await info(target)
  if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.size > sidecarLimitBytes) return undefined
  const text = await readBounded(target, sidecarLimitBytes).catch(() => undefined)
  if (text === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== "object" || parsed === null) return undefined
    const record = parsed as { id?: unknown }
    if (typeof record.id !== "string") return undefined
    MemoryFormat.requireID(record.id)
    return { id: record.id }
  } catch {
    return undefined
  }
}

async function removeSidecar(state: State, trashID: string) {
  const target = path.join(state.root, trashDirectory, `${trashID}.json`)
  await safePath(state.root, target)
  await fs.rm(target, { force: true })
}

/** Receipt derived from the original id and the archived bytes, so an edited sidecar id cannot pass. */
function trashIDFor(id: string, digest: string) {
  return `trash_${Hash.sha256(`${id}\0${digest}`)}`
}

/** Reads one trash entry, hashing its actual archived bytes and re-deriving its receipt from them. */
async function readTrash(state: State, trashID: string) {
  if (!/^trash_[a-f0-9]{64}$/.test(trashID)) throw notFound()
  const directory = path.join(state.root, trashDirectory)
  const content = await readContent(state.root, state.limits, path.join(directory, `${trashID}.md`))
  const metadata = await readSidecar(directory, trashID)
  if (!metadata) throw notFound()
  const digest = Hash.sha256(content)
  if (trashIDFor(metadata.id, digest) !== trashID) throw notFound()
  return { id: metadata.id, trashID, digest, content }
}

/**
 * Bounded trash inventory. Entries are bounded by the concept limit and diagnostics by a separate
 * budget, so malformed receipts cannot grow warnings without limit while a valid receipt is still
 * discoverable at capacity. The final diagnostic slot reports truncation.
 */
async function listTrash(state: State) {
  const directory = path.join(state.root, trashDirectory)
  const entries: TrashEntry[] = []
  const warnings: MemoryFormat.Warning[] = []
  const entryLimit = state.limits.max_concepts
  const warningLimit = Math.max(0, state.limits.max_concepts - 1)
  let bytes = 0
  const stat = await info(directory)
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return { entries, bytes, warnings }
  if ((await fs.realpath(directory)) !== directory) return { entries, bytes, warnings }
  const names = (await fs.readdir(directory)).sort(MemoryFormat.compare)
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    const trashID = name.slice(0, -".json".length)
    if (!/^trash_[a-f0-9]{64}$/.test(trashID)) continue
    if (entries.length >= entryLimit) {
      warnings.push({ id: trashID, code: "trash-limit" })
      break
    }
    try {
      const entry = await readTrash(state, trashID)
      if (bytes + Buffer.byteLength(entry.content) > state.limits.max_bundle_bytes) {
        warnings.push({ id: trashID, code: "trash-limit" })
        break
      }
      bytes += Buffer.byteLength(entry.content)
      entries.push({ id: entry.id, trashID, digest: entry.digest })
    } catch {
      if (warnings.length >= warningLimit) {
        warnings.push({ id: trashID, code: "trash-limit" })
        break
      }
      warnings.push({ id: trashID, code: "unreadable-trash" })
    }
  }
  entries.sort((a, b) => MemoryFormat.compare(a.trashID, b.trashID))
  return { entries, bytes, warnings }
}

/**
 * Rebuilds indexes and invalidates an already-existing managed graph after a committed mutation.
 * The graph is a derived export, so it is removed rather than cross-scanning shared knowledge here;
 * an explicit graph export regenerates it with the repository's current contents.
 */
async function refreshDerived(state: State, concepts: readonly MemoryFormat.Concept[] | undefined, signal: AbortSignal) {
  let failed = false
  const live =
    concepts ??
    (await scan(state.root, state.limits).then(
      (bundle) => bundle.concepts,
      () => {
        failed = true
        return undefined
      },
    ))
  if (live) {
    await indexes(state, live, signal).catch(() => {
      failed = true
    })
  }
  await invalidateGraph(state).catch(() => {
    failed = true
  })
  if (failed)
    throw new MemoryError({ code: "Unavailable", message: "Derived memory files could not be rebuilt." })
}

/** Removes the managed graph so a deleted or changed concept cannot remain visible in it. */
async function invalidateGraph(state: State) {
  const target = path.join(state.root, "graph.html")
  if (!(await info(target))) return
  await safePath(state.root, target)
  await fs.rm(target, { force: true })
}

async function exportGraph(state: State, signal: AbortSignal) {
  signal.throwIfAborted()
  const repository = await scan(state.root, state.limits)
  const knowledge =
    state.scope === "repository"
      ? await scan(state.knowledgeRoot, state.limits)
      : { concepts: [] as MemoryFormat.Concept[], warnings: [] as MemoryFormat.Warning[], bytes: 0, count: 0 }
  const nodes = [
    ...repository.concepts.map((concept) => ({
      id:
        state.scope === "repository"
          ? `repository/${state.repository!.id}/${concept.id}`
          : `knowledge/${concept.id}`,
      concept,
    })),
    // Knowledge concepts keep the same qualified identity in both scopes so a memory-root link
    // like `/knowledge/build.md` resolves identically in a repository and a knowledge-only export.
    ...knowledge.concepts.map((concept) => ({ id: `knowledge/${concept.id}`, concept })),
  ]
  const graph = MemoryGraph.render(nodes)
  const target = path.join(state.root, "graph.html")
  await atomic(state.root, target, graph.html, signal)
  return { graph, html: graph.html, path: target, repository, knowledge }
}

async function indexes(state: State, concepts: readonly MemoryFormat.Concept[], signal: AbortSignal) {
  const directories = new Set([
    "",
    ...concepts.flatMap((concept) =>
      concept.id
        .split("/")
        .slice(0, -1)
        .map((_, index, parts) => parts.slice(0, index + 1).join("/")),
    ),
  ])
  for (const directory of [...directories].sort(MemoryFormat.compare)) {
    const prefix = directory ? `${directory}/` : ""
    const lines = concepts.filter((concept) => concept.id.startsWith(prefix)).map((concept) => entry(concept, prefix))
    const target = path.join(state.root, directory, "index.md")
    const disposition = await indexDisposition(state, target)
    if (disposition === "preserve") continue
    await atomic(state.root, target, indexContent(state, directory, lines), signal)
  }
}

/**
 * Generated indexes are regenerated; an existing handwritten file is preserved; any other existing
 * path (directory, symlink, oversize) is an obstruction that fails the derived rebuild.
 */
async function indexDisposition(state: State, target: string): Promise<"write" | "preserve"> {
  const stat = await info(target)
  if (!stat) return "write"
  if (stat.isSymbolicLink() || !stat.isFile()) throw unsafe()
  const content = await readBounded(target, state.limits.max_bundle_bytes)
  return content.includes(generatedIndexMarker) ? "write" : "preserve"
}

function entry(concept: MemoryFormat.Concept, prefix: string) {
  const title = (concept.title ?? concept.id).replace(/[\\[\]]/g, "\\$&").replace(/\s+/g, " ")
  return `- [${title}](${concept.id.slice(prefix.length)}.md) — ${concept.type.replace(/\s+/g, " ")}`
}

function indexContent(state: State, directory: string, lines: readonly string[]) {
  const heading = directory ? `# ${directory}` : state.scope === "knowledge" ? "# Shared knowledge" : "# Repository memory"
  const metadata =
    directory === "" && state.scope === "repository"
      ? [
          "---",
          "type: Index",
          `repository: ${state.repository?.id ?? ""}`,
          "worktrees:",
          ...(state.repository?.worktrees ?? []).map((worktree) => `  - ${JSON.stringify(worktree)}`),
          "---",
          "",
        ]
      : directory === "" && state.scope === "knowledge"
        ? ["---", "type: Index", "title: Shared knowledge", "---", ""]
        : []
  const footer =
    directory === "" && state.scope === "repository"
      ? ["", "Shared knowledge: [../../knowledge/index.md](../../knowledge/index.md)"]
      : []
  return [...metadata, heading, "", generatedIndexMarker, "", ...lines, ...footer, ""].join("\n")
}

/** Recognized generated indexes whose directory no longer holds any live concept, with their bytes. */
async function findObsolete(state: State, concepts: readonly MemoryFormat.Concept[]) {
  const prefixes = new Set(
    concepts.flatMap((concept) =>
      concept.id
        .split("/")
        .slice(0, -1)
        .map((_, index, parts) => parts.slice(0, index + 1).join("/")),
    ),
  )
  prefixes.add("")
  const obsolete: { path: string; digest: string }[] = []
  const visit = async (directory: string, relative: string): Promise<void> => {
    const stat = await info(directory)
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return
    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entryInfo of entries.sort((a, b) => MemoryFormat.compare(a.name, b.name))) {
      if (entryInfo.name.startsWith(".") || entryInfo.name === trashDirectory) continue
      const childRelative = relative ? `${relative}/${entryInfo.name}` : entryInfo.name
      if (entryInfo.isSymbolicLink()) continue
      if (entryInfo.isDirectory()) {
        await visit(path.join(directory, entryInfo.name), childRelative)
        continue
      }
      // Reserved generated names are inspected here rather than skipped, so an obsolete index is found.
      if (entryInfo.name !== "index.md" || prefixes.has(relative)) continue
      const content = await readBounded(path.join(directory, entryInfo.name), state.limits.max_bundle_bytes).catch(
        () => undefined,
      )
      // Only recognized generated output is vacuumable; handwritten and unknown files are preserved.
      if (content === undefined || !content.includes(generatedIndexMarker)) continue
      obsolete.push({ path: childRelative, digest: Hash.sha256(content) })
    }
  }
  await visit(state.root, "")
  return obsolete.sort((a, b) => MemoryFormat.compare(a.path, b.path))
}

async function removeEmptyDirectories(root: string, removed: readonly string[]) {
  const directories = [...new Set(removed.map((relative) => path.posix.dirname(relative)))].sort(
    (a, b) => b.length - a.length,
  )
  for (const relative of directories) {
    if (relative === "." || relative === "") continue
    const target = path.join(root, relative)
    const entries = await fs.readdir(target).catch(() => undefined)
    if (entries && entries.length === 0) await fs.rmdir(target).catch(() => undefined)
  }
}

/** Binds the preview to the bytes of every file an apply would delete, not just their paths. */
function inventoryDigest(
  obsolete: readonly { readonly path: string; readonly digest: string }[],
  concepts: readonly MemoryFormat.Concept[],
  trash: { readonly entries: readonly TrashEntry[] },
) {
  return Hash.sha256(
    JSON.stringify({
      removed: obsolete
        .map((item) => [item.path, item.digest])
        .sort((a, b) => MemoryFormat.compare(a[0], b[0])),
      concepts: concepts
        .map((concept) => [concept.id, concept.digest])
        .sort((a, b) => MemoryFormat.compare(a[0], b[0])),
      trash: trash.entries
        .map((entry) => [entry.trashID, entry.digest])
        .sort((a, b) => MemoryFormat.compare(a[0], b[0])),
    }),
  )
}

function range(value: number, min: number, max: number) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new MemoryError({ code: "InvalidConcept", message: `Input must be an integer between ${min} and ${max}.` })
}
function unsafe() {
  return new MemoryError({
    code: "UnsafePath",
    message: "Unsafe memory path: symbolic links and non-directory ancestors are not allowed.",
  })
}
function tooLarge() {
  return new MemoryError({ code: "TooLarge", message: "Workspace memory exceeds a configured concept or bundle limit." })
}
function notFound() {
  return new MemoryError({ code: "NotFound", message: "Concept or trash entry not found." })
}
function stalePreview() {
  return new MemoryError({
    code: "StaleContent",
    message: "Vacuum preview is stale or missing; run a dry-run preview and supply its digest.",
  })
}

export const node = makeLocationNode({
  service: Service,
  layer: Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* Config.Service
      const git = yield* Git.Service
      const global = yield* Global.Service
      const location = yield* Location.Service
      return make({
        directory: location.directory,
        home: global.home,
        data: global.data,
        git,
        settings: () =>
          config.entries().pipe(
            Effect.map((entries) =>
              ConfigMemory.resolve(
                entries
                  .filter((entry): entry is Config.Document => entry.type === "document")
                  .flatMap((entry) => (entry.info.memory ? [entry.info.memory] : [])),
              ),
            ),
          ),
      })
    }),
  ),
  deps: [Config.node, Git.node, Global.node, Location.node],
})