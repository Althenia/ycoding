import { closeSync, fsyncSync, openSync, statSync, writeSync } from "node:fs"
import path from "node:path"

export const ccaProofJournalPhases = [
  "script",
  "preflight",
  "state-load",
  "credential-selection",
  "identity-creation",
  "runtime-startup",
  "transport-start",
  "transport-open",
  "channel-established",
  "abort-observed",
  "transport-close",
  "bridge-drain",
  "handler-close",
  "executor-close",
  "authorization-release",
  "runtime-graph-close",
  "script-completion",
  "rpc-received",
  "rpc-response",
  "rpc-notification",
  "main-returned",
  "process-before-exit",
] as const

export const ccaProofRpcMethods = [
  "initialize",
  "initialized",
  "environment/info",
  "environment/status",
  "process/start",
  "process/read",
  "process/write",
  "process/signal",
  "process/terminate",
  "fs/readFile",
  "fs/writeFile",
  "fs/getMetadata",
  "fs/readDirectory",
  "fs/canonicalize",
  "capabilities/discoverV2",
  "capabilityRoots/discoverV1",
  "process/output",
  "process/exited",
  "process/closed",
  "other",
] as const

export const ccaProofRpcOutcomes = [
  "result",
  "invalid_request",
  "method_not_found",
  "invalid_params",
  "internal_error",
  "permission_denied",
  "other_error",
  "notification",
  "send_failed",
  "aborted",
] as const

export type CcaProofRpcMethod = (typeof ccaProofRpcMethods)[number]
export type CcaProofRpcOutcome = (typeof ccaProofRpcOutcomes)[number]

export type CcaProofJournalPhase = (typeof ccaProofJournalPhases)[number]
export type CcaProofJournalEvent = "started" | "completed" | "failed" | "observed"

export interface CcaProofJournalRecordInput {
  readonly phase: CcaProofJournalPhase
  readonly event: CcaProofJournalEvent
  readonly channels?: number
  readonly requests?: number
  readonly responses?: number
  readonly notifications?: number
  readonly bridges?: number
  readonly method?: CcaProofRpcMethod
  readonly outcome?: CcaProofRpcOutcome
  readonly resumeRequested?: boolean
  readonly resourceStatus?: "available" | "unavailable"
  readonly resourceTimers?: number
  readonly resourceSockets?: number
  readonly resourcePipes?: number
  readonly resourceProcesses?: number
  readonly resourceFilesystem?: number
  readonly resourceOther?: number
}

export type CcaProofJournalObserver = (input: CcaProofJournalRecordInput) => void

export interface CcaProofJournal {
  readonly failed: boolean
  readonly record: CcaProofJournalObserver
  readonly close: () => void
}

export class CcaProofJournalError extends Error {
  constructor() {
    super("CCA proof status journal failed")
    this.name = "CcaProofJournalError"
  }
}

const phases = new Set<string>(ccaProofJournalPhases)
const events = new Set<string>(["started", "completed", "failed", "observed"])
const countNames = [
  "channels",
  "requests",
  "responses",
  "notifications",
  "bridges",
  "resourceTimers",
  "resourceSockets",
  "resourcePipes",
  "resourceProcesses",
  "resourceFilesystem",
  "resourceOther",
] as const
const methods = new Set<string>(ccaProofRpcMethods)
const outcomes = new Set<string>(ccaProofRpcOutcomes)
const resourceStatuses = new Set<string>(["available", "unavailable"])
const journalMaxBytes = 64 * 1024
const maxCount = 1_000_000_000
const maxElapsedMs = 86_400_000

function boundedCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maxCount
    ? value
    : undefined
}

export function createCcaProofJournal(filePath: string): CcaProofJournal {
  if (!path.isAbsolute(filePath)) {
    throw new CcaProofJournalError()
  }
  let descriptor: number
  try {
    if (!statSync(path.dirname(filePath)).isDirectory()) throw new CcaProofJournalError()
    descriptor = openSync(filePath, "wx", 0o600)
  } catch {
    throw new CcaProofJournalError()
  }

  const startedAt = performance.now()
  let bytesWritten = 0
  let closed = false
  let failed = false
  let sequence = 0

  const record: CcaProofJournalObserver = (input) => {
    if (closed || failed) {
      failed = true
      return
    }
    if (
      input === null ||
      typeof input !== "object" ||
      typeof input.phase !== "string" ||
      !phases.has(input.phase) ||
      typeof input.event !== "string" ||
      !events.has(input.event)
    ) {
      failed = true
      return
    }
    const elapsedMs = Math.min(maxElapsedMs, Math.max(0, Math.round(performance.now() - startedAt)))
    const output: Record<string, number | string | boolean> = {
      seq: sequence + 1,
      phase: input.phase,
      event: input.event,
      elapsedMs,
    }
    const closedSets = [
      ["method", methods],
      ["outcome", outcomes],
    ] as const
    for (const [name, allowed] of closedSets) {
      const value: unknown = input[name]
      if (value === undefined) continue
      if (typeof value !== "string" || !allowed.has(value)) {
        failed = true
        return
      }
      output[name] = value
    }
    if (input.resumeRequested !== undefined) {
      if (typeof input.resumeRequested !== "boolean" || input.method !== "initialize") {
        failed = true
        return
      }
      output.resumeRequested = input.resumeRequested
    }
    if (input.resourceStatus !== undefined) {
      if (typeof input.resourceStatus !== "string" || !resourceStatuses.has(input.resourceStatus)) {
        failed = true
        return
      }
      output.resourceStatus = input.resourceStatus
    }
    for (const name of countNames) {
      const value = input[name]
      if (value === undefined) continue
      const count = boundedCount(value)
      if (count === undefined) {
        failed = true
        return
      }
      if (input.resourceStatus === "unavailable" && name.startsWith("resource")) {
        failed = true
        return
      }
      output[name] = count
    }
    const bytes = Buffer.from(`${JSON.stringify(output)}\n`, "utf8")
    if (bytesWritten + bytes.byteLength > journalMaxBytes) {
      failed = true
      return
    }
    try {
      let offset = 0
      while (offset < bytes.byteLength) {
        const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset)
        if (written < 1) throw new CcaProofJournalError()
        offset += written
      }
      fsyncSync(descriptor)
    } catch {
      failed = true
      return
    }
    bytesWritten += bytes.byteLength
    sequence++
  }

  const close = () => {
    if (!closed) {
      closed = true
      try {
        closeSync(descriptor)
      } catch {
        failed = true
      }
    }
    if (failed) throw new CcaProofJournalError()
  }

  return {
    get failed() {
      return failed
    },
    record,
    close,
  }
}
