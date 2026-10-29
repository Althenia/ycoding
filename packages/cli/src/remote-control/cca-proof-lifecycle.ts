import { CcaProofJournalError, type CcaProofJournal } from "./cca-proof-journal"

export interface CcaProofLifecycle {
  readonly attach: (journal: CcaProofJournal) => void
}

export interface CcaProofFailure {
  readonly message: string
  readonly exitCode: number
}

export type CcaProofResourceSnapshot =
  | {
      readonly resourceStatus: "available"
      readonly resourceTimers: number
      readonly resourceSockets: number
      readonly resourcePipes: number
      readonly resourceProcesses: number
      readonly resourceFilesystem: number
      readonly resourceOther: number
    }
  | { readonly resourceStatus: "unavailable" }

type ResourceBucket =
  | "resourceTimers"
  | "resourceSockets"
  | "resourcePipes"
  | "resourceProcesses"
  | "resourceFilesystem"
  | "resourceOther"

const resourceBuckets = new Map<string, ResourceBucket>([
  ["Timeout", "resourceTimers"],
  ["Immediate", "resourceTimers"],
  ["TCPSocketWrap", "resourceSockets"],
  ["TCPServerWrap", "resourceSockets"],
  ["ConnectWrap", "resourceSockets"],
  ["TLSWrap", "resourceSockets"],
  ["UDPWrap", "resourceSockets"],
  ["PipeWrap", "resourcePipes"],
  ["PipeServerWrap", "resourcePipes"],
  ["PipeConnectWrap", "resourcePipes"],
  ["TTYWrap", "resourcePipes"],
  ["ProcessWrap", "resourceProcesses"],
  ["FSReqCallback", "resourceFilesystem"],
  ["FSReqPromise", "resourceFilesystem"],
  ["FSEventWrap", "resourceFilesystem"],
  ["StatWatcher", "resourceFilesystem"],
  ["FileHandle", "resourceFilesystem"],
])
const maxResourceCount = 1_000_000_000

export function ccaProofResourceSnapshot(target: {
  readonly versions: { readonly bun?: string }
  readonly getActiveResourcesInfo?: () => unknown
}): CcaProofResourceSnapshot {
  if (target.versions.bun !== undefined || typeof target.getActiveResourcesInfo !== "function") {
    return { resourceStatus: "unavailable" }
  }
  let names: unknown
  try {
    names = target.getActiveResourcesInfo()
  } catch {
    return { resourceStatus: "unavailable" }
  }
  if (!Array.isArray(names)) return { resourceStatus: "unavailable" }
  const counts: Record<ResourceBucket, number> = {
    resourceTimers: 0,
    resourceSockets: 0,
    resourcePipes: 0,
    resourceProcesses: 0,
    resourceFilesystem: 0,
    resourceOther: 0,
  }
  for (const name of names) {
    const bucket = (typeof name === "string" ? resourceBuckets.get(name) : undefined) ?? "resourceOther"
    counts[bucket] = Math.min(maxResourceCount, counts[bucket] + 1)
  }
  return { resourceStatus: "available", ...counts }
}

function failExitCode(exitCode: number) {
  const current = Number(process.exitCode ?? 0)
  if (!Number.isInteger(current) || current === 0) process.exitCode = exitCode
}

export async function runCcaProofLifecycle(input: {
  readonly main: (lifecycle: CcaProofLifecycle) => Promise<void>
  readonly classify: (error: unknown) => CcaProofFailure
}): Promise<void> {
  const attached: { journal?: CcaProofJournal } = {}
  let failure: CcaProofFailure | undefined
  try {
    await input.main({
      attach: (journal) => {
        attached.journal = journal
      },
    })
  } catch (error) {
    failure = input.classify(error)
  }
  const journal = attached.journal
  if (failure !== undefined) {
    try {
      journal?.close()
    } catch {
      if (failure.exitCode === 0) failure = input.classify(new CcaProofJournalError())
    }
    if (failure.exitCode !== 0) console.error(failure.message)
    process.exit(failure.exitCode)
  }
  if (journal === undefined) return
  const opened = journal
  const journalFailure = input.classify(new CcaProofJournalError())
  const recordTail = (phase: "main-returned" | "process-before-exit") => {
    try {
      opened.record({ phase, event: "observed", ...ccaProofResourceSnapshot(process) })
      return !opened.failed
    } catch {
      return false
    }
  }
  const closeTail = (recorded: boolean) => {
    let closed = recorded
    try {
      opened.close()
    } catch {
      closed = false
    }
    if (closed) return
    console.error(journalFailure.message)
    failExitCode(journalFailure.exitCode)
  }
  if (!recordTail("main-returned")) {
    closeTail(false)
    return
  }
  process.once("beforeExit", () => closeTail(recordTail("process-before-exit")))
}
