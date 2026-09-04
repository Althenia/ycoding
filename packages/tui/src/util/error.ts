import { isRecord } from "./record"

type ConfigIssue = { message: string; path: string[] }

function isMaxListenersNoise(input: unknown): boolean {
  const text =
    typeof input === "string"
      ? input
      : input instanceof Error
        ? `${input.name}: ${input.message}\n${input.stack ?? ""}`
        : isRecord(input) && typeof input.message === "string"
          ? input.message
          : String(input ?? "")
  return text.includes("MaxListenersExceededWarning") || (text.includes("Possible EventEmitter memory leak") && text.includes("resize"))
}

export function cliErrorMessage(input: unknown): string | undefined {
  if (isMaxListenersNoise(input)) return undefined
  if (input instanceof Error && isRecord(input.cause) && "body" in input.cause) {
    const formatted = cliErrorMessage(input.cause.body)
    if (formatted) return formatted
  }

  if (tagged(input, "CliError")) {
    if (typeof input.exitCode === "number") process.exitCode = input.exitCode
    return field(input, "message") ?? ""
  }
  if (tagged(input, "AccountServiceError") || tagged(input, "AccountTransportError")) {
    return field(input, "message") ?? ""
  }

  const model = configData(input, "ProviderModelNotFoundError")
  if (model) {
    const suggestions = Array.isArray(model.suggestions)
      ? model.suggestions.filter((item): item is string => typeof item === "string")
      : []
    return [
      `Model not found: ${field(model, "providerID")}/${field(model, "modelID")}`,
      ...(suggestions.length ? ["Did you mean: " + suggestions.join(", ")] : []),
      "Try: `ycoding models` to list available models",
      "Or check your config (ycoding.json) provider/model names",
    ].join("\n")
  }

  const provider = configData(input, "ProviderInitError")
  if (provider)
    return `Failed to initialize provider "${field(provider, "providerID")}". Check credentials and configuration.`

  const json = configData(input, "ConfigJsonError")
  if (json) {
    const message = field(json, "message")
    return `Config file at ${field(json, "path")} is not valid JSON(C)` + (message ? `: ${message}` : "")
  }

  const directory = configData(input, "ConfigDirectoryTypoError")
  if (directory) {
    return `Directory "${field(directory, "dir")}" in ${field(directory, "path")} is not valid. Rename the directory to "${field(directory, "suggestion")}" or remove it. This is a common typo.`
  }

  const frontmatter = configData(input, "ConfigFrontmatterError")
  if (frontmatter) return field(frontmatter, "message") ?? ""

  const invalid = configData(input, "ConfigInvalidError")
  if (invalid) {
    const path = field(invalid, "path")
    const message = field(invalid, "message")
    const issues = Array.isArray(invalid.issues)
      ? invalid.issues.filter((issue): issue is ConfigIssue => {
          return (
            isRecord(issue) &&
            typeof issue.message === "string" &&
            Array.isArray(issue.path) &&
            issue.path.every((item) => typeof item === "string")
          )
        })
      : []
    return [
      `Configuration is invalid${path && path !== "config" ? ` at ${path}` : ""}` + (message ? `: ${message}` : ""),
      ...issues.map((issue) => "↳ " + issue.message + " " + issue.path.join(".")),
    ].join("\n")
  }

  if (tagged(input, "UICancelledError") || named(input, "UICancelledError")) return ""
  if (isRecord(input) && named(input, "MCPFailed")) {
    const name = isRecord(input.data) ? field(input.data, "name") : undefined
    return `MCP server "${name}" failed. Note, ycoding does not support MCP authentication yet.`
  }
  return undefined
}

function tagged(input: unknown, tag: string): input is Record<string, unknown> {
  return isRecord(input) && input._tag === tag
}

function named(input: unknown, name: string) {
  return isRecord(input) && (input.name === name || input._tag === name)
}

function configData(input: unknown, tag: string) {
  if (!isRecord(input)) return undefined
  if (input.name === tag && isRecord(input.data)) return input.data
  if (input._tag === tag) return input
  return undefined
}

function field(input: Record<string, unknown>, key: string) {
  return typeof input[key] === "string" ? input[key] : undefined
}

function modelRefText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const providerID = typeof value.providerID === "string" ? value.providerID : undefined
  const id = typeof value.id === "string" ? value.id : undefined
  if (!providerID || !id) return undefined
  const variant = typeof value.variant === "string" && value.variant !== "default" ? `#${value.variant}` : ""
  return `${providerID}/${id}${variant}`
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function formatModelSwitchBlocked(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined
  const data = input._tag === "ModelSwitchBlockedError" || input.name === "ModelSwitchBlockedError" ? input : undefined
  if (!data) return undefined
  const current = modelRefText(data.currentModel)
  const target = modelRefText(data.targetModel)
  const currentContextTokens = tokenCount(data.currentContextTokens)
  const targetSafeInputTokens = tokenCount(data.targetSafeInputTokens)
  const requiredReductionTokens = tokenCount(data.requiredReductionTokens)
  const boundary = typeof data.maximumSafeSummaryBoundary === "string" ? data.maximumSafeSummaryBoundary : undefined
  const parts = [
    current && target ? `from ${current} to ${target}` : undefined,
    currentContextTokens !== undefined && targetSafeInputTokens !== undefined
      ? `context ${currentContextTokens} tokens exceeds target safe input ${targetSafeInputTokens} tokens`
      : undefined,
    requiredReductionTokens !== undefined ? `reduce by ${requiredReductionTokens} tokens` : undefined,
    boundary ? `summary boundary ${boundary}` : undefined,
  ].filter((part): part is string => typeof part === "string" && part.length > 0)
  if (parts.length === 0) return "Model switch blocked: target context window exceeded"
  return `Model switch blocked (${parts.join("; ")})`
}

function isBarePlaceholder(text: string): boolean {
  const trimmed = text.trim()
  return trimmed === "{" || trimmed === "{}"
}

function nestedCauseMessage(cause: unknown): string | undefined {
  if (cause === undefined || cause === null) return undefined
  if (typeof cause === "string") return cause || undefined
  if (isRecord(cause) && "body" in cause) {
    const message = errorMessage(cause.body)
    if (message) return message
  }
  if (cause instanceof Error) return errorMessage(cause)
  if (isRecord(cause) && typeof cause.message === "string" && cause.message) return cause.message
  return undefined
}

function unwrapBarePlaceholder(text: string): string {
  return isBarePlaceholder(text) ? "unknown error" : text
}

export function errorFormat(error: unknown): string {
  if (isMaxListenersNoise(error)) return ""
  if (typeof error === "string" && isBarePlaceholder(error)) return "unknown error"
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`
  }

  if (typeof error === "object" && error !== null) {
    try {
      const json = JSON.stringify(error, null, 2)
      // Plain objects whose own properties are all non-enumerable (or empty)
      // serialize to "{}", which prints as a useless bare `{}` on stderr.
      // Fall back to a custom toString first, then to ctor name + own prop names.
      if (json === "{}") {
        const str = String(error)
        if (str && str !== "[object Object]") return str
        const ctor = error.constructor?.name
        const prefix = ctor && ctor !== "Object" ? ctor : "Error"
        const names = Object.getOwnPropertyNames(error)
        return names.length === 0 ? `${prefix} (no message)` : `${prefix} { ${names.join(", ")} }`
      }
      return json
    } catch {
      return "Unexpected error (unserializable)"
    }
  }

  return String(error)
}

export function errorMessage(error: unknown): string {
  if (isMaxListenersNoise(error)) return ""
  const blocked = formatModelSwitchBlocked(error)
  if (blocked) return blocked
  if (error instanceof Error) {
    const nested = nestedCauseMessage(error.cause)
    if (nested && !isBarePlaceholder(nested)) return nested
    if (error.message && !isBarePlaceholder(error.message)) return error.message
    if (nested) return nested
    if (error.message) return unwrapBarePlaceholder(error.message)
    if (error.name) return error.name
  }

  if (isRecord(error) && typeof error.message === "string" && error.message && !isBarePlaceholder(error.message)) {
    return error.message
  }

  if (isRecord(error) && isRecord(error.data) && typeof error.data.message === "string" && error.data.message) {
    if (!isBarePlaceholder(error.data.message)) return error.data.message
  }

  const text = String(error)
  if (isBarePlaceholder(text)) return "unknown error"
  if (text && text !== "[object Object]") return text

  const formatted = errorFormat(error)
  if (formatted) return formatted
  return "unknown error"
}

export function errorData(error: unknown) {
  if (error instanceof Error) {
    return {
      type: error.name,
      message: errorMessage(error),
      stack: error.stack,
      cause: error.cause === undefined ? undefined : errorFormat(error.cause),
      formatted: errorFormat(error),
    }
  }

  if (!isRecord(error)) {
    return {
      type: typeof error,
      message: errorMessage(error),
      formatted: errorFormat(error),
    }
  }

  const data = Object.getOwnPropertyNames(error).reduce<Record<string, unknown>>((acc, key) => {
    const value = error[key]
    if (value === undefined) return acc
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      acc[key] = value
      return acc
    }
    // oxlint-disable-next-line no-base-to-string -- intentional coercion of arbitrary error properties
    acc[key] = value instanceof Error ? value.message : String(value)
    return acc
  }, {})

  if (typeof data.message !== "string") data.message = errorMessage(error)
  if (typeof data.type !== "string") data.type = error.constructor?.name
  data.formatted = errorFormat(error)
  return data
}
