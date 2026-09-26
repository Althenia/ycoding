export * as UpdateProgress from "./progress"

export type Event =
  | { readonly phase: "download"; readonly received: number; readonly total?: number }
  | { readonly phase: "verify" }
  | { readonly phase: "install" }

const megabytes = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1)

export function format(event: Event, width: number) {
  if (event.phase === "verify") return "Verifying checksum"
  if (event.phase === "install") return "Installing"
  if (!event.total) return `Downloading ${megabytes(event.received)} MB`
  const ratio = Math.min(1, event.received / event.total)
  const filled = Math.round(ratio * width)
  const total = megabytes(event.total)
  return `Downloading [${"█".repeat(filled)}${"░".repeat(width - filled)}] ${String(Math.floor(ratio * 100)).padStart(3)}% ${megabytes(event.received).padStart(total.length)}/${total} MB`
}

export function terminal(input: { write: (text: string) => void; interactive: boolean; width: number }) {
  let last: string | undefined
  let phase: Event["phase"] | undefined
  return {
    report: (event: Event) => {
      if (!input.interactive) {
        if (event.phase !== phase) input.write(`${event.phase === "download" ? "Downloading" : format(event, input.width)}\n`)
        phase = event.phase
        return
      }
      const line = format(event, input.width)
      if (line === last) return
      last = line
      input.write(`\r\x1b[2K${line}`)
    },
    end: () => {
      if (input.interactive && last !== undefined) input.write("\n")
    },
  }
}
