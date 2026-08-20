// Apply an `LLMRequest.cache` policy by injecting `CacheHint`s onto the parts
// the policy designates. Runs once at compile time, before the per-protocol
// body builder, so the existing inline-hint lowering path handles the rest.
//
// The default `"auto"` shape places one breakpoint at the last tool definition,
// one at the last system part, and one at each of the two most recent cacheable
// messages — four in total, which is exactly the per-request cap.
//
// The two buckets are split by lifetime: tools and the system prompt are fixed
// for the whole session and go in the 1-hour bucket where the model supports
// it, while the message anchors roll forward every turn and stay on 5 minutes.
// Wire order (tools → system → messages) is also the ordering the API requires,
// since every 1h breakpoint must precede every 5m one.
//
// Manual `cache: CacheHint` placements on individual parts are preserved —
// this function only fills gaps the caller left empty.
import { cacheProfile } from "./cache-profile"
import { CacheHint, type CachePolicy, type CachePolicyObject } from "./schema/options"
import { LLMRequest, Message, ToolDefinition, type ContentPart, type ToolContent } from "./schema/messages"
import { OpenAIOptions } from "./protocols/utils/openai-options"

export const CACHE_POLICY_REVISION = "provider-native/v7"
export const OPENAI_PROMPT_CACHE_READ_CANDIDATE_LIMIT = 50

const AUTO: CachePolicyObject = {
  tools: true,
  system: true,
  messages: { tail: 1 },
}

const NONE: CachePolicyObject = {}

// Resolution rules:
//   - undefined   → "auto" — caching is on by default. The math favors it:
//                   Anthropic 5m-cache write is 1.25x base, read is 0.1x,
//                   so a single reuse within 5 minutes already wins.
//   - "auto"      → tools + system + latest cacheable message.
//   - "none"      → no auto placement; manual `CacheHint`s still flow.
//   - object form → exactly what the caller asked for.
const resolve = (policy: CachePolicy | undefined): CachePolicyObject => {
  if (policy === undefined || policy === "auto") return AUTO
  if (policy === "none") return NONE
  return policy
}

// Protocols whose wire format ignores inline cache markers (older OpenAI
// models and Gemini's implicit + out-of-band CachedContent). AI SDK routes
// retain their generic protocol ID, so cache-capable adapters must also opt in
// by route ID or the default policy never reaches their provider options.
const RESPECTS_INLINE_HINTS = new Set(["anthropic-messages", "bedrock-converse"])
const INLINE_HINT_ROUTES = new Set([
  "ai-sdk:@ai-sdk/anthropic",
  "ai-sdk:@ai-sdk/google-vertex/anthropic",
  "ai-sdk:@openrouter/ai-sdk-provider",
  "ai-sdk:@ai-sdk/amazon-bedrock",
  "openrouter-responses",
  "ai-sdk:@openrouter/ai-sdk-provider:responses",
])
const INLINE_HINT_CAP = 4
const EXTENDED_TTL_SECONDS = 3600

const respectsInlineHints = (request: LLMRequest) =>
  RESPECTS_INLINE_HINTS.has(request.model.route.protocol) ||
  INLINE_HINT_ROUTES.has(request.model.route.id) ||
  (OpenAIOptions.supportsPromptCacheBreakpoints(request.model.route.id, request.model.id) &&
    (request.model.route.id === "openai-codex-responses" || OpenAIOptions.promptCacheOptions(request) !== undefined))

const makeHint = (ttlSeconds: number | undefined): CacheHint =>
  ttlSeconds !== undefined ? new CacheHint({ type: "ephemeral", ttlSeconds }) : new CacheHint({ type: "ephemeral" })

// Routes that place breakpoints themselves once the request opts in. OpenRouter
// exposes an OpenAI-compatible surface, so inline markers can only ride on
// `system`/`user` content arrays — never on the `tool` messages an agent loop
// spends most of its tokens on. Marking only the system turn would pin the
// static prefix and leave the growing tool-result tail uncached on every step,
// so we hand placement to OpenRouter's own top-level switch instead.
const AUTO_PLACEMENT_ROUTES = new Set(["openrouter", "openrouter-responses"])

/**
 * Resolve the cache hint a provider-placed route should advertise, or
 * `undefined` when the route places markers inline or the policy is off.
 * Protocol builders translate the hint into their own wire switch.
 */
export const autoPlacementHint = (request: LLMRequest): CacheHint | undefined => {
  if (!AUTO_PLACEMENT_ROUTES.has(request.model.route.id)) return undefined
  const policy = resolve(request.cache)
  if (!policy.tools && !policy.system && !policy.messages) return undefined
  return makeHint(policy.ttlSeconds)
}

type HintPosition = readonly [section: number, item: number, part: number]

interface ManualHint {
  readonly hint: CacheHint
  readonly position: HintPosition
}

// Section numbers preserve provider wire order: tools → system → messages.
const comparePosition = (left: HintPosition, right: HintPosition) =>
  left[0] - right[0] || left[1] - right[1] || left[2] - right[2]

const isOneHour = (hint: CacheHint) => hint.ttlSeconds !== undefined && hint.ttlSeconds >= 3600

const manualHints = (request: LLMRequest): ReadonlyArray<ManualHint> => [
  ...request.tools.flatMap((tool, item) => (tool.cache ? [{ hint: tool.cache, position: [0, item, 0] as const }] : [])),
  ...request.system.flatMap((part, item) =>
    part.cache ? [{ hint: part.cache, position: [1, item, 0] as const }] : [],
  ),
  ...request.messages.flatMap((message, item) =>
    message.content.flatMap((part, index) => {
      const hint = "cache" in part ? part.cache : undefined
      return hint ? [{ hint, position: [2, item, index] as const }] : []
    }),
  ),
]

const coordinateAutoHints = (request: LLMRequest) => {
  if (OpenAIOptions.supportsPromptCacheBreakpoints(request.model.route.id, request.model.id))
    return () => true
  const manual = manualHints(request)
  const state = { remaining: Math.max(0, INLINE_HINT_CAP - manual.length) }
  return (position: HintPosition, hint: CacheHint) => {
    if (state.remaining <= 0) return false
    const conflicts = isOneHour(hint)
      ? manual.some((entry) => !isOneHour(entry.hint) && comparePosition(entry.position, position) < 0)
      : manual.some((entry) => isOneHour(entry.hint) && comparePosition(entry.position, position) > 0)
    if (conflicts) return false
    state.remaining -= 1
    return true
  }
}

const markLastTool = (
  tools: ReadonlyArray<ToolDefinition>,
  hint: CacheHint,
  reserve: (position: HintPosition, hint: CacheHint) => boolean,
): ReadonlyArray<ToolDefinition> => {
  if (tools.length === 0) return tools
  const last = tools.length - 1
  if (tools[last]!.cache || !reserve([0, last, 0], hint)) return tools
  return tools.map((tool, i) => (i === last ? new ToolDefinition({ ...tool, cache: hint }) : tool))
}

const markLastSystem = (
  system: LLMRequest["system"],
  hint: CacheHint,
  reserve: (position: HintPosition, hint: CacheHint) => boolean,
): LLMRequest["system"] => {
  const last = system.findLastIndex((part) => part.text.trim().length > 0)
  if (last < 0 || system[last]!.cache || !reserve([1, last, 0], hint)) return system
  return system.map((part, i) => (i === last ? { ...part, cache: hint } : part))
}

const lastIndexOfRole = (messages: ReadonlyArray<Message>, role: Message["role"]): number =>
  messages.findLastIndex((m) => m.role === role && m.volatile !== true)

const isMarkablePart = (part: ContentPart) =>
  (part.type === "text" && part.text.trim().length > 0) || part.type === "tool-result"

const isGpt56MarkablePart = (part: ContentPart) => {
  if (part.type === "text") return part.text.trim().length > 0
  if (part.type !== "tool-result" || part.providerExecuted === true) return false
  if (part.result.type === "content")
    return part.result.value.some((item: ToolContent) => item.type === "text" && item.text.trim().length > 0)
  if (part.result.type === "text" || part.result.type === "error") return String(part.result.value).trim().length > 0
  return true
}

type Gpt56MarkerRole = "user" | "assistant" | "tool"
type Gpt56MarkerRoles = ReadonlyArray<Gpt56MarkerRole> | undefined
const isGpt56MarkerRole = (role: Message["role"]): role is Gpt56MarkerRole =>
  role === "user" || role === "assistant" || role === "tool"

// Anthropic and Bedrock check at most 20 block positions per breakpoint when
// hunting for a prior cache entry. A single trailing anchor therefore finds
// nothing whenever one agent turn appends more than that — a parallel tool-call
// fan-out emits a tool_use and a tool_result block per call — and the whole
// prefix is re-billed. Anchoring the two most recent cacheable messages keeps an
// older breakpoint within reach of the previous turn's anchor.
//
// The second anchor is free: the API bills by segment between breakpoints, not
// per breakpoint, so an extra marker inside the same span adds no write cost.
const AUTO_MESSAGE_ANCHORS = 2

const lastMarkableMessages = (
  messages: ReadonlyArray<Message>,
  count: number,
  gpt56Roles: Gpt56MarkerRoles = undefined,
) => {
  const found: number[] = []
  for (let index = messages.length - 1; index >= 0 && found.length < count; index--) {
    const message = messages[index]!
    if (
      message.volatile !== true &&
      (gpt56Roles === undefined || (isGpt56MarkerRole(message.role) && gpt56Roles.includes(message.role))) &&
      message.content.some(gpt56Roles === undefined ? isMarkablePart : isGpt56MarkablePart)
    )
      found.push(index)
  }
  return found.reverse()
}

const firstMarkableMessages = (
  messages: ReadonlyArray<Message>,
  count: number,
  gpt56Roles: Gpt56MarkerRoles = undefined,
) => {
  const found: number[] = []
  for (let index = 0; index < messages.length && found.length < count; index++) {
    const message = messages[index]!
    if (
      message.volatile !== true &&
      (gpt56Roles === undefined || (isGpt56MarkerRole(message.role) && gpt56Roles.includes(message.role))) &&
      message.content.some(gpt56Roles === undefined ? isMarkablePart : isGpt56MarkablePart)
    )
      found.push(index)
  }
  return found
}

// Mark the last non-empty text or tool-result part of one message. Other part
// types do not expose a cache field in the canonical schema and empty text
// markers are rejected by Anthropic-compatible APIs.
const markMessage = (
  target: Message,
  index: number,
  hint: CacheHint,
  reserve: (position: HintPosition, hint: CacheHint) => boolean,
  gpt56Roles: Gpt56MarkerRoles = undefined,
): Message => {
  // Volatile messages are regenerated per request; a breakpoint on one would be
  // invalidated on the next request and would void the prefix behind it.
  if (target.volatile || target.content.length === 0) return target
  if (gpt56Roles !== undefined && (!isGpt56MarkerRole(target.role) || !gpt56Roles.includes(target.role))) return target
  const markAt = target.content.findLastIndex(gpt56Roles === undefined ? isMarkablePart : isGpt56MarkablePart)
  if (markAt < 0) return target
  const existing = target.content[markAt]!
  if (("cache" in existing && existing.cache) || !reserve([2, index, markAt], hint)) return target
  const nextContent = target.content.map((part, i) => (i === markAt ? ({ ...part, cache: hint } as ContentPart) : part))
  return new Message({ ...target, content: nextContent })
}

const markMessageAt = (
  messages: ReadonlyArray<Message>,
  index: number,
  hint: CacheHint,
  reserve: (position: HintPosition, hint: CacheHint) => boolean,
  gpt56Roles: Gpt56MarkerRoles = undefined,
): ReadonlyArray<Message> => {
  if (index < 0 || index >= messages.length) return messages
  const nextMessage = markMessage(messages[index]!, index, hint, reserve, gpt56Roles)
  if (nextMessage === messages[index]) return messages
  const result = messages.slice()
  result[index] = nextMessage
  return result
}

const markAutoMessages = (
  messages: ReadonlyArray<Message>,
  anchors: number,
  hint: CacheHint,
  reserve: (position: HintPosition, hint: CacheHint) => boolean,
  gpt56Roles: Gpt56MarkerRoles = undefined,
): ReadonlyArray<Message> => {
  let next: Message[] | undefined
  // Ascending so the budget is spent in wire order: when manual hints leave
  // fewer slots than requested, the older anchor survives and the tail is shed.
  for (const index of lastMarkableMessages(messages, anchors, gpt56Roles)) {
    const current = (next ?? messages)[index]!
    const marked = markMessage(current, index, hint, reserve, gpt56Roles)
    if (marked === current) continue
    next ??= messages.slice()
    next[index] = marked
  }
  return next ?? messages
}

const markMessages = (
  messages: ReadonlyArray<Message>,
  strategy: NonNullable<CachePolicyObject["messages"]>,
  hint: CacheHint,
  reserve: (position: HintPosition, hint: CacheHint) => boolean,
  gpt56Roles: Gpt56MarkerRoles = undefined,
  gpt56Limit = Number.MAX_SAFE_INTEGER,
): ReadonlyArray<Message> => {
  if (messages.length === 0) return messages
  if (strategy === "latest-user-message")
    return markMessageAt(messages, lastIndexOfRole(messages, "user"), hint, reserve, gpt56Roles)
  if (strategy === "latest-assistant")
    return markMessageAt(messages, lastIndexOfRole(messages, "assistant"), hint, reserve, gpt56Roles)
  if (gpt56Roles !== undefined) {
    const limit = Math.min(strategy.tail, gpt56Limit)
    if (limit <= 0) return messages
    // Keep the stable earliest prefix breakpoint within the 50-window even after
    // history grows beyond the provider read limit. Without this, newest-only
    // selection evicts the early prefix and the hit drops to 0-20% and stays
    // poisoned (generation is now stable at 0). Reserve up to 2 slots for the
    // earliest markable messages to ensure the combined system + early prefix
    // exceeds the provider's 1024-token minimum and remains cacheable; fill the
    // remainder with the newest tail. Mainchat with 186k history was hitting
    // 0-35% because a single early message (often <1024 tokens) was not
    // cacheable, while short subagent histories stayed below the 50 limit and
    // kept 80-100% hits.
    const prefixReserve =
      limit > 2 && limit === gpt56Limit && messages.length > gpt56Limit ? 2 : limit > 1 && messages.length > gpt56Limit ? 1 : 0
    const tailCount = limit - prefixReserve
    const prefixIndices = prefixReserve > 0 ? firstMarkableMessages(messages, prefixReserve, gpt56Roles) : []
    const tailIndices = lastMarkableMessages(messages, tailCount, gpt56Roles)
    const combined = [...new Set([...prefixIndices, ...tailIndices])].sort((a, b) => a - b)
    let next: Message[] | undefined
    for (const index of combined) {
      const current = (next ?? messages)[index]!
      const marked = markMessage(current, index, hint, reserve, gpt56Roles)
      if (marked === current) continue
      next ??= messages.slice()
      next[index] = marked
    }
    return next ?? messages
  }
  let next: Message[] | undefined
  for (const index of lastMarkableMessages(messages, strategy.tail)) {
    const current = (next ?? messages)[index]!
    const marked = markMessage(current, index, hint, reserve, gpt56Roles)
    if (marked === current) continue
    next ??= messages.slice()
    next[index] = marked
  }
  return next ?? messages
}

// Manual hints share OpenAI's read window with generated hints. Keep the stable
// earliest prefix within the 50 window plus the newest tail, evicting the middle
// when over limit. Previously only the newest were kept, so after history >50
// the early prefix (system + first user) was evicted and the hit dropped to
// 0-20% with no recovery (generation is now stable at 0).
const boundGpt56Messages = (messages: ReadonlyArray<Message>, limit: number): ReadonlyArray<Message> => {
  if (limit <= 0) {
    let next: Message[] | undefined
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
      const message = messages[messageIndex]!
      if (!isGpt56MarkerRole(message.role)) continue
      let content: ContentPart[] | undefined
      for (let partIndex = 0; partIndex < message.content.length; partIndex++) {
        const part = message.content[partIndex]!
        if (!("cache" in part) || !part.cache || (part.type !== "text" && !isGpt56MarkablePart(part))) continue
        content ??= message.content.slice()
        content[partIndex] = { ...part, cache: undefined } as ContentPart
      }
      if (!content) continue
      next ??= messages.slice()
      next[messageIndex] = new Message({ ...message, content })
    }
    return next ?? messages
  }
  const positions: Array<{ readonly m: number; readonly p: number }> = []
  for (let m = 0; m < messages.length; m++) {
    const message = messages[m]!
    if (!isGpt56MarkerRole(message.role)) continue
    for (let p = 0; p < message.content.length; p++) {
      const part = message.content[p]!
      if (!("cache" in part) || !part.cache || (part.type !== "text" && !isGpt56MarkablePart(part))) continue
      positions.push({ m, p })
    }
  }
  if (positions.length <= limit) return messages
  const prefixReserve = limit > 2 ? 2 : limit > 1 ? 1 : 0
  const keep = new Set<string>()
  for (let i = 0; i < Math.min(prefixReserve, positions.length); i++) keep.add(`${positions[i]!.m}:${positions[i]!.p}`)
  const tailKeep = limit - prefixReserve
  for (let i = positions.length - tailKeep; i < positions.length; i++) {
    if (i < prefixReserve) continue
    keep.add(`${positions[i]!.m}:${positions[i]!.p}`)
  }
  let next: Message[] | undefined
  for (let m = 0; m < messages.length; m++) {
    const message = messages[m]!
    if (!isGpt56MarkerRole(message.role)) continue
    const rebuilt = message.content.map((part, p) => {
      if (!("cache" in part) || !part.cache || (part.type !== "text" && !isGpt56MarkablePart(part))) return part
      return keep.has(`${m}:${p}`) ? part : ({ ...part, cache: undefined } as ContentPart)
    })
    const changed = rebuilt.some((part, idx) => part !== message.content[idx])
    if (!changed) continue
    next ??= messages.slice()
    next[m] = new Message({ ...message, content: rebuilt })
  }
  return next ?? messages
}

export const applyCachePolicy = (request: LLMRequest): LLMRequest => {
  if (!respectsInlineHints(request)) return request
  const policy = resolve(request.cache)
  const auto = request.cache === undefined || request.cache === "auto"
  const gpt56 = OpenAIOptions.supportsPromptCacheBreakpoints(request.model.route.id, request.model.id)
  if (!policy.tools && !policy.system && !policy.messages && !gpt56) return request

  // `auto` splits buckets by lifetime; an explicit policy is taken literally, so
  // its `ttlSeconds` (or the 5m default) applies to every breakpoint it places.
  const tailHint = makeHint(policy.ttlSeconds)
  const prefixHint = auto && cacheProfile(request.model.id)?.extendedTtl ? makeHint(EXTENDED_TTL_SECONDS) : tailHint
  const reserve = coordinateAutoHints(request)
  // Responses accepts breakpoints on input blocks only; assistant replay uses
  // output_text. Chat uses text blocks for both directions and can mark either.
  const gpt56Roles: Gpt56MarkerRoles = !gpt56
    ? undefined
    : request.model.route.id === "openai-chat" || request.model.route.id === "github-copilot-chat"
      ? ["user", "assistant", "tool"]
      : ["user", "tool"]
  const tools = policy.tools && !gpt56 ? markLastTool(request.tools, prefixHint, reserve) : request.tools
  const system = policy.system ? markLastSystem(request.system, prefixHint, reserve) : request.system
  // Volatility is local metadata and does not disable the provider's managed
  // latest-message breakpoint, so its read-candidate slot always stays reserved.
  const implicitReserved = !gpt56 || OpenAIOptions.promptCacheOptions(request)?.mode === "explicit" ? 0 : 1
  const gpt56MessageLimit = gpt56
    ? Math.max(
        0,
        OPENAI_PROMPT_CACHE_READ_CANDIDATE_LIMIT -
          implicitReserved -
          (system.some((part) => part.cache !== undefined) ? 1 : 0),
      )
    : Number.MAX_SAFE_INTEGER
  const selectedMessages = !policy.messages
    ? request.messages
    : auto
      ? markAutoMessages(request.messages, AUTO_MESSAGE_ANCHORS, tailHint, reserve, gpt56Roles)
      : markMessages(request.messages, policy.messages, tailHint, reserve, gpt56Roles, gpt56MessageLimit)
  const messages = gpt56 ? boundGpt56Messages(selectedMessages, gpt56MessageLimit) : selectedMessages

  if (tools === request.tools && system === request.system && messages === request.messages) return request
  return LLMRequest.update(request, { tools, system, messages })
}
