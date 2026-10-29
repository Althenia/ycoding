import { writeSync } from "node:fs"
import {
  createCcaProofJournal,
  CcaProofJournalError,
  type CcaProofJournal,
} from "../../src/remote-control/cca-proof-journal"
import { runCcaProofLifecycle } from "../../src/remote-control/cca-proof-lifecycle"

const [mode, statusArgument] = process.argv.slice(2)
const statusFile = statusArgument === "-" ? undefined : statusArgument

class SyntheticAbort extends Error {}

function classify(error: unknown) {
  if (error instanceof CcaProofJournalError) return { message: error.message, exitCode: 1 }
  if (error instanceof SyntheticAbort) return { message: "synthetic aborted", exitCode: 0 }
  return { message: "synthetic fixed failure", exitCode: 3 }
}

function observedClose(journal: CcaProofJournal, failClose: boolean): CcaProofJournal {
  return {
    get failed() {
      return journal.failed
    },
    record: journal.record,
    close: () => {
      try {
        journal.close()
      } finally {
        writeSync(1, "synthetic-journal-closed\n")
      }
      if (failClose) throw new CcaProofJournalError()
    },
  }
}

function probeBeforeExit() {
  let emissions = 0
  process.on("beforeExit", () => {
    emissions++
    writeSync(1, `synthetic-before-exit=${emissions} listeners=${process.listenerCount("beforeExit")}\n`)
    if (emissions === 1) setImmediate(() => {})
  })
}

await runCcaProofLifecycle({
  classify,
  main: async (lifecycle) => {
    const opened = statusFile === undefined ? undefined : createCcaProofJournal(statusFile)
    const journal = opened === undefined ? undefined : observedClose(opened, mode === "exit-close-failure")
    if (journal !== undefined) lifecycle.attach(journal)
    journal?.record({ phase: "script", event: "started" })
    if (mode === "main-failure") throw new Error("synthetic-raw-failure-detail")
    if (mode === "aborted-close-failure" || mode === "primary-close-failure" || mode === "journal-failed") {
      journal?.record({ phase: "synthetic-invalid" } as never)
    }
    if (mode === "aborted-close-failure") throw new SyntheticAbort("synthetic-raw-abort-detail")
    if (mode === "primary-close-failure") throw new Error("synthetic-raw-failure-detail")
    if (mode === "journal-failed") return
    if (mode !== "success" && mode !== "exit-close-failure") throw new Error("Unknown lifecycle fixture mode")
    journal?.record({ phase: "script-completion", event: "completed" })
    probeBeforeExit()
    console.log("synthetic-summary")
  },
})
