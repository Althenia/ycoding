// Per-model prompt-cache master data.
//
// Two facts about a model decide how the cache policy and the diagnostics
// should behave, and neither is discoverable from the wire:
//
//   - `minimumTokens` — the shortest prefix a provider will cache. Below it a
//     `cache_control` / `cachePoint` marker is accepted and then silently
//     ignored: no error, no write charge, and a permanent 0% hit ratio that
//     otherwise looks like a broken cache.
//   - `extendedTtl` — whether the model honors the 1-hour bucket. Only the
//     Anthropic family does; everything else has a fixed provider-side window.
//
// Sources: Anthropic's prompt-caching reference (minimum cacheable prompt
// length per model, and 1h TTL availability) and OpenAI's / Google's caching
// guides for the implicit-cache families.

/** Prompt-cache characteristics of one model family. */
export interface CacheProfile {
  /** Shortest prefix the provider will cache. Shorter prefixes never cache. */
  readonly minimumTokens: number
  /** Whether the model accepts the 1-hour cache bucket. */
  readonly extendedTtl: boolean
}

const anthropic = (minimumTokens: number): CacheProfile => ({ minimumTokens, extendedTtl: true })
const implicit = (minimumTokens: number): CacheProfile => ({ minimumTokens, extendedTtl: false })

// Keyed by normalized family prefix — see `normalizeCacheModelID`. Lookup takes
// the longest matching key so `claude-opus-4-8` never falls back to the
// `claude-opus-4` entry, which has a different minimum.
const PROFILES: Record<string, CacheProfile> = {
  // Anthropic — 512
  "claude-opus-5": anthropic(512),
  "claude-fable-5": anthropic(512),
  "claude-mythos-5": anthropic(512),
  // Anthropic — 1024
  "claude-opus-4-8": anthropic(1024),
  "claude-opus-4-1": anthropic(1024),
  "claude-opus-4": anthropic(1024),
  "claude-sonnet-5": anthropic(1024),
  "claude-sonnet-4-6": anthropic(1024),
  "claude-sonnet-4-5": anthropic(1024),
  "claude-sonnet-4": anthropic(1024),
  "claude-3-5-sonnet": anthropic(1024),
  // Anthropic — 2048
  "claude-opus-4-7": anthropic(2048),
  "claude-mythos-preview": anthropic(2048),
  "claude-3-5-haiku": anthropic(2048),
  // Anthropic — 4096
  "claude-opus-4-6": anthropic(4096),
  "claude-opus-4-5": anthropic(4096),
  "claude-haiku-4-5": anthropic(4096),
  // Implicit-prefix families. No inline markers are emitted for these, but the
  // minimum still explains a flat 0% ratio on a short prefix.
  // OpenAI explicit per-model entries ensure early cache start is calculated and
  // maintained per model namespace. The generic gpt- prefix remains as fallback
  // for future models.
  "gpt-5-6": implicit(1024),
  "gpt-5": implicit(1024),
  "gpt-5-mini": implicit(1024),
  "gpt-5-nano": implicit(1024),
  "gpt-4o": implicit(1024),
  "gpt-4o-mini": implicit(1024),
  "gpt-4-1": implicit(1024),
  "gpt-4-1-mini": implicit(1024),
  "gpt-4-turbo": implicit(1024),
  "gpt-3-5-turbo": implicit(1024),
  "gpt-": implicit(1024),
  o1: implicit(1024),
  o3: implicit(1024),
  o4: implicit(1024),
  "gemini-2-5-pro": implicit(4096),
  "gemini-2-5-flash": implicit(1024),
  "gemini-3-pro": implicit(4096),
  "gemini-3-flash": implicit(1024),
  // Meta Llama 4 family — implicit cache, per-model namespace like OpenAI
  "llama-4-maverick": implicit(1024),
  "llama-4-scout": implicit(1024),
  "llama-4-behemoth": implicit(1024),
  "llama-3-3": implicit(1024),
  "llama-3-2": implicit(1024),
}

// Longest key first so prefix matching is unambiguous regardless of insertion
// order. Computed once — the table is static.
const KEYS = Object.keys(PROFILES).toSorted((left, right) => right.length - left.length)

// Vendor qualifiers Bedrock and OpenRouter prepend, optionally behind a
// cross-region inference geo prefix (`us.`, `eu.`, `apac.`).
const VENDOR_PREFIX = /^(?:[a-z]{2,4}\.)?(?:anthropic|amazon|meta|mistral|google|openai)[./]/
// Bedrock model-version suffix (`-v2:0`), Vertex snapshot separator (`@date`),
// and the dated-snapshot suffix every platform uses.
const VERSION_SUFFIX = /-v\d+:\d+$/
const SNAPSHOT_SUFFIX = /-\d{6,8}$/
const ALIASES: Readonly<Record<string, string>> = {
  "claude-4-sonnet": "claude-sonnet-4",
}

/**
 * Reduce a platform-qualified model id to the bare family id used as a profile
 * key. Handles OpenRouter (`anthropic/claude-sonnet-4.6`), Bedrock
 * (`us.anthropic.claude-opus-4-8`, `…-v2:0`), Vertex (`…@20251101`), and dated
 * snapshots (`…-20251001`).
 */
export const normalizeCacheModelID = (modelID: string): string => {
  let id = modelID.toLowerCase().trim()
  id = id.replace(/^anthropic--/, "")
  id = id.replace(VENDOR_PREFIX, "")
  // A remaining slash means a vendor we do not enumerate — keep the last
  // segment, which is still the model id.
  const slash = id.lastIndexOf("/")
  if (slash !== -1) id = id.slice(slash + 1)
  const at = id.indexOf("@")
  if (at !== -1) id = id.slice(0, at)
  id = id.replace(VERSION_SUFFIX, "")
  id = id.replace(SNAPSHOT_SUFFIX, "")
  if (id.endsWith("-latest")) id = id.slice(0, -"-latest".length)
  // Vendors disagree on whether a minor version is dotted or dashed.
  id = id.replaceAll(".", "-")
  return ALIASES[id] ?? id
}

/**
 * Prompt-cache profile for a model, or `undefined` when no profile is
 * published. Callers must treat `undefined` as "assume nothing" — in
 * particular, never assume the 1-hour bucket is available.
 */
export const cacheProfile = (modelID: string): CacheProfile | undefined => {
  const id = normalizeCacheModelID(modelID)
  const key = KEYS.find((candidate) => id.startsWith(candidate))
  return key === undefined ? undefined : PROFILES[key]
}
