import fs from "node:fs/promises"
import path from "node:path"
import type { MeetingMemoryAdapter } from "./knowledge-memory"

export interface RetrievedContextSource {
  kind: "segment" | "chat" | "skill" | "document" | "mcp" | "knowledge"
  id: string
  label?: string
}

export interface RetrievedSkillItem {
  id: string
  name: string
  description?: string
  excerpt: string
}

export interface RetrievedDocumentItem {
  path: string
  excerpt: string
}

export interface RetrievedKnowledgeItem {
  source: string
  id: string
  revision?: string
  excerpt: string
}

export interface RetrievedContextBundle {
  skills: RetrievedSkillItem[]
  documents: RetrievedDocumentItem[]
  knowledge: RetrievedKnowledgeItem[]
  sources: RetrievedContextSource[]
}

const skipDirectories = new Set([".git", "node_modules", "dist", "build", ".turbo", ".next", "coverage", "target", "vendor", ".venv"])
const documentExtensions = new Set([".md", ".mdx", ".txt"])
const maxScannedFiles = 120
const maxFileBytes = 262144
const maxExcerpt = 1200

function isSensitiveName(name: string): boolean {
  return /^\.env($|\.)/i.test(name) || /secret|credential|token|password|private[_-]?key|\.pem$|\.key$|\.sqlite$|\.db$/i.test(name)
}

function extractTerms(query: string, recentTranscriptText?: string): string[] {
  const combined = `${query} ${(recentTranscriptText ?? "").slice(0, 1500)}`
  const matches = combined.toLowerCase().normalize("NFC").match(/[\p{L}\p{N}_-]+/gu) ?? []
  const terms: string[] = []
  const seen = new Set<string>()
  for (const raw of matches) {
    const segments = raw.split("-").filter((part) => part.length >= 2)
    const candidates = segments.length > 1 ? [raw, ...segments] : [raw]
    for (const candidate of candidates) {
      if (candidate.length < 2) continue
      if (seen.has(candidate)) continue
      seen.add(candidate)
      terms.push(candidate)
      if (terms.length >= 80) return terms
    }
  }
  return terms
}

function scoreText(terms: readonly string[], text: string): number {
  const lower = text.toLowerCase()
  let score = 0
  for (const term of terms) {
    if (!lower.includes(term)) continue
    score += Math.min(lower.split(term).length - 1, 10)
  }
  return score
}

function bestWindow(terms: readonly string[], content: string, maxLength: number): string {
  if (content.length <= maxLength) return content
  const lower = content.toLowerCase()
  let bestIndex = 0
  let bestScore = -1
  const step = Math.max(1, Math.floor(maxLength / 2))
  for (let start = 0; start < content.length; start += step) {
    const window = lower.slice(start, start + maxLength)
    let score = 0
    for (const term of terms) {
      if (window.includes(term)) score += 1
    }
    if (score > bestScore) {
      bestScore = score
      bestIndex = start
    }
    if (start + maxLength >= content.length) break
  }
  let start = bestIndex
  if (start > 0) {
    const newline = content.indexOf("\n", start)
    if (newline !== -1 && newline - start < 200) start = newline + 1
  }
  return content.slice(start, start + maxLength)
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function relativePosix(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/")
}

export function createContextRetriever(options: {
  directory: string
  listSkills?: () => Promise<ReadonlyArray<{ id: string; name: string; description?: string; content: string }>>
  listReferences?: () => Promise<ReadonlyArray<{ name?: string; path?: string; content?: string }>>
  memory?: MeetingMemoryAdapter
  retrieveMCP?: (query: string) => Promise<ReadonlyArray<{ server: string; target: string; revision: string; content: string }>>
}) {
  const retrieve = async (input: {
    query: string
    recentTranscriptText?: string
    maxCharacters?: number
  }): Promise<RetrievedContextBundle> => {
    const maxCharacters = input.maxCharacters ?? 8000
    const terms = extractTerms(input.query, input.recentTranscriptText)
    const sources: RetrievedContextSource[] = []

    let skills: RetrievedSkillItem[] = []
    if (options.listSkills && terms.length) {
      const listed = await options.listSkills().catch(() => [])
      skills = listed
        .map((skill) => {
          const score =
            scoreText(terms, skill.id) * 10 +
            scoreText(terms, skill.name) * 8 +
            scoreText(terms, skill.description ?? "") * 6 +
            scoreText(terms, skill.content)
          return { skill, score }
        })
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score || (left.skill.id < right.skill.id ? -1 : 1))
        .slice(0, 2)
        .map((item) => ({
          id: item.skill.id,
          name: item.skill.name,
          ...(item.skill.description ? { description: item.skill.description } : {}),
          excerpt: bestWindow(terms, item.skill.content, maxExcerpt),
        }))
      for (const skill of skills) sources.push({ kind: "skill", id: skill.id, label: skill.name })
    }

    let rootReal = ""
    try {
      rootReal = await fs.realpath(options.directory)
    } catch {
      rootReal = ""
    }

    const candidates = new Map<string, { absPath?: string; rel: string; content?: string; priority: number }>()

    if (rootReal) {
      const visited: string[] = []
      const queue: string[] = [rootReal]
      while (queue.length) {
        const directory = queue.shift()!
        const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
        entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
        for (const entry of entries) {
          const target = path.join(directory, entry.name)
          if (entry.isSymbolicLink()) {
            if (entry.isDirectory() || entry.name.endsWith(".md") || entry.name.endsWith(".txt")) {
              const resolved = await fs.realpath(target).catch(() => undefined)
              if (!resolved || !isInside(rootReal, resolved)) continue
            }
            continue
          }
          if (entry.isDirectory()) {
            if (skipDirectories.has(entry.name)) continue
            if (entry.name.startsWith(".")) continue
            queue.push(target)
            continue
          }
          if (!entry.isFile()) continue
          visited.push(target)
        }
      }
      visited.sort((left, right) => {
        const leftRel = relativePosix(rootReal, left)
        const rightRel = relativePosix(rootReal, right)
        const rank = (rel: string) => {
          if (/(^|\/)readme\.md$/i.test(rel)) return 0
          if (rel.startsWith("docs/")) return 1
          if (rel.startsWith("specs/")) return 2
          return 3
        }
        return rank(leftRel) - rank(rightRel) || (leftRel < rightRel ? -1 : 1)
      })
      let scanned = 0
      for (const target of visited) {
        if (scanned >= maxScannedFiles) break
        const rel = relativePosix(rootReal, target)
        const name = path.basename(target)
        if (isSensitiveName(name)) continue
        if (!documentExtensions.has(path.extname(name).toLowerCase())) continue
        scanned++
        const priority = /(^|\/)readme\.md$/i.test(rel) ? 5 : rel.startsWith("docs/") || rel.startsWith("specs/") ? 3 : 0
        candidates.set(rel, { absPath: target, rel, priority })
      }
    }

    if (options.listReferences) {
      const references = await options.listReferences().catch(() => [])
      for (const reference of references) {
        if (reference.path) {
          const name = path.basename(reference.path)
          if (isSensitiveName(name)) continue
          if (!documentExtensions.has(path.extname(name).toLowerCase())) continue
          if (!rootReal) continue
          const absolute = path.isAbsolute(reference.path) ? reference.path : path.resolve(rootReal, reference.path)
          const resolved = await fs.realpath(absolute).catch(() => undefined)
          if (!resolved || !isInside(rootReal, resolved) || resolved === rootReal) continue
          const rel = relativePosix(rootReal, resolved)
          if (!rel || rel.startsWith("..")) continue
          if (isSensitiveName(path.basename(resolved))) continue
          const stat = await fs.lstat(resolved).catch(() => undefined)
          if (!stat || stat.isSymbolicLink() || !stat.isFile()) continue
          const chunks = rel.split("/")
          if (chunks.some((chunk) => skipDirectories.has(chunk))) continue
          candidates.set(rel, { absPath: resolved, rel, priority: 4 })
          continue
        }
        if (reference.content !== undefined) {
          const label = reference.name ?? "reference"
          if (isSensitiveName(label)) continue
          const rel = label.split(path.sep).join("/")
          if (!candidates.has(rel)) candidates.set(rel, { rel, content: reference.content, priority: 4 })
        }
      }
    }

    let documents: RetrievedDocumentItem[] = []
    if (terms.length && candidates.size) {
      const scored: { rel: string; excerpt: string; score: number; priority: number }[] = []
      for (const candidate of candidates.values()) {
        let content = candidate.content
        if (content === undefined && candidate.absPath) {
          if (!rootReal) continue
          const resolved = await fs.realpath(candidate.absPath).catch(() => undefined)
          if (!resolved || !isInside(rootReal, resolved)) continue
          const stat = await fs.lstat(resolved).catch(() => undefined)
          if (!stat || stat.isSymbolicLink() || !stat.isFile()) continue
          if (stat.size > maxFileBytes) continue
          content = await fs.readFile(resolved, "utf8").catch(() => undefined)
          if (content === undefined) continue
          if (Buffer.byteLength(content, "utf8") > maxFileBytes) continue
        }
        if (content === undefined) continue
        const score = scoreText(terms, candidate.rel) * 5 + scoreText(terms, content) + candidate.priority
        if (score <= candidate.priority) continue
        if (scoreText(terms, candidate.rel) === 0 && scoreText(terms, content) === 0) continue
        scored.push({ rel: candidate.rel, excerpt: bestWindow(terms, content, maxExcerpt), score, priority: candidate.priority })
      }
      scored.sort((left, right) => right.score - left.score || (left.rel < right.rel ? -1 : 1))
      documents = scored.slice(0, 3).map((item) => ({ path: item.rel, excerpt: item.excerpt }))
      for (const document of documents) sources.push({ kind: "document", id: document.path, label: document.path })
    }

    let knowledge: RetrievedKnowledgeItem[] = []
    if (options.memory && terms.length) {
      const seen = new Set<string>()
      const queryText = input.query
      for (const scope of ["repository", "knowledge"] as const) {
        const docs = await options.memory.search({ scope, query: queryText, limit: 2 }).catch(() => [])
        for (const doc of docs) {
          const source = `${doc.scope}:${doc.id}`
          if (seen.has(source)) continue
          seen.add(source)
          knowledge.push({
            source,
            id: doc.id,
            ...(doc.revision ? { revision: doc.revision } : {}),
            excerpt: bestWindow(terms, doc.content, maxExcerpt),
          })
          sources.push({ kind: "knowledge", id: source, label: doc.title ?? doc.id })
        }
      }
    }

    if (options.retrieveMCP && terms.length) {
      const refs = await options.retrieveMCP(input.query.slice(0, 512)).catch(() => [])
      for (const ref of refs.slice(0, 3)) {
        knowledge.push({
          source: `${ref.server}:${ref.target}`,
          id: ref.target,
          revision: ref.revision,
          excerpt: bestWindow(terms, ref.content, maxExcerpt),
        })
        sources.push({ kind: "mcp", id: `${ref.server}:${ref.target}`, label: ref.target })
      }
    }

    if (skills.length || documents.length || knowledge.length) {
      for (;;) {
        const serialized = JSON.stringify({ skills, documents, knowledge, sources })
        if (serialized.length <= maxCharacters) break
        const beforeLength = skills.length + documents.length + knowledge.length
        if (knowledge.length > 2) {
          const removed = knowledge.pop()!
          const index = sources.findIndex((source) => source.id === removed.source)
          if (index !== -1) sources.splice(index, 1)
        } else if (knowledge.length) {
          const removed = knowledge.pop()!
          const index = sources.findIndex((source) => source.id === removed.source)
          if (index !== -1) sources.splice(index, 1)
        } else if (documents.length) {
          const removed = documents.pop()!
          const index = sources.findIndex((source) => source.kind === "document" && source.id === removed.path)
          if (index !== -1) sources.splice(index, 1)
        } else if (skills.length) {
          const removed = skills.pop()!
          const index = sources.findIndex((source) => source.kind === "skill" && source.id === removed.id)
          if (index !== -1) sources.splice(index, 1)
        }
        if (skills.length + documents.length + knowledge.length === beforeLength) break
        if (!skills.length && !documents.length && !knowledge.length) {
          sources.length = 0
          if (JSON.stringify({ skills, documents, knowledge, sources }).length <= maxCharacters) break
          break
        }
      }
    }

    return { skills, documents, knowledge, sources }
  }

  return { retrieve }
}
