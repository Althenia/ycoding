import { Dots } from "@ycoding-ai/schema/dots"
import { McpEvents } from "@ycoding-ai/schema/mcp-events"
import { SessionID } from "@ycoding-ai/schema/session-id"
import { Schema } from "effect"

const decodeRequestContext = Schema.decodeUnknownOption(McpEvents.RequestContext)
const decodeExchangeID = Schema.decodeUnknownOption(Dots.ExchangeCreate.fields.exchangeID)
const decodeSessionID = Schema.decodeUnknownOption(SessionID)
const decodeExchangeMetadata = Schema.decodeUnknownOption(Dots.ExchangeMetadata)

export function dotsPeerLabel(metadata: unknown): string | undefined {
  return dotsPeerAttribution(metadata)?.label
}

export function dotsPeerAttribution(metadata: unknown) {
  if (typeof metadata !== "object" || metadata === null) return undefined
  const peer = Dots.peer({ dots: Reflect.get(metadata, "dots") })
  if (peer) return { label: sanitize(`Dot ${peer.dotID} · external peer · ${peer.threadID}`), details: undefined }
  const remote = remoteMcpAttribution(metadata)
  return remote && { label: sanitize(remote.label), details: remote.details === undefined ? undefined : sanitize(remote.details) }
}

function remoteMcpAttribution(metadata: object) {
  if (Reflect.get(metadata, "inputOrigin") !== "plugin") return undefined
  const source = Reflect.get(metadata, "remoteMcp")
  if (typeof source !== "object" || source === null) return undefined
  const principal = Reflect.get(source, "principal")
  const context = decodeRequestContext({
    ...Object.fromEntries(Object.entries(source)),
    principal: typeof principal === "object" && principal !== null ? Object.fromEntries(Object.entries(principal)) : principal,
  }, { onExcessProperty: "error" })
  if (context._tag === "None") return undefined
  const label = `Remote MCP · external peer · ${context.value.principal.clientID}`
  const exchange = Reflect.get(metadata, "dotsExchange")
  if (typeof exchange !== "object" || exchange === null) return { label, details: undefined }
  const attachment = Reflect.get(exchange, "attachment")
  const named = decodeExchangeMetadata({
    ...Object.fromEntries(Object.entries(exchange)),
    attachment: typeof attachment === "object" && attachment !== null ? Object.fromEntries(Object.entries(attachment)) : attachment,
  }, { onExcessProperty: "error" })
  if (Reflect.get(exchange, "envelope") !== undefined && (named._tag === "None" || !envelopeMatches(named.value, context.value))) return { label, details: undefined }
  if (named._tag === "Some") return {
    label: `${named.value.attachment.label} · external peer · Remote MCP · user-chosen name`,
    details: `Client ${context.value.principal.clientID} · Profile ${named.value.attachment.profile} · Dot ${named.value.attachment.dotID} · Conversation ${named.value.attachment.threadID} · Generation ${named.value.attachment.generation} · Attachment Session ${named.value.sessionID} · Target Session ${named.value.targetSessionID} · Exchange ${named.value.exchangeID}`,
  }
  const exchangeID = decodeExchangeID(Reflect.get(exchange, "exchangeID"))
  if (exchangeID._tag === "None" || decodeSessionID(Reflect.get(exchange, "sessionID"))._tag === "None") return { label, details: undefined }
  return { label: `${label} · exchange ${exchangeID.value}`, details: undefined }
}

function envelopeMatches(exchange: Dots.ExchangeMetadata, context: McpEvents.RequestContext) {
  const envelope = exchange.envelope
  return (
    envelope !== undefined &&
    envelope.exchangeID === exchange.exchangeID &&
    envelope.targetSessionID === exchange.targetSessionID &&
    envelope.scope.epoch === context.epoch &&
    envelope.coordinator.ownerID === context.principal.ownerID &&
    envelope.coordinator.deviceID === context.principal.deviceID &&
    envelope.coordinator.clientID === context.principal.clientID
  )
}

const sanitize = (label: string) => label.replace(/[\u0000-\u001f\u007f-\u009f]/g, "�")
