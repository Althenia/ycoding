import { Option, Schema } from "effect";
import {
  AuthenticationReason,
  ContentPolicyReason,
  InvalidRequestReason,
  LLMError,
  ProviderErrorEvent,
  ProviderInternalReason,
  QuotaExceededReason,
  RateLimitReason,
  UnknownProviderReason,
  HttpRateLimitDetails,
  type HttpContext,
  type ProviderMetadata,
} from "./schema";

const patterns = [
  /prompt is too long/i,
  /request_too_large/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i,
  /input token count.*exceeds the maximum/i,
  /tokens in request more than max tokens allowed/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i,
  /exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /context[_ ]length[_ ]exceeded/i,
  /request entity too large/i,
  /context length is only \d+ tokens/i,
  /input length.*exceeds.*context length/i,
  /prompt too long; exceeded (?:max )?context length/i,
  /too large for model with \d+ maximum context length/i,
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i,
  /model_context_window_exceeded/i,
  /too many tokens/i,
  /token limit exceeded/i,
];

const exclusions = [
  /^(throttling error|service unavailable):/i,
  /rate limit/i,
  /too many requests/i,
];

export const isContextOverflow = (message: string) =>
  !exclusions.some((pattern) => pattern.test(message)) &&
  (patterns.some((pattern) => pattern.test(message)) ||
    /^4(00|13)\s*(status code)?\s*\(no body\)/i.test(message));

export const isContextOverflowFailure = (failure: unknown) =>
  failure instanceof LLMError
    ? failure.reason._tag === "InvalidRequest" &&
      failure.reason.classification === "context-overflow"
    : Schema.is(ProviderErrorEvent)(failure) &&
      failure.classification === "context-overflow";

const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);
const QUOTA_CODES = new Set([
  "insufficient_quota",
  "usage_not_included",
  "billing_error",
]);
const SERVER_CODES = new Set([
  "api_error",
  "internal_error",
  "internalserverexception",
  "modelstreamerrorexception",
  "overloaded_error",
  "server_error",
  "server_is_overloaded",
  "serviceunavailableexception",
]);
const INVALID_REQUEST_CODES = new Set([
  "invalid_prompt",
  "invalid_request_error",
  "validationexception",
]);
const RATE_LIMIT_TEXT =
  /rate increased too quickly|rate[-_\s]?limit|too[_\s]?many[_\s]?requests/i;
const QUOTA_TEXT = /insufficient[-_\s]?quota|quota[-_\s]?exceeded/i;
const CONTENT_POLICY_TEXT = /content[-_\s]?policy|content_filter|safety/i;

export interface ProviderFailure {
  readonly message: string;
  readonly status?: number | undefined;
  readonly code?: string | undefined;
  readonly retryAfterMs?: number | undefined;
  readonly rateLimit?: HttpRateLimitDetails | undefined;
  readonly http?: HttpContext | undefined;
  readonly providerMetadata?: ProviderMetadata | undefined;
}

// Anthropic reports Claude subscription OAuth usage under the `unified` scope;
// org/API keys report per-resource scopes such as `requests`
// or `input-tokens`. Keeping the scope names lets the failure message say which
// limit was hit instead of a bare provider code.
const UNIFIED_SCOPE = /^unified(?:-|$)/;

export function retryAfterMsFromHeaders(headers: Record<string, string>) {
  const milliseconds = Number(headers["retry-after-ms"]);
  if (Number.isFinite(milliseconds)) return Math.max(0, milliseconds);

  const value = headers["retry-after"];
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

const addRateLimitValue = (
  target: Record<string, string>,
  key: string,
  value: string,
) => {
  if (key.length > 0) target[key] = value;
};

export function rateLimitDetails(
  headers: Record<string, string>,
  retryAfterMs: number | undefined,
) {
  const limit: Record<string, string> = {};
  const remaining: Record<string, string> = {};
  const reset: Record<string, string> = {};

  Object.entries(headers).forEach(([name, value]) => {
    const openaiLimit = /^x-ratelimit-limit-(.+)$/.exec(name)?.[1];
    if (openaiLimit) return addRateLimitValue(limit, openaiLimit, value);

    const openaiRemaining = /^x-ratelimit-remaining-(.+)$/.exec(name)?.[1];
    if (openaiRemaining)
      return addRateLimitValue(remaining, openaiRemaining, value);

    const openaiReset = /^x-ratelimit-reset-(.+)$/.exec(name)?.[1];
    if (openaiReset) return addRateLimitValue(reset, openaiReset, value);

    const anthropic = /^anthropic-ratelimit-(.+)-(limit|remaining|reset)$/.exec(
      name,
    );
    if (!anthropic) return;
    if (anthropic[2] === "limit")
      return addRateLimitValue(limit, anthropic[1], value);
    if (anthropic[2] === "remaining")
      return addRateLimitValue(remaining, anthropic[1], value);
    return addRateLimitValue(reset, anthropic[1], value);
  });

  if (
    retryAfterMs === undefined &&
    Object.keys(limit).length === 0 &&
    Object.keys(remaining).length === 0 &&
    Object.keys(reset).length === 0
  )
    return undefined;

  return new HttpRateLimitDetails({
    retryAfterMs,
    limit: Object.keys(limit).length === 0 ? undefined : limit,
    remaining: Object.keys(remaining).length === 0 ? undefined : remaining,
    reset: Object.keys(reset).length === 0 ? undefined : reset,
  });
}

const retryAfterText = (milliseconds: number) => {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 120) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
};

// Turn whatever the provider actually told us (retry-after, reset windows, the
// scope that ran out) into one actionable clause. Header values are provider
// metadata only; secrets are redacted before they ever reach this point.
const rateLimitHint = (input: ProviderFailure) => {
  const rateLimit = input.rateLimit ?? input.http?.rateLimit;
  const reset = rateLimit?.reset ?? {};
  const scopes = [
    ...Object.keys(rateLimit?.limit ?? {}),
    ...Object.keys(rateLimit?.remaining ?? {}),
    ...Object.keys(reset),
  ];
  const parts: string[] = [];
  if (scopes.some((scope) => UNIFIED_SCOPE.test(scope)))
    parts.push("Claude subscription usage limit reached");
  const retryAfterMs = input.retryAfterMs ?? rateLimit?.retryAfterMs;
  if (retryAfterMs !== undefined)
    parts.push(`retry after ${retryAfterText(retryAfterMs)}`);
  Object.entries(reset)
    .sort(([left], [right]) => left.localeCompare(right))
    .forEach(([scope, value]) => parts.push(`${scope} resets at ${value}`));
  return parts.length === 0 ? undefined : parts.join("; ");
};

const rateLimitReason = (input: ProviderFailure, common: CommonReason) => {
  const hint = rateLimitHint(input);
  return new RateLimitReason({
    ...common,
    message:
      hint === undefined ? common.message : `${common.message} (${hint})`,
    retryAfterMs:
      input.retryAfterMs ??
      input.rateLimit?.retryAfterMs ??
      input.http?.rateLimit?.retryAfterMs,
    rateLimit: input.rateLimit ?? input.http?.rateLimit,
  });
};

interface CommonReason {
  readonly message: string;
  readonly providerMetadata: ProviderMetadata | undefined;
  readonly http: HttpContext | undefined;
}

// Keep HTTP failures and provider-reported stream failures on one typed path so
// session retry policy never needs provider-specific string matching.
export function classifyProviderFailure(
  input: ProviderFailure,
): LLMError["reason"] {
  const body = input.http?.body ?? "";
  const codes = [
    input.code,
    ...providerCodes(body),
    ...providerCodes(input.message),
  ]
    .filter((code): code is string => code !== undefined)
    .map((code) => code.toLowerCase());
  const text = body || input.message;
  const common = {
    message: input.message,
    providerMetadata: input.providerMetadata,
    http: input.http,
  };
  const clientScoped =
    input.status === undefined || (input.status >= 400 && input.status < 500);

  if (
    clientScoped &&
    (codes.includes("context_length_exceeded") ||
      codes.includes("model_context_window_exceeded") ||
      isContextOverflow(text))
  )
    return new InvalidRequestReason({
      ...common,
      classification: "context-overflow",
    });
  if (CONTENT_POLICY_TEXT.test(text)) return new ContentPolicyReason(common);
  if (
    codes.some((code) => QUOTA_CODES.has(code)) ||
    (input.status === 429 && QUOTA_TEXT.test(text))
  )
    return new QuotaExceededReason(common);
  if (input.status === 401)
    return new AuthenticationReason({ ...common, kind: "invalid" });
  if (input.status === 403)
    return new AuthenticationReason({
      ...common,
      kind: "insufficient-permissions",
    });
  if (codes.includes("authentication_error"))
    return new AuthenticationReason({ ...common, kind: "invalid" });
  if (codes.includes("permission_error"))
    return new AuthenticationReason({
      ...common,
      kind: "insufficient-permissions",
    });
  if (
    codes.some(
      (code) =>
        code.includes("rate_limit") ||
        code === "too_many_requests" ||
        code === "throttlingexception",
    )
  )
    return rateLimitReason(input, common);
  if (RATE_LIMIT_TEXT.test(text)) return rateLimitReason(input, common);
  if (
    codes.some(
      (code) =>
        SERVER_CODES.has(code) ||
        code.includes("exhausted") ||
        code.includes("unavailable"),
    )
  )
    return new ProviderInternalReason({
      ...common,
      status: input.status,
      retryAfterMs: input.retryAfterMs,
    });
  if (input.status === 429) {
    return rateLimitReason(input, common);
  }
  if (input.status !== undefined && input.status >= 500)
    return new ProviderInternalReason({
      ...common,
      status: input.status,
      retryAfterMs: input.retryAfterMs,
    });
  if (codes.some((code) => INVALID_REQUEST_CODES.has(code)))
    return new InvalidRequestReason(common);
  if (
    input.status === 400 ||
    input.status === 404 ||
    input.status === 409 ||
    input.status === 413 ||
    input.status === 422
  )
    return new InvalidRequestReason(common);
  return new UnknownProviderReason({ ...common, status: input.status });
}

function providerCodes(value: string) {
  const decoded = Option.getOrUndefined(decodeJson(value));
  if (!isRecord(decoded)) return [];
  const error = isRecord(decoded.error) ? decoded.error : undefined;
  return [decoded.code, error?.code, error?.type].filter(
    (value): value is string => typeof value === "string",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
