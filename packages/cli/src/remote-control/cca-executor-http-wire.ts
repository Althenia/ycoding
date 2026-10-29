import type {
  CcaHttpBodyDelta,
  CcaHttpHeader,
  CcaHttpRedirectPolicy,
  CcaHttpRequestParams,
  CcaHttpRequestResponse,
} from "@ycoding-ai/core/cca/http"
import { decodeCcaBase64 } from "./cca-executor-fs-wire"
import { CcaRpcError } from "./cca-executor-rpc"

export const CCA_HTTP_REQUEST_METHOD = "http/request"
export const CCA_HTTP_REQUEST_BODY_DELTA_METHOD = "http/request/bodyDelta"

export interface CcaHttpHeaderWire {
  readonly name: string
  readonly value: string
  readonly valueEnvVar?: string
}

export interface CcaHttpRequestResponseWire {
  readonly status: number
  readonly headers: readonly CcaHttpHeaderWire[]
  readonly bodyBase64: string
}

export interface CcaHttpBodyDeltaWire {
  readonly requestId: string
  readonly seq: number
  readonly deltaBase64: string
  readonly done: boolean
  readonly error: string | null
}

type Fields = Record<string, unknown>

const invalid = (message: string) => new CcaRpcError(-32602, message)

function describe(value: unknown): string {
  if (value === null || value === undefined) return "null"
  if (typeof value === "boolean") return `boolean \`${value}\``
  if (typeof value === "number") return Number.isInteger(value) ? `integer \`${value}\`` : `floating point \`${value}\``
  if (typeof value === "string") return `string ${JSON.stringify(value)}`
  if (Array.isArray(value)) return "sequence"
  return "map"
}

const invalidType = (value: unknown, expected: string) => invalid(`invalid type: ${describe(value)}, expected ${expected}`)

function isFields(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function struct(value: unknown, name: string, required: readonly string[], visit: (key: string, field: unknown) => void) {
  if (!isFields(value)) throw invalidType(value, `struct ${name}`)
  for (const [key, field] of Object.entries(value)) visit(key, field)
  const missing = required.find((key) => !Object.hasOwn(value, key))
  if (missing !== undefined) throw invalid(`missing field \`${missing}\``)
}

function string(value: unknown): string {
  if (typeof value !== "string") throw invalidType(value, "a string")
  return value
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : string(value)
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw invalidType(value, "a boolean")
  return value
}

function u64(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value !== "number" || !Number.isInteger(value)) throw invalidType(value, "u64")
  if (value < 0) throw invalid(`invalid value: ${describe(value)}, expected u64`)
  return value
}

function base64(value: unknown): Uint8Array | undefined {
  if (value === null || value === undefined) return undefined
  return decodeCcaBase64(string(value))
}

function redirectPolicy(value: unknown): CcaHttpRedirectPolicy {
  if (typeof value !== "string") throw invalidType(value, "string or map")
  if (value !== "follow" && value !== "stop") throw invalid(`unknown variant \`${value}\`, expected \`follow\` or \`stop\``)
  return value
}

function header(value: unknown): CcaHttpHeader {
  let name = ""
  let headerValue = ""
  let valueEnvVar: string | undefined
  struct(value, "HttpHeader", ["name", "value"], (key, field) => {
    if (key === "name") name = string(field)
    else if (key === "value") headerValue = string(field)
    else if (key === "valueEnvVar") valueEnvVar = optionalString(field)
  })
  return valueEnvVar === undefined ? { name, value: headerValue } : { name, value: headerValue, valueEnvVar }
}

function headers(value: unknown): CcaHttpHeader[] {
  if (!Array.isArray(value)) throw invalidType(value, "a sequence")
  return value.map(header)
}

export function decodeCcaHttpRequestParams(params: unknown): CcaHttpRequestParams {
  let method = ""
  let url = ""
  let requestId = ""
  let requestHeaders: CcaHttpHeader[] = []
  let body: Uint8Array | undefined
  let timeoutMs: number | undefined
  let redirect: CcaHttpRedirectPolicy = "follow"
  let streamResponse = false
  struct(params, "HttpRequestParams", ["method", "url", "requestId"], (key, field) => {
    if (key === "method") method = string(field)
    else if (key === "url") url = string(field)
    else if (key === "headers") requestHeaders = headers(field)
    else if (key === "bodyBase64") body = base64(field)
    else if (key === "timeoutMs") timeoutMs = u64(field)
    else if (key === "redirectPolicy") redirect = redirectPolicy(field)
    else if (key === "requestId") requestId = string(field)
    else if (key === "streamResponse") streamResponse = boolean(field)
  })
  return {
    method,
    url,
    headers: requestHeaders,
    ...(body === undefined ? {} : { body }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    redirectPolicy: redirect,
    requestId,
    streamResponse,
  }
}

const encodeBase64 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64")

export function encodeCcaHttpRequestResponse(response: CcaHttpRequestResponse): CcaHttpRequestResponseWire {
  return {
    status: response.status,
    headers: response.headers.map((entry) =>
      entry.valueEnvVar === undefined
        ? { name: entry.name, value: entry.value }
        : { name: entry.name, value: entry.value, valueEnvVar: entry.valueEnvVar },
    ),
    bodyBase64: encodeBase64(response.body),
  }
}

export function encodeCcaHttpBodyDelta(delta: CcaHttpBodyDelta): CcaHttpBodyDeltaWire {
  return {
    requestId: delta.requestId,
    seq: delta.seq,
    deltaBase64: encodeBase64(delta.delta),
    done: delta.done,
    error: delta.error,
  }
}
