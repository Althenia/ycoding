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
import { LLMRequest, Message, ToolDefinition, type ContentPart } from "./schema/messages"
import { OpenAIOptions } from "./protocols/utils/openai-options"

export const CACHE_POLICY_REVISION = "provider-native/v6"

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
])
const INLINE_HINT_CAP = 4
const EXTENDED_TTL_SECONDS = 3600

const respectsInlineHints = (request: LLMRequest) =>
  RESPECTS_INLINE_HINTS.has(request.model.route.protocol) ||
  INLINE_HINT_ROUTES.has(request.model.route.id) ||
  (OpenAIOptions.publicPromptCacheCapability(request.model.route.id, request.model.id) === "gpt-5.6" &&
    OpenAIOptions.promptCacheOptions(request) !== undefined)

const makeHint = (ttlSeconds: number | undefined): CacheHint =>
  ttlSeconds !== undefined ? new CacheHint({ type: "ephemeral", ttlSeconds }) : new CacheHint({ type: "ephemeral" })

// Routes that place breakpoints themselves once the request opts in. OpenRouter
// exposes an OpenAI-compatible surface, so inline markers can only ride on
// `system`/`user` content arrays — never on the `tool` messages an agent loop
// spends most of its tokens on. Marking only the system turn would pin the
// static prefix and leave the growing tool-result tail uncached on every step,
// so we hand placement to OpenRouter's own top-level switch instead.
const AUTO_PLACEMENT_ROUTES = new Set(["openrouter"])

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
  if (OpenAIOptions.publicPromptCacheCapability(request.model.route.id, request.model.id) === "gpt-5.6")
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

const isGpt56MarkablePart = (part: ContentPart) => part.type === "text" && part.text.trim().length > 0

type Gpt56MarkerRoles = ReadonlyArray<"user" | "assistant"> | undefined

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
  for (let index = messages.length - 1; index >= 0 && found.length < count; index--)
    if (
      messages[index]!.volatile !== true &&
      (gpt56Roles === undefined || gpt56Roles.includes(messages[index]!.role as "user" | "assistant")) &&
      messages[index]!.content.some(gpt56Roles === undefined ? isMarkablePart : isGpt56MarkablePart)
    )
      found.push(index)
  return found.reverse()
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
  if (gpt56Roles !== undefined && !gpt56Roles.includes(target.role as "user" | "assistant")) return target
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
): ReadonlyArray<Message> => {
  if (messages.length === 0) return messages
  if (strategy === "latest-user-message")
    return markMessageAt(messages, lastIndexOfRole(messages, "user"), hint, reserve, gpt56Roles)
  if (strategy === "latest-assistant")
    return markMessageAt(messages, lastIndexOfRole(messages, "assistant"), hint, reserve, gpt56Roles)
  const start = Math.max(0, messages.length - strategy.tail)
  let next: Message[] | undefined
  for (let index = start; index < messages.length; index++) {
    const current = (next ?? messages)[index]!
    const marked = markMessage(current, index, hint, reserve, gpt56Roles)
    if (marked === current) continue
    next ??= messages.slice()
    next[index] = marked
  }
  return next ?? messages
}

export const applyCachePolicy = (request: LLMRequest): LLMRequest => {
  if (!respectsInlineHints(request)) return request
  const policy = resolve(request.cache)
  const auto = request.cache === undefined || request.cache === "auto"
  if (!policy.tools && !policy.system && !policy.messages) return request

  // `auto` splits buckets by lifetime; an explicit policy is taken literally, so
  // its `ttlSeconds` (or the 5m default) applies to every breakpoint it places.
  const tailHint = makeHint(policy.ttlSeconds)
  const prefixHint = auto && cacheProfile(request.model.id)?.extendedTtl ? makeHint(EXTENDED_TTL_SECONDS) : tailHint
  const reserve = coordinateAutoHints(request)
  const gpt56 = OpenAIOptions.publicPromptCacheCapability(request.model.route.id, request.model.id) === "gpt-5.6"
  const gpt56Roles: Gpt56MarkerRoles = gpt56 ? ["user", "assistant"] : undefined
  const tools = policy.tools && !gpt56 ? markLastTool(request.tools, prefixHint, reserve) : request.tools
  const system = policy.system ? markLastSystem(request.system, prefixHint, reserve) : request.system
  const messages = !policy.messages
    ? request.messages
    : auto
      ? markAutoMessages(request.messages, AUTO_MESSAGE_ANCHORS, tailHint, reserve, gpt56Roles)
      : markMessages(request.messages, policy.messages, tailHint, reserve, gpt56Roles)

  if (tools === request.tools && system === request.system && messages === request.messages) return request
  return LLMRequest.update(request, { tools, system, messages })
}
