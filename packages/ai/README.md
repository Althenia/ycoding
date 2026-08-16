# @ycoding-ai/ai

Schema-first AI primitives for ycoding. Provider quirks live in adapters, not in calling code.

```ts
import { Effect } from "effect"
import { LLM, LLMClient } from "@ycoding-ai/ai"
import { OpenAI } from "@ycoding-ai/ai/providers"

const model = OpenAI.configure({ apiKey: process.env.OPENAI_API_KEY }).responses("gpt-4o-mini")

const request = LLM.request({
  model,
  system: "You are concise.",
  prompt: "Say hello in one short sentence.",
  generation: { maxTokens: 40 },
})

const program = Effect.gen(function* () {
  const response = yield* LLMClient.generate(request)
  console.log(response.text)
})
```

Run `LLMClient.stream(request)` instead of `generate` when you want incremental `LLMEvent`s. The event stream is provider-neutral — the same shape across direct OpenAI Responses, Anthropic Messages, Gemini, Bedrock Converse, and explicitly configured OpenAI-compatible Chat or Responses deployments.

## Image generation

Use `Image.generate` with an image model for direct asset generation:

```ts
import { Image, ImageInput } from "@ycoding-ai/ai"
import { OpenAI } from "@ycoding-ai/ai/providers"

const program = Effect.gen(function* () {
  const response = yield* Image.generate({
    model: OpenAI.configure({ apiKey: process.env.OPENAI_API_KEY }).image("gpt-image-2"),
    prompt: "A robot tending a rooftop garden",
    options: {
      n: 2,
      size: "1024x1024",
      quality: "high", // inferred from the OpenAI image model
      outputFormat: "webp",
      future_option: true, // unknown native options pass through unchanged
    },
  })

  return response.images // GeneratedImage[] with owned bytes or a provider URL
})
```

Pass ordered image inputs to the same method for editing, composition, or image-conditioned generation:

```ts
const response =
  yield *
  Image.generate({
    model,
    prompt: "Combine these product photos into one studio scene",
    images: [
      ImageInput.bytes(firstBytes, "image/png"),
      ImageInput.url("https://example.com/second.webp"),
      ImageInput.file("file_123"),
    ],
    options,
    http,
  })
```

`ImageInput.fileUri(uri, mediaType)` represents provider file URIs such as Gemini Files. Raw strings are not
accepted as image inputs, avoiding ambiguity between base64, URLs, and provider IDs. Empty or omitted `images`
uses text-to-image generation; a non-empty array selects the provider's edit behavior without enforcing provider
image-count limits locally. `images` is the only common image-editing field. OpenAI uses multipart for byte/data-URL
edits and its JSON reference body for URL or file-ID edits. Its provider-specific `options.mask` accepts an
`ImageInput` for inpainting:

```ts
yield *
  Image.generate({
    model: OpenAI.configure({ apiKey }).image("gpt-image-2"),
    prompt,
    images: [ImageInput.bytes(sourceBytes, "image/png")],
    options: { mask: ImageInput.bytes(maskBytes, "image/png") },
  })
```

The OpenAI adapter extracts this helper value into the edit request's native `mask` field rather than passing the
tagged `ImageInput` object through as an ordinary option. On multipart requests, `http.body` can override option
fields but not structural `model`, `prompt`, `image[]`, or `mask` fields, and the transport owns the multipart
`Content-Type` boundary. For JSON requests, `http.body` remains the final raw-native overlay. Gemini does not fetch
public HTTP URLs, and hosted Z.ai image generation does not accept image inputs. These cases fail with
`InvalidRequest` before network I/O.

Provider-native image options belong to each request. Raw `http.body` fields have final precedence over them:

```ts
const model = OpenAI.configure({ apiKey }).image("gpt-image-2")

yield *
  Image.generate({
    model,
    prompt,
    options: { quality: "medium" },
    http,
  })
```

xAI image models use the same request API with xAI-native controls:

```ts
yield *
  Image.generate({
    model: XAI.configure({ apiKey }).image("any-model-id"),
    prompt,
    options: {
      n: 2,
      aspectRatio: "16:9",
      resolution: "1k",
      responseFormat: "b64_json",
      future_option: true,
    },
    http,
  })
```

Google's current Gemini image models use the same direct API:

```ts
import { Google } from "@ycoding-ai/ai/providers"

const googleProgram = Effect.gen(function* () {
  const response = yield* Image.generate({
    model: Google.configure({ apiKey }).image("any-model-id"),
    prompt: "A robot tending a rooftop garden",
    options: {
      aspectRatio: "16:9",
      imageSize: "2K",
      seed: 42,
      thinkingLevel: "HIGH",
      includeThoughts: true,
      futureOption: true,
    },
    http,
  })

  return response.images
})
```

Google image options are request-scoped and inferred from the selected model. Known fields autocomplete while
future string values and arbitrary native Gemini `generationConfig` fields remain available. Native fields override
their mapped aliases, and `http.body` is the final deep overlay. The selected model ID is sent to Gemini
`generateContent` without a local allowlist.

Z.ai image models infer open Z.ai-native options from the selected model:

```ts
yield *
  Image.generate({
    model: ZAI.configure({ apiKey }).image("any-model-id"),
    prompt,
    options: {
      quality: "hd",
      userID: "user-123",
      future_option: true,
    },
    http,
  })
```

Z.ai does not include trustworthy MIME metadata for output URLs, so generated images use
`application/octet-stream`. Output URLs expire after 30 days; download and persist them promptly if they must
remain available.

Conversational image generation remains part of the LLM interaction. OpenAI Responses exposes it through its hosted image tool:

```ts
const program = Effect.gen(function* () {
  const response = yield* LLM.generate(
    LLM.request({
      model: OpenAI.configure({ apiKey }).responses("gpt-5"),
      prompt: "Design a solarpunk rooftop garden, then show me.",
      tools: [OpenAI.imageGeneration({ quality: "high" })],
    }),
  )

  return response.message
})
```

The hosted result is represented as a provider-executed tool call and tool result. Its image is a `file` content item with a data URI, so retaining `response.message` preserves the generated image for continuation.

## Public API

- **`LLM.request({...})`** — build a provider-neutral `LLMRequest`. Accepts ergonomic inputs (`system: string`, `prompt: string`) that normalize into the canonical Schema classes.
- **`LLM.generate` / `LLM.stream`** — re-exported from `LLMClient` for one-import use.
- **`Message.user(...)` / `Message.assistant(...)` / `Message.tool(...)`** — message constructors from the canonical schema model.
- **`Model.make(...)` / `ToolCallPart.make(...)` / `ToolResultPart.make(...)` / `ToolDefinition.make(...)`** — model and tool-related constructors from the canonical schema model.
- **`LLMClient.prepare(request)`** — compile a request through protocol body construction, validation, and HTTP preparation without sending. Useful for inspection and testing.
- **`LLMEvent.is.*`** — typed guards (`is.textDelta`, `is.toolCall`, `is.finish`, …) for filtering streams.
- **`Image.generate({...})`** — generate images through a provider-neutral image request and response model.
- **`ImageClient`** — Effect service and layer for image execution, parallel to `LLMClient`.

## Caching

Prompt caching is **on by default**. Every `LLMRequest` resolves to `cache: "auto"` unless the caller opts out with `cache: "none"`. Each protocol translates `CacheHint`s to its wire format. Anthropic uses `cache_control`, Bedrock uses `cachePoint`, and pre-GPT-5.6 OpenAI, Codex, compatible OpenAI routes, and Gemini use key-only or implicit provider caching. Direct public GPT-5.6 OpenAI routes also support explicit markers.

### Auto placement

`"auto"` places up to four breakpoints — the last tool definition, the last system part, and the two most recent cacheable messages — on providers that serialize those marker types. Direct public GPT-5.6 OpenAI routes generate one combined system-text marker and selected user/assistant text markers only. Chat serializes marked assistant text through native `text` arrays; Responses serializes a marked assistant message through `input_text` EasyInput blocks and otherwise preserves `output_text`. Tool definitions, tool results, and unsupported content receive no generated GPT-5.6 marker, though they can remain inside a later cached prefix.

The math justifies the default: Anthropic's 5-minute cache write is 1.25× base, read is 0.1×, so a single reuse within 5 minutes already wins. One-shot completions below the per-model minimum-cacheable-token threshold silently no-op on the wire, so the worst case is harmless.

### Opting out

```ts
LLM.request({
  model,
  system,
  prompt: "one-off question",
  cache: "none",
})
```

### Granular policy

```ts
cache: {
  tools?: boolean,
  system?: boolean,
  messages?: "latest-user-message" | "latest-assistant" | { tail: number },
  ttlSeconds?: number,         // ≥ 3600 → 1h on Anthropic/Bedrock; else 5m
}
```

### Manual hints

Inline `CacheHint` controls provider-native placement where the selected route can serialize it. Direct public GPT-5.6 OpenAI routes emit generated markers only for combined system text and user/assistant text; they do not serialize tool-definition or tool-result markers. The auto policy preserves supported manual hints and fills eligible gaps.

```ts
LLM.request({
  model,
  system: [
    { type: "text", text: "stable system prompt", cache: { type: "ephemeral" } },
  ],
  ...
})
```

### Provider behavior table

| Protocol                                                         | `cache: "auto"`                                                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Anthropic Messages                                               | emits up to 4 `cache_control` markers (4-breakpoint cap enforced)                          |
| Bedrock Converse                                                 | emits up to 4 `cachePoint` blocks (4-breakpoint cap enforced)                              |
| Direct OpenAI Responses before GPT-5.6, Codex, compatible routes | key-only or implicit provider caching                                                      |
| Direct OpenAI Responses GPT-5.6+                                 | combined system and user/assistant text markers; marked assistant replay uses `input_text` |
| Gemini                                                           | no-op (implicit caching on 2.5+; explicit `CachedContent` is out-of-band)                  |

Normalized cache usage is read back into `response.usage.cacheReadInputTokens` and `cacheWriteInputTokens` across every provider.

## Providers

Provider facades configure endpoint/auth/deployment details first, then expose model selectors that take only a model or deployment id. The selected model carries the executable route value used at runtime.

```ts
import { OpenAI, CloudflareAIGateway } from "@ycoding-ai/ai/providers"

const openai = OpenAI.configure({ apiKey: process.env.OPENAI_API_KEY }).responses("gpt-4o-mini")
const gateway = CloudflareAIGateway.configure({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  gatewayApiKey: process.env.CLOUDFLARE_API_TOKEN,
}).model("workers-ai/@cf/meta/llama-3.1-8b-instruct")
```

Included providers: OpenAI, Anthropic, Google (Gemini), Google Vertex Gemini and Anthropic, Amazon Bedrock, Azure OpenAI, Cloudflare AI Gateway, Cloudflare Workers AI, GitHub Copilot, OpenRouter, xAI, Z.ai, plus generic OpenAI-compatible Chat and Responses entrypoints and an Anthropic Messages-compatible entrypoint.

### Package-like entrypoints

Native catalog integrations load provider behavior through package-like entrypoints. These are export paths from the same `@ycoding-ai/ai` npm package, not independently published packages. Each entrypoint exports the same `model(modelID, settings)` contract, and `settings` contains serializable provider configuration plus common `headers`, `body`, and `limits` overlays.

```ts
import { model } from "@ycoding-ai/ai/providers/openai/responses"

const selected = model("gpt-5", {
  apiKey: process.env.OPENAI_API_KEY,
  transport: "websocket",
  headers: { "x-application": "ycoding" },
  limits: { context: 200_000, output: 64_000 },
})
```

Direct OpenAI has one Responses semantic entrypoint:

- `@ycoding-ai/ai/providers/openai/responses`
- `@ycoding-ai/ai/providers/openai-compatible/responses`
- `@ycoding-ai/ai/providers/anthropic-compatible`
- `@ycoding-ai/ai/providers/google-vertex/gemini`
- `@ycoding-ai/ai/providers/google-vertex/chat`
- `@ycoding-ai/ai/providers/google-vertex/responses`
- `@ycoding-ai/ai/providers/google-vertex/messages`

Responses HTTP versus WebSocket is a scoped `transport` setting on the direct OpenAI Responses entrypoint, not another entrypoint. The removed direct OpenAI Chat facade and entrypoint are not public surfaces. Azure retains its separate Chat/Responses entrypoints at `providers/azure/chat` and `providers/azure/responses`. Generic OpenAI-compatible Chat remains at `providers/openai-compatible` for third-party Chat deployments; compatible Responses is separate at `providers/openai-compatible/responses`. Generic Anthropic Messages-compatible providers use `providers/anthropic-compatible`, which the named Anthropic provider composes. Google Gemini and Amazon Bedrock expose their single native API through their existing provider paths.

### Direct OpenAI Responses lifecycle

Direct GPT-5.6 Responses defaults to stateless `store: false`, requests encrypted reasoning replay metadata, and enables server-side context management at a 200,000-token threshold. A returned encrypted compaction item is opaque state: the next stateless request replays that item for the same model and prunes input before the compaction boundary. This does not enable stored-response continuation.

`OpenAI.webSearch(...)` adds OpenAI's hosted `web_search` Responses tool. It runs at OpenAI and its provider-executed call item is replayed on stateless follow-ups. URL citations are appended to assistant text as a `Source: <title>` line followed by the URL, so canonical and durable transcripts retain the provider's attribution. Hosted search is distinct from YCoding Core's local `websearch` tool, which selects Exa or Parallel independently of the model provider.

Direct OpenAI Responses lowers user image attachments and local tool-result images as `input_image` content. Set `providerOptions.openai.imageDetail` to `"auto"`, `"low"`, `"high"`, or `"original"`; omitting it leaves OpenAI's default `auto` behavior unchanged. `"original"` requires a supported GPT-5.4-or-later family (not GPT-5.4 mini or nano). Remote image URL and `file_id` references are not implemented.

Vertex Gemini, Vertex Chat, Vertex Responses, and Vertex Messages are separate API entrypoints. All accept `project`, `location`, and an optional `accessToken`; when no explicit token or auth override is supplied they lazily use Google Application Default Credentials. Vertex Gemini instead selects express mode when `apiKey` or `GOOGLE_VERTEX_API_KEY` is present. Vertex Chat targets MaaS models through the OpenAI-compatible Chat Completions endpoint, while Vertex Responses targets Grok models and defaults `store` to `false` as required by Vertex. `providers/google-vertex` remains the default alias for `providers/google-vertex/gemini`.

Tuned Vertex Gemini deployments use model ids shaped like `endpoints/1234567890` and require OAuth or ADC; Vertex express-mode API keys support publisher models only.

```ts
import { model } from "@ycoding-ai/ai/providers/google-vertex/gemini"

model("gemini-3.5-flash", { project: "my-project", location: "global" })
```

```ts
import { model } from "@ycoding-ai/ai/providers/google-vertex/chat"

model("deepseek-ai/deepseek-v3.2-maas", { project: "my-project", location: "global" })
```

```ts
import { model } from "@ycoding-ai/ai/providers/google-vertex/responses"

model("xai/grok-4.20-reasoning", { project: "my-project", location: "global" })
```

```ts
import { model } from "@ycoding-ai/ai/providers/google-vertex/messages"

model("claude-sonnet-4-6", { project: "my-project", location: "global" })
```

Provider facades such as `OpenAI.configure(...).responses(...)` remain the direct application API. Package-like entrypoints are the self-similar loading contract used when a catalog selects behavior by export path.

Other provider exports listed above remain direct facades until they explicitly implement the package-like contract. Exporting a provider facade does not implicitly make it a catalog-loadable provider package.

## Provider options & HTTP overlays

Three escape hatches in order of stability:

1. **`generation`** — portable knobs (`maxTokens`, `temperature`, `topP`, `topK`, penalties, seed, stop).
2. **`providerOptions: { <provider>: {...} }`** — typed-at-the-facade provider-specific knobs (OpenAI `promptCacheKey` and `imageDetail`, Anthropic `thinking`, Gemini `thinkingConfig`, OpenRouter routing).
3. **`http: { body, headers, query }`** — last-resort serializable overlays merged into the final HTTP request. Reach for this only when a stable typed path doesn't yet exist.

Route/provider defaults are overridden by request-level values for each axis.

## Routes

Adding a new model or deployment is usually 5-15 lines using `Route.make({ protocol, endpoint, auth, framing, ... })`. The route owns endpoint/auth/framing and the protocol owns body construction plus stream parsing. Transports are reusable IO templates that receive route endpoint/auth at compile time. Capability/catalog metadata lives outside this low-level package; unsupported request shapes fail during protocol lowering. See `AGENTS.md` for the architectural detail.

## Effect

This package is built on Effect. Public methods return `Effect` or `Stream`; provide `LLMClient.layer` for LLM dispatch and `ImageClient.layer` for image dispatch, then import the provider/protocol modules for the routes you use. The example at `example/tutorial.ts` is a runnable walkthrough.

## See also

- `AGENTS.md` — architecture, route construction, contributor guide
- `STATUS.md` — native provider parity status and AI SDK migration gaps
- `example/tutorial.ts` — runnable end-to-end walkthrough
- `test/provider/*.test.ts` — fixture-first protocol tests; `*.recorded.test.ts` files cover live cassettes
