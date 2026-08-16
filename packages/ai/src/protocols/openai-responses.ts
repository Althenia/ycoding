import { Effect, Encoding, Schema } from "effect"
import { Route } from "../route/client"
import { Auth } from "../route/auth"
import { Endpoint } from "../route/endpoint"
import { HttpTransport, WebSocketTransport } from "../route/transport"
import { Protocol } from "../route/protocol"
import {
  LLMError,
  LLMEvent,
  Message,
  Usage,
  type CacheHint,
  type FinishReason,
  type JsonSchema,
  type LLMRequest,
  type ProviderMetadata,
  type ReasoningPart,
  type TextPart,
  type ToolCallPart,
  type ToolDefinition,
  type ToolContent,
  type ToolResultPart,
} from "../schema"
import { JsonObject, optionalArray, optionalNull, ProviderShared } from "./shared"
import { classifyProviderFailure } from "../provider-error"
import { OpenAIOptions } from "./utils/openai-options"
import { Lifecycle } from "./utils/lifecycle"
import { ToolSchemaProjection } from "./utils/tool-schema"
import { ToolStream } from "./utils/tool-stream"
import { OpenAIImage } from "./utils/openai-image"

const ADAPTER = "openai-responses"
export const DEFAULT_BASE_URL = "https://api.openai.com/v1"
export const PATH = "/responses"

// =============================================================================
// Request Body Schema
// =============================================================================
const OpenAIResponsesInputText = Schema.Struct({
  type: Schema.tag("input_text"),
  text: Schema.String,
  // GPT-5.6+ only. Marks the end of a reusable prefix for explicit prompt
  // caching; pre-5.6 models never receive this field.
  prompt_cache_breakpoint: Schema.optional(OpenAIOptions.OpenAIPromptCacheBreakpoint),
})
const OpenAIResponsesInputImage = Schema.Struct({
  type: Schema.tag("input_image"),
  image_url: Schema.String,
  detail: Schema.optional(OpenAIOptions.OpenAIImageDetail),
  prompt_cache_breakpoint: Schema.optional(OpenAIOptions.OpenAIPromptCacheBreakpoint),
})
const OpenAIResponsesInputContent = Schema.Union([OpenAIResponsesInputText, OpenAIResponsesInputImage])
type OpenAIResponsesInputContent = Schema.Schema.Type<typeof OpenAIResponsesInputContent>

const OpenAIResponsesOutputText = Schema.Struct({
  type: Schema.tag("output_text"),
  text: Schema.String,
})

const OpenAIResponsesReasoningSummaryText = Schema.Struct({
  type: Schema.tag("summary_text"),
  text: Schema.String,
})

const OpenAIResponsesReasoningItem = Schema.Struct({
  type: Schema.tag("reasoning"),
  id: Schema.optionalKey(Schema.String),
  summary: Schema.Array(OpenAIResponsesReasoningSummaryText),
  encrypted_content: optionalNull(Schema.String),
})

const OpenAIResponsesCompactionItem = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.tag("compaction"),
    id: Schema.optional(Schema.String),
    encrypted_content: Schema.String,
  }),
  [Schema.Record(Schema.String, Schema.Json)],
)
type OpenAIResponsesCompactionItem = Schema.Schema.Type<typeof OpenAIResponsesCompactionItem>
type Json = Schema.Schema.Type<typeof Schema.Json>
type OpaqueCompactionMetadata = {
  readonly opaqueCompactionItem: Json
}

const OpenAIResponsesItemReference = Schema.Struct({
  type: Schema.tag("item_reference"),
  id: Schema.String,
})

const OpenAIResponsesHostedToolReplay = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.Literals(["web_search_call", "web_search_preview_call"]),
    id: Schema.String,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)
type OpenAIResponsesHostedToolReplay = Schema.Schema.Type<typeof OpenAIResponsesHostedToolReplay>

// `function_call_output.output` accepts either a plain string or an ordered
// array of content items so tools can return images in addition to text.
// https://platform.openai.com/docs/api-reference/responses/object
const OpenAIResponsesFunctionCallOutputContent = Schema.Union([OpenAIResponsesInputText, OpenAIResponsesInputImage])

const OpenAIResponsesFunctionCallOutput = Schema.Union([
  Schema.String,
  Schema.Array(OpenAIResponsesFunctionCallOutputContent),
])

const OpenAIResponsesUserInputItem = Schema.Struct({
  role: Schema.tag("user"),
  content: Schema.Array(OpenAIResponsesInputContent),
})

const OpenAIResponsesMessagePhase = Schema.Literals(["commentary", "final_answer"])
type OpenAIResponsesMessagePhase = Schema.Schema.Type<typeof OpenAIResponsesMessagePhase>

const OpenAIResponsesInputItem = Schema.Union([
  // Plain string content is the default (backward-compatible with every
  // existing cassette); the array-of-blocks form is only produced when a
  // cache breakpoint must be marked (GPT-5.6+ with a `.cache` hint).
  Schema.Struct({ role: Schema.tag("system"), content: Schema.Union([Schema.String, Schema.Array(OpenAIResponsesInputText)]) }),
  OpenAIResponsesUserInputItem,
  Schema.Struct({
    role: Schema.tag("assistant"),
    content: Schema.Array(OpenAIResponsesOutputText),
    phase: Schema.optional(OpenAIResponsesMessagePhase),
  }),
  OpenAIResponsesReasoningItem,
  OpenAIResponsesCompactionItem,
  OpenAIResponsesItemReference,
  OpenAIResponsesHostedToolReplay,
  Schema.Struct({
    type: Schema.tag("function_call"),
    call_id: Schema.String,
    name: Schema.String,
    arguments: Schema.String,
  }),
  Schema.Struct({
    type: Schema.tag("function_call_output"),
    call_id: Schema.String,
    output: OpenAIResponsesFunctionCallOutput,
  }),
])
type OpenAIResponsesInputItem = Schema.Schema.Type<typeof OpenAIResponsesInputItem>

// Mutable counterpart of the schema reasoning item so `lowerMessages` can fold
// multiple streamed summary parts into the same item before flushing.
type OpenAIResponsesReasoningInput = {
  type: "reasoning"
  id: string
  summary: Array<{ type: "summary_text"; text: string }>
  encrypted_content?: string | null
}
type OpenAIResponsesReasoningReplay = Omit<OpenAIResponsesReasoningInput, "id">

const OpenAIResponsesTool = Schema.Struct({
  type: Schema.tag("function"),
  name: Schema.String,
  description: Schema.String,
  parameters: JsonObject,
  strict: Schema.optional(Schema.Boolean),
})
const OpenAIResponsesImageGenerationTool = Schema.Struct({
  type: Schema.tag("image_generation"),
  action: Schema.optional(Schema.Literals(["auto", "generate", "edit"])),
  background: Schema.optional(Schema.Literals(["auto", "opaque", "transparent"])),
  input_fidelity: Schema.optional(Schema.Literals(["low", "high"])),
  output_compression: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
  output_format: Schema.optional(Schema.Literals(["png", "jpeg", "webp"])),
  partial_images: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  quality: Schema.optional(Schema.Literals(["auto", "low", "medium", "high"])),
  size: Schema.optional(OpenAIImage.Size),
})
const OpenAIResponsesWebSearchTool = Schema.Struct({
  type: Schema.tag("web_search"),
  filters: Schema.optional(
    Schema.Struct({
      allowed_domains: optionalArray(Schema.String),
      blocked_domains: optionalArray(Schema.String),
    }),
  ),
  search_context_size: Schema.optional(Schema.Literals(["low", "medium", "high"])),
  user_location: Schema.optional(
    Schema.Struct({
      type: Schema.tag("approximate"),
      city: Schema.optional(Schema.String),
      country: Schema.optional(Schema.String),
      region: Schema.optional(Schema.String),
      timezone: Schema.optional(Schema.String),
    }),
  ),
  external_web_access: Schema.optional(Schema.Boolean),
  return_token_budget: Schema.optional(Schema.Literals(["default", "unlimited"])),
})
const OpenAIResponsesTools = Schema.Union([
  OpenAIResponsesTool,
  OpenAIResponsesImageGenerationTool,
  OpenAIResponsesWebSearchTool,
])
type OpenAIResponsesTool = Schema.Schema.Type<typeof OpenAIResponsesTools>

const OpenAIResponsesToolChoice = Schema.Union([
  Schema.Literals(["auto", "none", "required"]),
  Schema.Struct({ type: Schema.tag("function"), name: Schema.String }),
  Schema.Struct({ type: Schema.tag("image_generation") }),
  Schema.Struct({ type: Schema.tag("web_search") }),
])

// Fields shared between the HTTP body and the WebSocket `response.create`
// message. The HTTP body adds `stream: true`; the WebSocket message adds
// `type: "response.create"`. Defining the shared shape once keeps the two
// transports in sync without a destructure-and-strip dance.
const OpenAIResponsesCoreFields = {
  model: Schema.String,
  input: Schema.Array(OpenAIResponsesInputItem),
  instructions: Schema.optional(Schema.String),
  tools: optionalArray(OpenAIResponsesTools),
  tool_choice: Schema.optional(OpenAIResponsesToolChoice),
  store: Schema.optional(Schema.Boolean),
  previous_response_id: Schema.optional(Schema.String),
  service_tier: Schema.optional(OpenAIOptions.OpenAIServiceTier),
  prompt_cache_key: Schema.optional(Schema.String),
  // Pre-GPT-5.6 only — rejected with a 400 by GPT-5.6+ models.
  prompt_cache_retention: Schema.optional(OpenAIOptions.OpenAIPromptCacheRetention),
  // GPT-5.6+ only — rejected with a 400 by pre-5.6 models.
  prompt_cache_options: Schema.optional(
    Schema.Struct({
      mode: Schema.optional(Schema.Literals(OpenAIOptions.OpenAIPromptCacheOptionsModes)),
      ttl: Schema.optional(Schema.Literal("30m")),
    }),
  ),
  context_management: optionalArray(OpenAIOptions.OpenAIContextManagement),
  include: optionalArray(OpenAIOptions.OpenAIResponseIncludable),
  reasoning: Schema.optional(
    Schema.Struct({
      effort: Schema.optional(OpenAIOptions.OpenAIReasoningEffort),
      summary: Schema.optional(Schema.Literal("auto")),
      context: Schema.optional(OpenAIOptions.OpenAIReasoningContext),
    }),
  ),
  text: Schema.optional(
    Schema.Struct({
      verbosity: Schema.optional(OpenAIOptions.OpenAITextVerbosity),
    }),
  ),
  max_output_tokens: Schema.optional(Schema.Number),
  temperature: Schema.optional(Schema.Number),
  top_p: Schema.optional(Schema.Number),
}

const OpenAIResponsesBody = Schema.Struct({
  ...OpenAIResponsesCoreFields,
  stream: Schema.Literal(true),
})
export type OpenAIResponsesBody = Schema.Schema.Type<typeof OpenAIResponsesBody>

const OpenAIResponsesWebSocketMessage = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.tag("response.create"),
    ...OpenAIResponsesCoreFields,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)
type OpenAIResponsesWebSocketMessage = Schema.Schema.Type<typeof OpenAIResponsesWebSocketMessage>
const encodeWebSocketMessage = Schema.encodeSync(Schema.fromJsonString(OpenAIResponsesWebSocketMessage))

const OpenAIResponsesUsage = Schema.Struct({
  input_tokens: Schema.optional(Schema.Number),
  input_tokens_details: optionalNull(
    Schema.Struct({
      cached_tokens: Schema.optional(Schema.Number),
      cache_write_tokens: Schema.optional(Schema.Number),
    }),
  ),
  output_tokens: Schema.optional(Schema.Number),
  output_tokens_details: optionalNull(Schema.Struct({ reasoning_tokens: Schema.optional(Schema.Number) })),
  total_tokens: Schema.optional(Schema.Number),
})
type OpenAIResponsesUsage = Schema.Schema.Type<typeof OpenAIResponsesUsage>

const OpenAIResponsesStreamItem = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.String,
    id: Schema.optional(Schema.String),
    call_id: Schema.optional(Schema.String),
    name: Schema.optional(Schema.String),
    arguments: Schema.optional(Schema.String),
    // Hosted (provider-executed) tool fields. Each hosted tool item carries its
    // own subset of these — we capture them generically so we can surface the
    // call's typed input portion and round-trip the full result payload without
    // hand-rolling a per-tool schema.
    status: Schema.optional(Schema.String),
    action: Schema.optional(Schema.Json),
    queries: Schema.optional(Schema.Json),
    results: Schema.optional(Schema.Json),
    code: Schema.optional(Schema.String),
    container_id: Schema.optional(Schema.String),
    outputs: Schema.optional(Schema.Json),
    server_label: Schema.optional(Schema.String),
    output: Schema.optional(Schema.Json),
    result: Schema.optional(Schema.String),
    output_format: Schema.optional(Schema.Literals(["png", "jpeg", "webp"])),
    phase: Schema.optional(OpenAIResponsesMessagePhase),
    error: Schema.optional(Schema.Json),
    encrypted_content: optionalNull(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
)
type OpenAIResponsesStreamItem = Schema.Schema.Type<typeof OpenAIResponsesStreamItem>

// The Responses schema puts streaming error details at the top level and
// response failures under `response.error`. The official SDK also recognizes
// an event-level HTTP-style `error` envelope, so accept all three shapes here.
// https://github.com/openai/openai-openapi/blob/5162af98d3147432c14680df789e8e12d4891e6b/openapi.yaml#L67234-L67382
// https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/core/streaming.ts#L58-L85
const OpenAIResponsesErrorPayload = Schema.Struct({
  code: optionalNull(Schema.String),
  message: optionalNull(Schema.String),
  param: optionalNull(Schema.String),
})

const OpenAIResponsesAnnotation = Schema.Struct({
  type: Schema.String,
  title: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
})
type OpenAIResponsesAnnotation = Schema.Schema.Type<typeof OpenAIResponsesAnnotation>

const OpenAIResponsesEvent = Schema.Struct({
  type: Schema.String,
  delta: Schema.optional(Schema.String),
  item_id: Schema.optional(Schema.String),
  summary_index: Schema.optional(Schema.Number),
  annotation: Schema.optional(OpenAIResponsesAnnotation),
  item: Schema.optional(OpenAIResponsesStreamItem),
  response: Schema.optional(
    Schema.StructWithRest(
      Schema.Struct({
        id: Schema.optional(Schema.String),
        service_tier: optionalNull(Schema.String),
        incomplete_details: optionalNull(Schema.Struct({ reason: Schema.String })),
        usage: optionalNull(OpenAIResponsesUsage),
        error: optionalNull(OpenAIResponsesErrorPayload),
      }),
      [Schema.Record(Schema.String, Schema.Unknown)],
    ),
  ),
  code: optionalNull(Schema.String),
  message: Schema.optional(Schema.String),
  param: optionalNull(Schema.String),
  error: optionalNull(OpenAIResponsesErrorPayload),
})
type OpenAIResponsesEvent = Schema.Schema.Type<typeof OpenAIResponsesEvent>

interface ParserState {
  readonly tools: ToolStream.State<string>
  readonly hasFunctionCall: boolean
  readonly lifecycle: Lifecycle.State
  readonly messagePhases: Readonly<Record<string, OpenAIResponsesMessagePhase>>
  readonly reasoningItems: Readonly<Record<string, ReasoningStreamItem>>
  readonly store: boolean | undefined
}

type ReasoningSummaryStatus = "active" | "can-conclude" | "concluded"

interface ReasoningStreamItem {
  readonly encryptedContent: string | null | undefined
  // Keyed by OpenAI's numeric `summary_index`. JS object keys coerce to
  // strings, but typing the map as `Record<number, ...>` documents intent
  // and matches the wire field.
  readonly summaryParts: Readonly<Record<number, ReasoningSummaryStatus>>
}

const invalid = ProviderShared.invalidRequest

// =============================================================================
// Request Lowering
// =============================================================================
const nativeImageToolInput = (tool: ToolDefinition) => {
  const native = tool.native?.openai
  return ProviderShared.isRecord(native) && native.type === "image_generation" ? native : undefined
}

const nativeImageTool = (tool: ToolDefinition) => {
  const native = nativeImageToolInput(tool)
  return Schema.is(OpenAIResponsesImageGenerationTool)(native) ? native : undefined
}

const nativeWebSearchToolInput = (tool: ToolDefinition) => {
  const native = tool.native?.openai
  return ProviderShared.isRecord(native) && native.type === "web_search" ? native : undefined
}

const nativeWebSearchTool = (tool: ToolDefinition) => {
  const native = nativeWebSearchToolInput(tool)
  return Schema.is(OpenAIResponsesWebSearchTool)(native) ? native : undefined
}

const lowerTool = Effect.fn("OpenAIResponses.lowerTool")(function* (tool: ToolDefinition, inputSchema: JsonSchema) {
  const image = nativeImageToolInput(tool)
  if (image !== undefined) {
    if (Schema.is(OpenAIResponsesImageGenerationTool)(image)) return image
    return yield* invalid("OpenAI Responses image generation tool options are invalid")
  }
  const webSearch = nativeWebSearchToolInput(tool)
  if (webSearch !== undefined) {
    if (Schema.is(OpenAIResponsesWebSearchTool)(webSearch)) return webSearch
    return yield* invalid("OpenAI Responses web search tool options are invalid")
  }
  return {
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    parameters: ToolSchemaProjection.openAI(inputSchema),
    // TODO: Read this from OpenAI-specific tool options so direct LLM callers can opt into strict schemas.
    strict: false,
  }
})

const lowerToolChoice = (toolChoice: NonNullable<LLMRequest["toolChoice"]>, tools: ReadonlyArray<ToolDefinition>) =>
  ProviderShared.matchToolChoice("OpenAI Responses", toolChoice, {
    auto: () => "auto" as const,
    none: () => "none" as const,
    required: () => "required" as const,
    tool: (name) => {
      const tool = tools.find((tool) => tool.name === name)
      if (tool && nativeImageTool(tool) !== undefined) return { type: "image_generation" } as const
      if (tool && nativeWebSearchTool(tool) !== undefined) return { type: "web_search" } as const
      return { type: "function" as const, name }
    },
  })

const lowerToolCall = (part: ToolCallPart): OpenAIResponsesInputItem => ({
  type: "function_call",
  call_id: part.id,
  name: part.name,
  arguments: ProviderShared.encodeJson(part.input),
})

const lowerReasoning = (
  part: ReasoningPart,
): OpenAIResponsesReasoningInput | OpenAIResponsesCompactionItem | undefined => {
  const openai = part.providerMetadata?.openai
  if (!ProviderShared.isRecord(openai)) return undefined
  if (Schema.is(OpenAIResponsesCompactionItem)(openai.opaqueCompactionItem)) return openai.opaqueCompactionItem
  if (typeof openai.compactionEncryptedContent === "string")
    return {
      type: "compaction",
      ...(typeof openai.itemId === "string" && openai.itemId.length > 0 ? { id: openai.itemId } : {}),
      encrypted_content: openai.compactionEncryptedContent,
    }
  if (typeof openai.itemId !== "string" || openai.itemId.length === 0) return undefined
  const encryptedContent =
    typeof openai.reasoningEncryptedContent === "string"
      ? openai.reasoningEncryptedContent
      : openai.reasoningEncryptedContent === null
        ? null
        : undefined
  return {
    type: "reasoning",
    id: openai.itemId,
    summary: part.text.length > 0 ? [{ type: "summary_text", text: part.text }] : [],
    encrypted_content: encryptedContent,
  }
}

const isCompactionReasoning = (part: ReasoningPart) => {
  const openai = part.providerMetadata?.openai
  return (
    ProviderShared.isRecord(openai) &&
    (Schema.is(OpenAIResponsesCompactionItem)(openai.opaqueCompactionItem) ||
      typeof openai.compactionEncryptedContent === "string")
  )
}

const hostedToolItemID = (part: ToolResultPart) => {
  const openai = part.providerMetadata?.openai
  return ProviderShared.isRecord(openai) && typeof openai.itemId === "string" && openai.itemId.length > 0
    ? openai.itemId
    : undefined
}

const hostedToolReplay = (part: ToolResultPart): OpenAIResponsesHostedToolReplay | undefined => {
  if (part.name !== "web_search" && part.name !== "web_search_preview") return undefined
  if (part.result.type !== "json") return undefined
  return Schema.is(OpenAIResponsesHostedToolReplay)(part.result.value) ? part.result.value : undefined
}

const cacheBreakpoint = (cache: CacheHint | undefined) => (cache ? { mode: "explicit" as const } : undefined)

const assistantPhase = (parts: ReadonlyArray<TextPart>): OpenAIResponsesMessagePhase | undefined => {
  const openai = parts.findLast((part) => {
    const value = part.providerMetadata?.openai
    return ProviderShared.isRecord(value) && (value.phase === "commentary" || value.phase === "final_answer")
  })?.providerMetadata?.openai
  if (!ProviderShared.isRecord(openai)) return undefined
  return openai.phase === "commentary" || openai.phase === "final_answer" ? openai.phase : undefined
}

const lowerUserContent = Effect.fn("OpenAIResponses.lowerUserContent")(function* (
  part: LLMRequest["messages"][number]["content"][number],
  supportsBreakpoints: boolean,
  imageDetail: OpenAIOptions.OpenAIImageDetail | undefined,
) {
  if (part.type === "text")
    return {
      type: "input_text" as const,
      text: part.text,
      prompt_cache_breakpoint: supportsBreakpoints ? cacheBreakpoint(part.cache) : undefined,
    }
  if (part.type === "media") {
    const media = yield* ProviderShared.validateMedia(
      "OpenAI Responses",
      part,
      new Set<string>(ProviderShared.IMAGE_MIMES),
    )
    return { type: "input_image" as const, image_url: media.dataUrl, ...(imageDetail ? { detail: imageDetail } : {}) }
  }
  return yield* ProviderShared.unsupportedContent("OpenAI Responses", "user", ["text", "media"])
})

// Tool results may carry structured text/images. Keep media as provider-native
// content instead of JSON-stringifying base64 into a prompt string.
const lowerToolResultContentItem = Effect.fn("OpenAIResponses.lowerToolResultContentItem")(function* (
  item: ToolContent,
  breakpoint?: OpenAIOptions.OpenAIPromptCacheBreakpoint,
  imageDetail?: OpenAIOptions.OpenAIImageDetail,
) {
  if (item.type === "text") return { type: "input_text" as const, text: item.text, prompt_cache_breakpoint: breakpoint }
  const media = yield* ProviderShared.validateToolFile(
    "OpenAI Responses",
    item,
    new Set<string>(ProviderShared.IMAGE_MIMES),
  )
  return { type: "input_image" as const, image_url: media.dataUrl, ...(imageDetail ? { detail: imageDetail } : {}) }
})

const lowerToolResultOutput = Effect.fn("OpenAIResponses.lowerToolResultOutput")(function* (
  part: ToolResultPart,
  supportsBreakpoints: boolean,
  imageDetail: OpenAIOptions.OpenAIImageDetail | undefined,
) {
  // Unmarked text/json/error results stay plain strings for compatibility.
  // A marked GPT-5.6 result must become input_text because breakpoints are
  // valid on content blocks, not on the function_call_output item itself.
  if (part.result.type !== "content") {
    const text = ProviderShared.toolResultText(part)
    if (!supportsBreakpoints || !part.cache || text.trim().length === 0) return text
    return [{ type: "input_text" as const, text, prompt_cache_breakpoint: cacheBreakpoint(part.cache) }]
  }
  // Preserve the narrowed array element type when compiled through a consumer package.
  const content: ReadonlyArray<ToolContent> = part.result.value
  const markAt =
    supportsBreakpoints && part.cache
      ? content.findLastIndex((item) => item.type === "text" && item.text.trim().length > 0)
      : -1
  return yield* Effect.forEach(content, (item, index) =>
    lowerToolResultContentItem(item, index === markAt ? cacheBreakpoint(part.cache) : undefined, imageDetail),
  )
})

export const pruneMessagesForServerCompaction = (request: LLMRequest) => {
  if (OpenAIOptions.store(request) !== false) return request.messages
  const boundary = request.messages
    .flatMap((message, messageIndex) =>
      message.role !== "assistant"
        ? []
        : message.content.flatMap((part, contentIndex) =>
            part.type === "reasoning" && isCompactionReasoning(part) ? [{ messageIndex, contentIndex }] : [],
          ),
    )
    .at(-1)
  if (!boundary) return request.messages
  return request.messages.slice(boundary.messageIndex).map((message, messageIndex) =>
    messageIndex === 0 && message.role === "assistant"
      ? Message.make({
          id: message.id,
          role: message.role,
          content: message.content.slice(boundary.contentIndex),
          volatile: message.volatile,
          metadata: message.metadata,
          native: message.native,
        })
      : message,
  )
}

const lowerMessages = Effect.fn("OpenAIResponses.lowerMessages")(function* (request: LLMRequest) {
  const invalidImageDetail = OpenAIOptions.invalidImageDetail(request)
  if (invalidImageDetail !== undefined)
    return yield* ProviderShared.invalidRequest(
      `OpenAI Responses image detail is invalid: ${typeof invalidImageDetail === "string" ? invalidImageDetail : "non-string value"}`,
    )
  const imageDetail = OpenAIOptions.imageDetail(request)
  if (imageDetail === "original" && !OpenAIOptions.supportsOriginalImageDetail(request.model.id))
    return yield* ProviderShared.invalidRequest(
      `OpenAI Responses image detail original requires GPT-5.4 or later: ${request.model.id}`,
    )
  const supportsBreakpoints = OpenAIOptions.supportsPromptCacheBreakpoints(request.model.route.id, request.model.id)

  const systemCacheHint = request.system.find((part) => part.cache !== undefined)?.cache
  const system: OpenAIResponsesInputItem[] =
    request.system.length === 0
      ? []
      : [
          {
            role: "system",
            content:
              supportsBreakpoints && systemCacheHint
                ? [
                    {
                      type: "input_text" as const,
                      text: ProviderShared.joinText(request.system),
                      prompt_cache_breakpoint: cacheBreakpoint(systemCacheHint),
                    },
                  ]
                : ProviderShared.joinText(request.system),
          },
        ]
  const input: OpenAIResponsesInputItem[] = [...system]
  const store = OpenAIOptions.store(request)
  const previousResponseId = store === true ? OpenAIOptions.previousResponseId(request) : undefined
  const continuationInputStart =
    previousResponseId === undefined ? 0 : Math.min(OpenAIOptions.continuationInputStart(request) ?? 0, request.messages.length)

  for (const message of pruneMessagesForServerCompaction(request).slice(continuationInputStart)) {
    if (message.role === "system") {
      const part = yield* ProviderShared.wrappedSystemUpdate("OpenAI Responses", message)
      const previous = input.at(-1)
      if (previous && Schema.is(OpenAIResponsesUserInputItem)(previous))
        input[input.length - 1] = {
          role: "user",
          content: [...previous.content, { type: "input_text", text: part.text }],
        }
      else input.push({ role: "user", content: [{ type: "input_text", text: part.text }] })
      continue
    }

    if (message.role === "user") {
      input.push({
        role: "user",
        content: yield* Effect.forEach(message.content, (part) =>
          lowerUserContent(part, supportsBreakpoints, imageDetail),
        ),
      })
      continue
    }

    if (message.role === "assistant") {
      const content: TextPart[] = []
      const reasoningItems: Record<string, OpenAIResponsesReasoningReplay> = {}
      const reasoningReferences = new Set<string>()
      const compactionReferences = new Set<string>()
      const hostedToolReferences = new Set<string>()
      const flushText = () => {
        if (content.length === 0) return
        const phase = assistantPhase(content)
        input.push({
          role: "assistant",
          ...(phase === undefined ? {} : { phase }),
          content: content.map((part) => ({ type: "output_text" as const, text: part.text })),
        })
        content.splice(0, content.length)
      }
      for (const part of message.content) {
        if (part.type === "text") {
          content.push(part)
          continue
        }
        if (part.type === "reasoning") {
          flushText()
          const reasoning = lowerReasoning(part)
          if (!reasoning) continue
          if (reasoning.type === "compaction") {
            if (store !== false && reasoning.id) {
              if (!compactionReferences.has(reasoning.id)) input.push({ type: "item_reference", id: reasoning.id })
              compactionReferences.add(reasoning.id)
              continue
            }
            input.push(reasoning)
            continue
          }
          if (store !== false) {
            if (!reasoningReferences.has(reasoning.id)) input.push({ type: "item_reference", id: reasoning.id })
            reasoningReferences.add(reasoning.id)
            continue
          }
          const existing = reasoningItems[reasoning.id]
          if (existing) {
            existing.summary.push(...reasoning.summary)
            if (typeof reasoning.encrypted_content === "string")
              existing.encrypted_content = reasoning.encrypted_content
            continue
          }
          const replay = {
            type: reasoning.type,
            summary: reasoning.summary,
            encrypted_content: reasoning.encrypted_content,
          }
          reasoningItems[reasoning.id] = replay
          input.push(replay)
          continue
        }
        if (part.type === "tool-call") {
          flushText()
          if (part.providerExecuted === true) continue
          input.push(lowerToolCall(part))
          continue
        }
        if (part.type === "tool-result" && part.providerExecuted === true) {
          flushText()
          const itemID = hostedToolItemID(part)
          if (store !== false && itemID && !hostedToolReferences.has(itemID))
            input.push({ type: "item_reference", id: itemID })
          if (store === false) {
            const replay = hostedToolReplay(part)
            if (replay) input.push(replay)
          }
          if (store === false && part.name === "image_generation" && part.result.type === "content") {
            const content: ReadonlyArray<ToolContent> = part.result.value
            input.push({
              role: "user",
              content: yield* Effect.forEach(content, (item) =>
                lowerToolResultContentItem(item, undefined, imageDetail),
              ),
            })
          }
          if (itemID) hostedToolReferences.add(itemID)
          continue
        }
        return yield* ProviderShared.unsupportedContent("OpenAI Responses", "assistant", [
          "text",
          "reasoning",
          "tool-call",
          "tool-result",
        ])
      }
      flushText()
      continue
    }

    for (const part of message.content) {
      if (!ProviderShared.supportsContent(part, ["tool-result"]))
        return yield* ProviderShared.unsupportedContent("OpenAI Responses", "tool", ["tool-result"])
      input.push({
        type: "function_call_output",
        call_id: part.id,
        output: yield* lowerToolResultOutput(part, supportsBreakpoints, imageDetail),
      })
    }
  }

  // With store:false, OpenAI only accepts previous reasoning items when the
  // complete item has encrypted state. Summary blocks for one item may carry
  // that state only on the last block, so filter after they have been joined.
  return store === false
    ? input.filter(
        (item) => !("type" in item) || item.type !== "reasoning" || typeof item.encrypted_content === "string",
      )
    : input
})

const lowerOptions = Effect.fn("OpenAIResponses.lowerOptions")(function* (request: LLMRequest) {
  const store = OpenAIOptions.store(request)
  const previousResponseId = store === true ? OpenAIOptions.previousResponseId(request) : undefined
  const promptCacheKey = OpenAIOptions.promptCacheKey(request)
  const effort = OpenAIOptions.reasoningEffort(request)
  const summary = OpenAIOptions.reasoningSummary(request)
  const context = OpenAIOptions.resolvedReasoningContext(request)
  const include = OpenAIOptions.include(request)
  const verbosity = OpenAIOptions.textVerbosity(request)
  const instructions = OpenAIOptions.instructions(request)
  const serviceTier = OpenAIOptions.serviceTier(request)
  const cacheCapability = OpenAIOptions.publicPromptCacheCapability(request.model.route.id, request.model.id)
  const configuredRetention = cacheCapability === "legacy" ? OpenAIOptions.promptCacheRetention(request) : undefined
  const retention =
    configuredRetention === "24h" && !OpenAIOptions.supportsExtendedPromptCacheRetention(request.model.id)
      ? undefined
      : configuredRetention
  const cacheOptions = cacheCapability === "gpt-5.6" ? OpenAIOptions.promptCacheOptions(request) : undefined
  const contextManagement = OpenAIOptions.resolvedContextManagement(request)
  return {
    ...(instructions ? { instructions } : {}),
    ...(store !== undefined ? { store } : {}),
    ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
    ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
    ...(retention ? { prompt_cache_retention: retention } : {}),
    ...(cacheOptions ? { prompt_cache_options: cacheOptions } : {}),
    ...(contextManagement && contextManagement.length > 0
      ? {
          context_management: contextManagement.map((entry) => ({
            type: entry.type,
            compact_threshold: entry.compactThreshold,
          })),
        }
      : {}),
    ...(include ? { include } : {}),
    ...(effort || summary || context ? { reasoning: { effort, summary, context } } : {}),
    ...(verbosity ? { text: { verbosity } } : {}),
    ...(serviceTier ? { service_tier: serviceTier } : {}),
  }
})

const fromRequest = Effect.fn("OpenAIResponses.fromRequest")(function* (request: LLMRequest) {
  const generation = request.generation
  const options = yield* lowerOptions(request)
  const toolSchemaCompatibility = request.model.compatibility?.toolSchema
  return {
    model: request.model.id,
    input: yield* lowerMessages(request),
    tools:
      request.tools.length === 0
        ? undefined
        : yield* Effect.forEach(request.tools, (tool) =>
            lowerTool(tool, ToolSchemaProjection.modelCompatibility(tool.inputSchema, toolSchemaCompatibility)),
          ),
    tool_choice: request.toolChoice ? yield* lowerToolChoice(request.toolChoice, request.tools) : undefined,
    stream: true as const,
    max_output_tokens: generation?.maxTokens,
    temperature: generation?.temperature,
    top_p: generation?.topP,
    ...options,
  }
})

// =============================================================================
// Stream Parsing
// =============================================================================
// OpenAI Responses reports `input_tokens` (inclusive total) with a
// `cached_tokens` and `cache_write_tokens` subsets, and `output_tokens`
// (inclusive total) with a `reasoning_tokens` subset. Pass the totals through
// and derive the non-cached breakdown.
const mapUsage = (usage: OpenAIResponsesUsage | null | undefined) => {
  if (!usage) return undefined
  const normalized = ProviderShared.normalizeInputUsage({
    semantics: "inclusive-total",
    total: usage.input_tokens,
    cacheRead: usage.input_tokens_details?.cached_tokens,
    cacheWrite: usage.input_tokens_details?.cache_write_tokens,
  })
  const reasoning = usage.output_tokens_details?.reasoning_tokens
  return new Usage({
    ...normalized,
    outputTokens: usage.output_tokens,
    reasoningTokens: reasoning,
    totalTokens: ProviderShared.totalTokens(usage.input_tokens, usage.output_tokens, usage.total_tokens),
    providerMetadata: { openai: usage },
  })
}

const mapFinishReason = (event: OpenAIResponsesEvent, hasFunctionCall: boolean): FinishReason => {
  const reason = event.response?.incomplete_details?.reason
  if (reason === undefined || reason === null) return hasFunctionCall ? "tool-calls" : "stop"
  if (reason === "max_output_tokens") return "length"
  if (reason === "content_filter") return "content-filter"
  return hasFunctionCall ? "tool-calls" : "unknown"
}

const openaiMetadata = (metadata: Record<string, unknown>): ProviderMetadata => ({ openai: metadata })

// Hosted tool items (provider-executed) ship their typed input + status +
// result fields all in one item. We expose them as a `tool-call` +
// `tool-result` pair so consumers can treat them uniformly with client tools,
// only differentiated by `providerExecuted: true`.
//
// One record per OpenAI Responses item type that represents a hosted
// (provider-executed) tool call: the common name we surface, plus an `input`
// extractor that picks the fields the model actually populated for that tool.
// Falling back to `{}` when an entry isn't fully typed keeps unknown tools
// observable without rolling a per-tool schema.
const HOSTED_TOOLS = {
  web_search_call: { name: "web_search", input: (item) => item.action ?? {} },
  web_search_preview_call: { name: "web_search_preview", input: (item) => item.action ?? {} },
  file_search_call: { name: "file_search", input: (item) => ({ queries: item.queries ?? [] }) },
  code_interpreter_call: {
    name: "code_interpreter",
    input: (item) => ({ code: item.code, container_id: item.container_id }),
  },
  computer_use_call: { name: "computer_use", input: (item) => item.action ?? {} },
  image_generation_call: { name: "image_generation", input: () => ({}) },
  mcp_call: {
    name: "mcp",
    input: (item) => ({ server_label: item.server_label, name: item.name, arguments: item.arguments }),
  },
  local_shell_call: { name: "local_shell", input: (item) => item.action ?? {} },
} as const satisfies Record<
  string,
  { readonly name: string; readonly input: (item: OpenAIResponsesStreamItem) => unknown }
>

type HostedToolType = keyof typeof HOSTED_TOOLS

const isHostedToolItem = (
  item: OpenAIResponsesStreamItem,
): item is OpenAIResponsesStreamItem & { type: HostedToolType; id: string } =>
  item.type in HOSTED_TOOLS && typeof item.id === "string" && item.id.length > 0

const isReasoningItem = (
  item: OpenAIResponsesStreamItem,
): item is OpenAIResponsesStreamItem & { type: "reasoning"; id: string } =>
  item.type === "reasoning" && typeof item.id === "string" && item.id.length > 0

const isCompactionItem = (
  item: OpenAIResponsesStreamItem,
): item is OpenAIResponsesStreamItem & { type: "compaction"; encrypted_content: string } =>
  item.type === "compaction" && typeof item.encrypted_content === "string"

// Round-trip the full item as the structured result so consumers can extract
// outputs / sources / status without re-decoding.
const hostedToolResult = Effect.fn("OpenAIResponses.hostedToolResult")(function* (item: OpenAIResponsesStreamItem) {
  const isError = typeof item.error !== "undefined" && item.error !== null
  if (item.type === "image_generation_call" && item.result) {
    yield* Effect.fromResult(Encoding.decodeBase64(item.result)).pipe(
      Effect.mapError(() => ProviderShared.eventError(ADAPTER, "OpenAI Responses returned invalid image base64")),
    )
    return {
      type: "content" as const,
      value: [
        {
          type: "file" as const,
          uri: `data:image/${item.output_format ?? "png"};base64,${item.result}`,
          mime: `image/${item.output_format ?? "png"}`,
        },
      ],
    }
  }
  return isError ? { type: "error" as const, value: item.error } : { type: "json" as const, value: item }
})

const hostedToolEvents = Effect.fn("OpenAIResponses.hostedToolEvents")(function* (
  item: OpenAIResponsesStreamItem & { type: HostedToolType; id: string },
) {
  const tool = HOSTED_TOOLS[item.type]
  const providerMetadata = openaiMetadata({ itemId: item.id })
  return [
    LLMEvent.toolCall({
      id: item.id,
      name: tool.name,
      input: tool.input(item),
      providerExecuted: true,
      providerMetadata,
    }),
    LLMEvent.toolResult({
      id: item.id,
      name: tool.name,
      result: yield* hostedToolResult(item),
      providerExecuted: true,
      providerMetadata,
    }),
  ]
})

type StepResult = readonly [ParserState, ReadonlyArray<LLMEvent>]

const NO_EVENTS: StepResult["1"] = []

// `response.completed` / `response.incomplete` are clean finishes that emit a
// `finish` event; `response.failed` is a hard failure. All three end the stream,
// so keep this set aligned with `step` and the protocol's terminal predicate.
const TERMINAL_TYPES = new Set(["response.completed", "response.incomplete", "response.failed"])

const onOutputTextDelta = (state: ParserState, event: OpenAIResponsesEvent): StepResult => {
  if (!event.delta) return [state, NO_EVENTS]
  const events: LLMEvent[] = []
  const itemID = event.item_id ?? "text-0"
  const phase = state.messagePhases[itemID]
  return [
    {
      ...state,
      lifecycle: Lifecycle.textDelta(
        state.lifecycle,
        events,
        itemID,
        event.delta,
        phase === undefined ? undefined : openaiMetadata({ phase }),
      ),
    },
    events,
  ]
}

const onOutputTextAnnotationAdded = (state: ParserState, event: OpenAIResponsesEvent): StepResult => {
  const text = urlCitationText(event.annotation)
  if (text === undefined) return [state, NO_EVENTS]
  const events: LLMEvent[] = []
  const itemID = event.item_id ?? "text-0"
  const phase = state.messagePhases[itemID]
  return [
    {
      ...state,
      lifecycle: Lifecycle.textDelta(
        state.lifecycle,
        events,
        itemID,
        text,
        phase === undefined ? undefined : openaiMetadata({ phase }),
      ),
    },
    events,
  ]
}

const onOutputTextDone = (state: ParserState, event: OpenAIResponsesEvent): StepResult => {
  const events: LLMEvent[] = []
  const itemID = event.item_id ?? "text-0"
  const phase = state.messagePhases[itemID]
  const { [itemID]: _phase, ...messagePhases } = state.messagePhases
  return [
    {
      ...state,
      messagePhases,
      lifecycle: Lifecycle.textEnd(
        state.lifecycle,
        events,
        itemID,
        phase === undefined ? undefined : openaiMetadata({ phase }),
      ),
    },
    events,
  ]
}

const urlCitationText = (annotation: OpenAIResponsesAnnotation | undefined) =>
  annotation?.type === "url_citation" && annotation.title && annotation.url
    ? `\n\nSource: ${annotation.title}\n${annotation.url}`
    : undefined

const onReasoningDelta = (state: ParserState, event: OpenAIResponsesEvent): StepResult => {
  if (!event.delta) return [state, NO_EVENTS]
  const events: LLMEvent[] = []
  const itemID = event.item_id ?? "reasoning-0"
  const id =
    event.summary_index !== undefined || state.reasoningItems[itemID] ? `${itemID}:${event.summary_index ?? 0}` : itemID
  return [
    {
      ...state,
      lifecycle: Lifecycle.reasoningDelta(state.lifecycle, events, id, event.delta),
    },
    events,
  ]
}

const onReasoningDone = (state: ParserState, _event: OpenAIResponsesEvent): StepResult => [state, NO_EVENTS]

const reasoningMetadata = (item: OpenAIResponsesStreamItem & { id: string }) =>
  openaiMetadata({ itemId: item.id, reasoningEncryptedContent: item.encrypted_content ?? null })

const compactionMetadata = (item: OpenAIResponsesStreamItem & { type: "compaction"; encrypted_content: string }) =>
  openaiMetadata({ opaqueCompactionItem: item } satisfies OpaqueCompactionMetadata)

// OpenAI Responses streams reasoning items in a stable order:
//   `output_item.added` (reasoning) →
//     `reasoning_summary_part.added` (index=0) →
//     `reasoning_summary_text.delta` →
//     `reasoning_summary_part.done` (index=0) →
//     (repeat for index>0) →
//   `output_item.done` (reasoning).
// The handlers below rely on this ordering: `onOutputItemAdded` seeds the
// per-item entry, `onReasoningSummaryPartAdded` for `summary_index === 0`
// short-circuits when the entry already exists, and higher-index handlers
// fold against the same entry. Behaviour for out-of-order events is
// best-effort, not guaranteed.
const onOutputItemAdded = (state: ParserState, event: OpenAIResponsesEvent): StepResult => {
  const item = event.item
  if (item?.type === "message" && item.id && item.phase)
    return [{ ...state, messagePhases: { ...state.messagePhases, [item.id]: item.phase } }, NO_EVENTS]
  if (item && isReasoningItem(item)) {
    const events: LLMEvent[] = []
    return [
      {
        ...state,
        lifecycle: Lifecycle.reasoningStart(state.lifecycle, events, `${item.id}:0`, reasoningMetadata(item)),
        reasoningItems: {
          ...state.reasoningItems,
          [item.id]: { encryptedContent: item.encrypted_content, summaryParts: { 0: "active" } },
        },
      },
      events,
    ]
  }
  if (item?.type !== "function_call" || !item.id) return [state, NO_EVENTS]
  const providerMetadata = openaiMetadata({ itemId: item.id })
  const events: LLMEvent[] = []
  const lifecycle = Lifecycle.stepStart(state.lifecycle, events)
  return [
    {
      ...state,
      lifecycle,
      hasFunctionCall: state.hasFunctionCall,
      tools: ToolStream.start(state.tools, item.id, {
        id: item.call_id ?? item.id,
        name: item.name ?? "",
        input: item.arguments ?? "",
        providerMetadata,
      }),
    },
    [...events, LLMEvent.toolInputStart({ id: item.call_id ?? item.id, name: item.name ?? "", providerMetadata })],
  ]
}

const onReasoningSummaryPartAdded = (state: ParserState, event: OpenAIResponsesEvent): StepResult => {
  if (!event.item_id || event.summary_index === undefined) return [state, NO_EVENTS]
  const item = state.reasoningItems[event.item_id] ?? { encryptedContent: undefined, summaryParts: {} }
  if (event.summary_index === 0) {
    if (state.reasoningItems[event.item_id]) return [state, NO_EVENTS]
    const events: LLMEvent[] = []
    return [
      {
        ...state,
        lifecycle: Lifecycle.reasoningStart(
          state.lifecycle,
          events,
          `${event.item_id}:0`,
          openaiMetadata({ itemId: event.item_id, reasoningEncryptedContent: null }),
        ),
        reasoningItems: {
          ...state.reasoningItems,
          [event.item_id]: { ...item, summaryParts: { 0: "active" } },
        },
      },
      events,
    ]
  }

  const events: LLMEvent[] = []
  const closed = Object.entries(item.summaryParts)
    .filter((entry) => entry[1] === "can-conclude")
    .reduce(
      (lifecycle, entry) =>
        Lifecycle.reasoningEnd(
          lifecycle,
          events,
          `${event.item_id}:${entry[0]}`,
          openaiMetadata({ itemId: event.item_id }),
        ),
      state.lifecycle,
    )
  return [
    {
      ...state,
      lifecycle: Lifecycle.reasoningStart(
        closed,
        events,
        `${event.item_id}:${event.summary_index}`,
        openaiMetadata({ itemId: event.item_id, reasoningEncryptedContent: item.encryptedContent ?? null }),
      ),
      reasoningItems: {
        ...state.reasoningItems,
        [event.item_id]: {
          ...item,
          summaryParts: {
            ...Object.fromEntries(
              Object.entries(item.summaryParts).map((entry) =>
                entry[1] === "can-conclude" ? [entry[0], "concluded" as const] : entry,
              ),
            ),
            [event.summary_index]: "active",
          },
        },
      },
    },
    events,
  ]
}

const onReasoningSummaryPartDone = (state: ParserState, event: OpenAIResponsesEvent): StepResult => {
  if (!event.item_id || event.summary_index === undefined) return [state, NO_EVENTS]
  const item = state.reasoningItems[event.item_id]
  if (!item) return [state, NO_EVENTS]
  const events: LLMEvent[] = []
  return [
    {
      ...state,
      lifecycle:
        state.store !== false
          ? Lifecycle.reasoningEnd(
              state.lifecycle,
              events,
              `${event.item_id}:${event.summary_index}`,
              openaiMetadata({ itemId: event.item_id }),
            )
          : state.lifecycle,
      reasoningItems: {
        ...state.reasoningItems,
        [event.item_id]: {
          ...item,
          summaryParts: {
            ...item.summaryParts,
            [event.summary_index]: state.store !== false ? "concluded" : "can-conclude",
          },
        },
      },
    },
    events,
  ]
}

const onFunctionCallArgumentsDelta = Effect.fn("OpenAIResponses.onFunctionCallArgumentsDelta")(function* (
  state: ParserState,
  event: OpenAIResponsesEvent,
) {
  if (!event.item_id || !event.delta) return [state, NO_EVENTS] satisfies StepResult
  const result = ToolStream.appendExisting(
    ADAPTER,
    state.tools,
    event.item_id,
    event.delta,
    "OpenAI Responses tool argument delta is missing its tool call",
  )
  if (ToolStream.isError(result)) return yield* result
  const events: LLMEvent[] = []
  const lifecycle = result.events.length ? Lifecycle.stepStart(state.lifecycle, events) : state.lifecycle
  events.push(...result.events)
  return [{ ...state, lifecycle, tools: result.tools }, events] satisfies StepResult
})

const onOutputItemDone = Effect.fn("OpenAIResponses.onOutputItemDone")(function* (
  state: ParserState,
  event: OpenAIResponsesEvent,
) {
  const item = event.item
  if (!item) return [state, NO_EVENTS] satisfies StepResult

  if (item.type === "message" && item.id) return onOutputTextDone(state, { ...event, item_id: item.id })

  if (item.type === "function_call") {
    if (!item.id || !item.call_id || !item.name) return [state, NO_EVENTS] satisfies StepResult
    const tools = state.tools[item.id]
      ? state.tools
      : ToolStream.start(state.tools, item.id, { id: item.call_id, name: item.name })
    const result =
      item.arguments === undefined
        ? yield* ToolStream.finish(ADAPTER, tools, item.id)
        : yield* ToolStream.finishWithInput(ADAPTER, tools, item.id, item.arguments)
    const events: LLMEvent[] = []
    const resultEvents = result.events ?? []
    const lifecycle = resultEvents.length ? Lifecycle.stepStart(state.lifecycle, events) : state.lifecycle
    events.push(...resultEvents)
    return [
      {
        ...state,
        lifecycle,
        hasFunctionCall:
          resultEvents.some((event) => LLMEvent.is.toolCall(event) || LLMEvent.is.toolInputError(event)) ||
          state.hasFunctionCall,
        tools: result.tools,
      },
      events,
    ] satisfies StepResult
  }

  if (isCompactionItem(item)) {
    const events: LLMEvent[] = []
    const id = item.id ?? "compaction-0"
    const providerMetadata = compactionMetadata(item)
    const started = Lifecycle.reasoningStart(state.lifecycle, events, id, providerMetadata)
    return [
      { ...state, lifecycle: Lifecycle.reasoningEnd(started, events, id, providerMetadata) },
      events,
    ] satisfies StepResult
  }

  if (isHostedToolItem(item)) {
    const events: LLMEvent[] = []
    const lifecycle = Lifecycle.stepStart(state.lifecycle, events)
    events.push(...(yield* hostedToolEvents(item)))
    return [{ ...state, lifecycle }, events] satisfies StepResult
  }

  if (isReasoningItem(item)) {
    const events: LLMEvent[] = []
    const providerMetadata = reasoningMetadata(item)
    const reasoningItem = state.reasoningItems[item.id]
    if (reasoningItem) {
      const lifecycle = Object.entries(reasoningItem.summaryParts)
        .filter((entry) => entry[1] === "active" || entry[1] === "can-conclude")
        .reduce(
          (lifecycle, entry) => Lifecycle.reasoningEnd(lifecycle, events, `${item.id}:${entry[0]}`, providerMetadata),
          state.lifecycle,
        )
      const { [item.id]: _removed, ...reasoningItems } = state.reasoningItems
      return [{ ...state, lifecycle, reasoningItems }, events] satisfies StepResult
    }
    if (!state.lifecycle.reasoning.has(item.id)) {
      const lifecycle = Lifecycle.stepStart(state.lifecycle, events)
      events.push(LLMEvent.reasoningStart({ id: item.id, providerMetadata }))
      events.push(LLMEvent.reasoningEnd({ id: item.id, providerMetadata }))
      return [{ ...state, lifecycle }, events] satisfies StepResult
    }
    return [
      { ...state, lifecycle: Lifecycle.reasoningEnd(state.lifecycle, events, item.id, providerMetadata) },
      events,
    ] satisfies StepResult
  }

  return [state, NO_EVENTS] satisfies StepResult
})

const onResponseFinish = (state: ParserState, event: OpenAIResponsesEvent): StepResult => {
  const events: LLMEvent[] = []
  const lifecycle = Lifecycle.finish(state.lifecycle, events, {
    reason: mapFinishReason(event, state.hasFunctionCall),
    usage: mapUsage(event.response?.usage),
    providerMetadata:
      event.response?.id || event.response?.service_tier
        ? openaiMetadata({
            responseId: event.response.id,
            serviceTier: event.response.service_tier,
          })
        : undefined,
  })
  return [{ ...state, lifecycle }, events]
}

// Build a single human-readable message from whatever the provider supplied.
// When both code and message are present, prefix the code so consumers see
// the failure mode (e.g. `rate_limit_exceeded: Slow down`) instead of just
// the bare message — production rate limits and context-length failures used
// to be indistinguishable from generic stream drops.
const providerErrorMessage = (event: OpenAIResponsesEvent, fallback: string): string => {
  const nested = event.error ?? event.response?.error ?? undefined
  const message = event.message || nested?.message || undefined
  const code = event.code || nested?.code || undefined
  if (message && code) return `${code}: ${message}`
  return message || code || fallback
}

const providerError = (event: OpenAIResponsesEvent, fallback: string) => {
  const code = event.code || event.error?.code || event.response?.error?.code || undefined
  const message = providerErrorMessage(event, fallback)
  return new LLMError({
    module: ADAPTER,
    method: "stream",
    reason: classifyProviderFailure({ message, code }),
  })
}

const step = (state: ParserState, event: OpenAIResponsesEvent) => {
  if (event.type === "response.output_text.delta") return Effect.succeed(onOutputTextDelta(state, event))
  if (event.type === "response.output_text.annotation.added")
    return Effect.succeed(onOutputTextAnnotationAdded(state, event))
  if (event.type === "response.output_text.done") return Effect.succeed(onOutputTextDone(state, event))
  if (
    event.type === "response.reasoning_text.delta" ||
    event.type === "response.reasoning_summary.delta" ||
    event.type === "response.reasoning_summary_text.delta"
  )
    return Effect.succeed(onReasoningDelta(state, event))
  if (
    event.type === "response.reasoning_text.done" ||
    event.type === "response.reasoning_summary.done" ||
    event.type === "response.reasoning_summary_text.done"
  )
    return Effect.succeed(onReasoningDone(state, event))
  if (event.type === "response.reasoning_summary_part.added")
    return Effect.succeed(onReasoningSummaryPartAdded(state, event))
  if (event.type === "response.reasoning_summary_part.done")
    return Effect.succeed(onReasoningSummaryPartDone(state, event))
  if (event.type === "response.output_item.added") return Effect.succeed(onOutputItemAdded(state, event))
  if (event.type === "response.function_call_arguments.delta") return onFunctionCallArgumentsDelta(state, event)
  if (event.type === "response.output_item.done") return onOutputItemDone(state, event)
  if (event.type === "response.completed" || event.type === "response.incomplete")
    return Effect.succeed(onResponseFinish(state, event))
  if (event.type === "response.failed") return providerError(event, "OpenAI Responses response failed")
  if (event.type === "error") return providerError(event, "OpenAI Responses stream error")
  return Effect.succeed<StepResult>([state, NO_EVENTS])
}

// =============================================================================
// Protocol And OpenAI Route
// =============================================================================
/**
 * The OpenAI Responses protocol — request body construction, body schema, and
 * the streaming-event state machine. Used by native OpenAI and (once
 * registered) Azure OpenAI Responses.
 */
export const protocol = Protocol.make({
  id: ADAPTER,
  body: {
    schema: OpenAIResponsesBody,
    from: fromRequest,
  },
  stream: {
    event: Protocol.jsonEvent(OpenAIResponsesEvent),
    initial: (request) => ({
      hasFunctionCall: false,
      tools: ToolStream.empty<string>(),
      lifecycle: Lifecycle.initial(),
      messagePhases: {},
      reasoningItems: {},
      store: OpenAIOptions.store(request),
    }),
    step,
    terminal: (event) => TERMINAL_TYPES.has(event.type),
  },
})

const endpoint = Endpoint.path<OpenAIResponsesBody>(PATH, { baseURL: DEFAULT_BASE_URL })
const auth = Auth.none

export const httpTransport = HttpTransport.sseJson.with<OpenAIResponsesBody>()

export const route = Route.make({
  id: ADAPTER,
  provider: "openai",
  providerMetadataKey: "openai",
  protocol,
  endpoint,
  auth,
  transport: httpTransport,
  defaults: { providerOptions: { openai: { store: false } } },
})

const decodeWebSocketMessage = ProviderShared.validateWith(Schema.decodeUnknownEffect(OpenAIResponsesWebSocketMessage))

const webSocketMessage = (body: OpenAIResponsesBody | Record<string, unknown>) =>
  Effect.gen(function* () {
    if (!ProviderShared.isRecord(body))
      return yield* ProviderShared.invalidRequest("OpenAI Responses WebSocket body must be a JSON object")
    const { stream: _stream, ...message } = body
    return yield* decodeWebSocketMessage({ ...message, type: "response.create" })
  })

export const webSocketTransport = WebSocketTransport.jsonTransport.with<
  OpenAIResponsesBody,
  OpenAIResponsesWebSocketMessage
>({
  toMessage: webSocketMessage,
  encodeMessage: encodeWebSocketMessage,
})

export const webSocketRoute = Route.make({
  id: `${ADAPTER}-websocket`,
  provider: "openai",
  providerMetadataKey: "openai",
  protocol,
  endpoint,
  auth,
  transport: webSocketTransport,
  defaults: { providerOptions: { openai: { store: false } } },
})

export * as OpenAIResponses from "./openai-responses"
