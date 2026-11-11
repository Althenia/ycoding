import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import { constants, lstatSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export interface MeetingMemoryDocument {
  scope: "repository" | "knowledge"
  id: string
  revision: string
  content: string
  title?: string
  type?: string
  tags?: string[]
}

export interface MeetingMemoryAdapter {
  search(input: {
    scope?: "repository" | "knowledge"
    query: string
    limit?: number
  }): Promise<MeetingMemoryDocument[]>
  read(input: { scope?: "repository" | "knowledge"; id: string }): Promise<MeetingMemoryDocument | undefined>
  apply(input: {
    scope: "repository" | "knowledge"
    id: string
    operation: "create" | "replace"
    content: string
    expectedRevision: string
  }): Promise<
    | { status: "applied"; revision: string; content: string }
    | { status: "stale"; error: string }
  >
}

type Scope = "repository" | "knowledge"

const maxConceptBytes = 65536
const lockFilename = "meeting-write.lock"
let chain: Promise<void> = Promise.resolve()

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

function validateConceptId(id: string): void {
  if (typeof id !== "string" || id.length === 0 || id.length > 200) throw new Error("Invalid concept ID")
  if (id.startsWith(".locks/") || id.startsWith("trash/")) throw new Error("Invalid concept ID")
  if (id === "index" || id === "log" || id === "graph" || id === "_meta") throw new Error("Invalid concept ID")
  const segments = id.split("/")
  const reserved = new Set(["index", "log", "_meta", "trash"])
  for (const segment of segments) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(segment)) throw new Error("Invalid concept ID")
    if (reserved.has(segment)) throw new Error("Invalid concept ID")
  }
}

function parseConceptMarkdown(id: string, content: string): { title?: string; type: string; tags?: string[] } {
  validateConceptId(id)
  if (typeof content !== "string") throw new Error("Invalid concept: content must be text")
  if (!content.isWellFormed()) throw new Error("Invalid concept: content must be valid UTF-8 text")
  if (Buffer.byteLength(content, "utf8") > maxConceptBytes) throw new Error("Invalid concept: content exceeds 65536 bytes")
  const text = content.replace(/^\uFEFF/, "")
  if (!/^---\r?\n/.test(text)) throw new Error("Invalid concept: require YAML frontmatter with a non-empty type")
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!match) throw new Error("Invalid concept: require YAML frontmatter with a non-empty type")
  let parsed: unknown
  try {
    parsed = Bun.YAML.parse(match[1])
  } catch {
    throw new Error("Invalid concept: require YAML frontmatter with a non-empty type")
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error("Invalid concept: require YAML frontmatter with a non-empty type")
  const typeValue = "type" in parsed ? parsed.type : undefined
  if (typeof typeValue !== "string" || !typeValue.trim()) throw new Error("Invalid concept: require YAML frontmatter with a non-empty type")
  const titleValue = "title" in parsed ? parsed.title : undefined
  const title = typeof titleValue === "string" && titleValue.length > 0 ? titleValue : undefined
  const tagsValue = "tags" in parsed ? parsed.tags : undefined
  let tags: string[] | undefined
  if (tagsValue !== undefined) {
    if (!Array.isArray(tagsValue) || tagsValue.some((item) => typeof item !== "string")) {
      throw new Error("Invalid concept: tags must be a string array")
    }
    tags = tagsValue.slice()
  }
  return { type: typeValue, ...(title ? { title } : {}), ...(tags ? { tags } : {}) }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT"
}

async function lstatOrUndefined(target: string) {
  try {
    return await fs.lstat(target)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

async function assertRootChain(base: string, root: string): Promise<boolean> {
  const baseStat = await lstatOrUndefined(base)
  if (baseStat) {
    if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) throw new Error("Unsafe memory path: symbolic links are not allowed")
    if ((await fs.realpath(base)) !== base) throw new Error("Unsafe memory path: symbolic links are not allowed")
  }
  const relative = path.relative(base, root)
  const parts = relative.split(path.sep).filter(Boolean)
  let current = base
  let exists = baseStat !== undefined
  for (const part of parts) {
    current = path.join(current, part)
    const stat = await lstatOrUndefined(current)
    if (!stat) {
      exists = false
      continue
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Unsafe memory path: symbolic links are not allowed")
    if ((await fs.realpath(current)) !== current) throw new Error("Unsafe memory path: symbolic links are not allowed")
    exists = true
  }
  return exists && relative.length > 0
}

async function assertExistingChain(base: string, root: string): Promise<void> {
  const relative = path.relative(base, root)
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Unsafe memory path")
  const targets = [base, root]
  for (const current of targets) {
    const stat = await lstatOrUndefined(current)
    if (!stat) continue
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Unsafe memory path: symbolic links are not allowed")
    if ((await fs.realpath(current)) !== current) throw new Error("Unsafe memory path: symbolic links are not allowed")
  }
}

async function ensureChain(base: string, root: string, includeRoot: boolean): Promise<void> {
  const relative = path.relative(base, root)
  const parts = relative.split(path.sep).filter(Boolean)
  const stops = includeRoot ? parts.length : parts.length - 1
  let current = base
  const ensureOne = async (target: string) => {
    const stat = await lstatOrUndefined(target)
    if (stat) {
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Unsafe memory path: symbolic links are not allowed")
      if ((await fs.realpath(target)) !== target) throw new Error("Unsafe memory path: symbolic links are not allowed")
      return
    }
    await fs.mkdir(target, { mode: 0o700 }).catch((error: unknown) => {
      if (errorCode(error) === "EEXIST") return
      throw error
    })
    const created = await fs.lstat(target)
    if (created.isSymbolicLink() || !created.isDirectory()) throw new Error("Unsafe memory path: symbolic links are not allowed")
    if ((await fs.realpath(target)) !== target) throw new Error("Unsafe memory path: symbolic links are not allowed")
  }
  const baseParts = base.split(path.sep).filter(Boolean)
  let ancestor = path.parse(base).root
  for (const part of baseParts) {
    ancestor = path.join(ancestor, part)
    await ensureOne(ancestor)
  }
  for (const part of parts.slice(0, stops)) {
    current = path.join(current, part)
    await ensureOne(current)
  }
  if (process.platform !== "win32") {
    await fs.chmod(base, 0o700).catch(() => undefined)
    let chmodCurrent = base
    for (const part of parts.slice(0, stops)) {
      chmodCurrent = path.join(chmodCurrent, part)
      await fs.chmod(chmodCurrent, 0o700).catch(() => undefined)
    }
  }
}

async function ensureDirectoryChain(base: string, root: string): Promise<void> {
  const relative = path.relative(base, root)
  const parts = relative.split(path.sep).filter(Boolean)
  let current = base
  for (const part of parts) {
    current = path.join(current, part)
    const stat = await lstatOrUndefined(current)
    if (stat) {
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Unsafe memory path: symbolic links are not allowed")
      if ((await fs.realpath(current)) !== current) throw new Error("Unsafe memory path: symbolic links are not allowed")
      continue
    }
    await fs.mkdir(current, { mode: 0o700 }).catch((error: unknown) => {
      if (errorCode(error) === "EEXIST") return
      throw error
    })
  }
}

async function assertSafeTarget(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target)
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Unsafe memory path")
  const rootStat = await lstatOrUndefined(root)
  if (!rootStat) throw new Error("Memory root is missing")
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("Unsafe memory path: symbolic links are not allowed")
  if ((await fs.realpath(root)) !== root) throw new Error("Unsafe memory path: symbolic links are not allowed")
  const parts = relative.split(path.sep).filter(Boolean)
  let current = root
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part)
    const stat = await lstatOrUndefined(current)
    if (!stat) continue
    if (stat.isSymbolicLink()) throw new Error("Unsafe memory path: symbolic links are not allowed")
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error("Unsafe memory path: symbolic links are not allowed")
    if ((await fs.realpath(current)) !== current) throw new Error("Unsafe memory path: symbolic links are not allowed")
  }
}

async function readBoundedFile(target: string): Promise<Uint8Array | undefined> {
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch((error: unknown) => {
    if (isMissing(error)) return undefined
    throw error
  })
  if (!handle) return undefined
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error("Unsafe memory path")
    if (stat.size > maxConceptBytes) throw new Error("Concept exceeds 65536 bytes")
    const buffer = Buffer.alloc(stat.size + 1)
    const result = await handle.read(buffer, 0, buffer.length, 0)
    if (result.bytesRead !== stat.size) throw new Error("Concept changed while reading")
    return buffer.subarray(0, result.bytesRead)
  } finally {
    await handle.close()
  }
}

function tokensOf(value: string): string[] {
  return value.toLowerCase().normalize("NFC").match(/[\p{L}\p{N}_-]{2,}/gu) ?? []
}

function commandStdout(args: string[], cwd: string): string | undefined {
  try {
    const result = Bun.spawnSync(args, { cwd })
    if (result.exitCode !== 0) return undefined
    return new TextDecoder().decode(result.stdout).trim()
  } catch {
    return undefined
  }
}

async function canonicalPath(target: string): Promise<string> {
  return fs.realpath(target).catch(async (error: unknown) => {
    if (!isMissing(error)) throw error
    return path.join(await canonicalPath(path.dirname(target)), path.basename(target))
  })
}

function resolveRepositoryCommon(directory: string): string | undefined {
  const fromGit = commandStdout(["git", "rev-parse", "--git-common-dir"], directory)
  if (fromGit) return path.isAbsolute(fromGit) ? fromGit : path.resolve(directory, fromGit)
  let current = directory
  for (;;) {
    const marker = path.join(current, ".git")
    try {
      const stat = lstatSync(marker)
      if (stat.isDirectory()) return marker
      if (stat.isFile()) {
        const text = readFileSync(marker, "utf8")
        const match = /^gitdir:\s*(.+)$/m.exec(text)
        if (match && match[1]) {
          const gitdir = match[1].trim()
          const resolved = path.isAbsolute(gitdir) ? gitdir : path.resolve(current, gitdir)
          const commondir = path.join(resolved, "commondir")
          try {
            const commonText = readFileSync(commondir, "utf8").trim()
            return path.isAbsolute(commonText) ? commonText : path.resolve(resolved, commonText)
          } catch {
            return resolved
          }
        }
      }
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return undefined
      current = parent
      continue
    }
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

export function createMeetingMemoryStore(options: { directory: string; dataHome?: string }): MeetingMemoryAdapter {
  const rawBase = path.join(options.dataHome ?? process.env.XDG_DATA_HOME ?? path.join(homedir(), ".local", "share"), "ycoding", "memory")
  let basePromise: Promise<string> | undefined
  const getBase = () => {
    if (!basePromise) basePromise = canonicalPath(rawBase)
    return basePromise
  }
  let cachedRepositoryRoot: string | undefined
  let repositoryResolved = false

  const repositoryRoot = async (): Promise<string | undefined> => {
    if (repositoryResolved) return cachedRepositoryRoot
    const common = resolveRepositoryCommon(options.directory)
    if (!common) {
      repositoryResolved = true
      cachedRepositoryRoot = undefined
      return undefined
    }
    try {
      const canonical = await canonicalPath(common)
      const key = `repo_${sha256Text(canonical)}`
      cachedRepositoryRoot = path.join(await getBase(), "repository", key)
    } catch {
      cachedRepositoryRoot = undefined
    }
    repositoryResolved = true
    return cachedRepositoryRoot
  }

  const rootFor = async (scope: Scope): Promise<string | undefined> => {
    if (scope === "knowledge") return path.join(await getBase(), "knowledge")
    return repositoryRoot()
  }

  const collect = async (root: string): Promise<MeetingMemoryDocument[]> => {
    const rootStat = await lstatOrUndefined(root)
    if (!rootStat) return []
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("Unsafe memory path")
    const documents: MeetingMemoryDocument[] = []
    const visit = async (directory: string): Promise<void> => {
      const stat = await fs.lstat(directory)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Unsafe memory path")
      const entries = await fs.readdir(directory, { withFileTypes: true })
      entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue
        if (entry.name === "index.md" || entry.name === "log.md" || entry.name === "graph.html" || entry.name === "_meta.json") continue
        if (entry.name === "trash" || entry.name === ".locks") continue
        const target = path.join(directory, entry.name)
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          await visit(target)
          continue
        }
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue
        const id = path.relative(root, target).split(path.sep).join("/").replace(/\.md$/, "")
        try {
          validateConceptId(id)
        } catch {
          continue
        }
        const bytes = await readBoundedFile(target).catch(() => undefined)
        if (!bytes) continue
        const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
        let meta: { title?: string; type: string; tags?: string[] }
        try {
          meta = parseConceptMarkdown(id, content)
        } catch {
          continue
        }
        documents.push({
          scope: "repository",
          id,
          revision: sha256(bytes),
          content,
          ...(meta.title ? { title: meta.title } : {}),
          type: meta.type,
          ...(meta.tags ? { tags: meta.tags } : {}),
        })
      }
    }
    await visit(root)
    return documents
  }

  const withWriteLock = async <T>(root: string, fn: () => Promise<T>): Promise<T> => {
    let releaseLocal: (() => void) | undefined
    const localGate = new Promise<void>((resolve) => {
      releaseLocal = resolve
    })
    const previous = chain
    chain = localGate
    await previous
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined
    try {
      await ensureChain(await getBase(), root, true)
      const lockDirectory = path.join(root, ".locks")
      await fs.mkdir(lockDirectory, { recursive: true, mode: 0o700 }).catch((error: unknown) => {
        if (errorCode(error) === "EEXIST") return
        throw error
      })
      await assertSafeTarget(root, lockDirectory)
      const lockPath = path.join(lockDirectory, lockFilename)
      const deadline = Date.now() + 5000
      for (;;) {
        try {
          handle = await fs.open(lockPath, "wx", 0o600)
          await handle.writeFile(`${process.pid}\n`)
          break
        } catch (error) {
          if (errorCode(error) !== "EEXIST") throw error
          if (Date.now() > deadline) throw new Error("Timed out acquiring memory write lock", { cause: error })
          const stat = await lstatOrUndefined(lockPath)
          if (stat && Date.now() - stat.mtimeMs > 10000) {
            const pidText = await fs.readFile(lockPath, "utf8").catch(() => "")
            const pid = Number.parseInt(pidText.trim(), 10)
            let alive = false
            if (Number.isSafeInteger(pid) && pid > 0) {
              try {
                process.kill(pid, 0)
                alive = true
              } catch {
                alive = false
              }
            }
            if (!alive || pid === process.pid) {
              await fs.rm(lockPath, { force: true })
              continue
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 15))
        }
      }
      return await fn()
    } finally {
      if (handle) {
        await handle.close().catch(() => undefined)
        await fs.rm(path.join(root, ".locks", lockFilename), { force: true }).catch(() => undefined)
      }
      if (releaseLocal) releaseLocal()
    }
  }

  return {
    async search(input) {
      const scope = input.scope ?? "repository"
      const tokens = [...new Set(tokensOf(input.query))]
      if (!tokens.length) return []
      const limit = input.limit ?? 5
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid search limit")
      const root = await rootFor(scope)
      if (!root) return []
      const base = await getBase()
      const exists = await assertRootChain(base, root).catch(() => {
        throw new Error("Unsafe memory path")
      })
      if (!exists) return []
      await assertExistingChain(base, root)
      const documents = await collect(root)
      const scored = documents
        .map((document) => {
          const titleText = (document.title ?? "").toLowerCase()
          const tagsText = (document.tags ?? []).join(" ").toLowerCase()
          const idText = document.id.toLowerCase()
          const bodyText = document.content.toLowerCase()
          let score = 0
          for (const token of tokens) {
            if (idText === token) score += 20
            else if (idText.includes(token)) score += 10
            if (titleText.includes(token)) score += 6
            if (tagsText.includes(token)) score += 8
            score += bodyText.split(token).length - 1
          }
          return { document: { ...document, scope }, score }
        })
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score || (left.document.id < right.document.id ? -1 : 1))
      return scored.slice(0, limit).map((item) => item.document)
    },

    async read(input) {
      const scope = input.scope ?? "repository"
      validateConceptId(input.id)
      const root = await rootFor(scope)
      if (!root) return undefined
      const target = path.join(root, `${input.id}.md`)
      const parent = path.dirname(target)
      const parentStat = await lstatOrUndefined(parent)
      if (!parentStat) return undefined
      if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw new Error("Unsafe memory path")
      const fileStat = await lstatOrUndefined(target)
      if (!fileStat) return undefined
      if (fileStat.isSymbolicLink() || !fileStat.isFile()) throw new Error("Unsafe memory path")
      await assertSafeTarget(root, target)
      const bytes = await readBoundedFile(target)
      if (!bytes) return undefined
      const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      const meta = parseConceptMarkdown(input.id, content)
      return {
        scope,
        id: input.id,
        revision: sha256(bytes),
        content,
        ...(meta.title ? { title: meta.title } : {}),
        type: meta.type,
        ...(meta.tags ? { tags: meta.tags } : {}),
      }
    },

    async apply(input) {
      validateConceptId(input.id)
      parseConceptMarkdown(input.id, input.content)
      if (input.operation === "create" && input.expectedRevision !== "new") {
        return { status: "stale", error: "Concept already exists; reconcile and review a replacement proposal" }
      }
      if (input.operation !== "create" && input.operation !== "replace") throw new Error("Invalid operation")
      const root = await rootFor(input.scope)
      if (!root) throw new Error("Repository memory requires a Git repository; use knowledge scope")
      return withWriteLock(root, async () => {
        const target = path.join(root, `${input.id}.md`)
        const parent = path.dirname(target)
        await ensureDirectoryChain(root, parent)
        await assertSafeTarget(root, parent)
        if (input.operation === "create") {
          const existing = await lstatOrUndefined(target)
          if (existing) {
            if (existing.isSymbolicLink()) throw new Error("Unsafe memory path")
            return { status: "stale", error: "Concept already exists; reconcile and review a replacement proposal" }
          }
        } else {
          const existing = await lstatOrUndefined(target)
          if (!existing) return { status: "stale", error: "Concept changed on disk; reconcile and review a fresh proposal" }
          if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("Unsafe memory path")
          const bytes = await readBoundedFile(target)
          if (!bytes) return { status: "stale", error: "Concept changed on disk; reconcile and review a fresh proposal" }
          if (sha256(bytes) !== input.expectedRevision) {
            return { status: "stale", error: "Concept changed on disk; reconcile and review a fresh proposal" }
          }
        }
        const temporary = path.join(parent, `.${randomUUID()}.tmp`)
        try {
          await fs.writeFile(temporary, input.content, { flag: "wx", mode: 0o600 })
          await fs.rename(temporary, target)
        } finally {
          await fs.rm(temporary, { force: true }).catch(() => undefined)
        }
        await assertSafeTarget(root, target)
        const verifiedBytes = await readBoundedFile(target)
        if (!verifiedBytes) throw new Error("Write verification failed")
        const verified = new TextDecoder("utf-8", { fatal: true }).decode(verifiedBytes)
        if (verified !== input.content) throw new Error("Write verification failed")
        const revision = sha256(verifiedBytes)
        if (revision !== sha256Text(input.content)) throw new Error("Write verification failed")
        return { status: "applied", revision, content: input.content }
      })
    },
  }
}
