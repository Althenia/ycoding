export function ptyOutput() {
  const output: string[] = []
  const waiting = new Map<string, ReturnType<typeof Promise.withResolvers<string>>>()
  let failure: string | undefined
  return {
    data(data: Uint8Array) {
      output.push(Buffer.from(data).toString("utf8"))
      const text = output.join("")
      for (const [marker, reader] of waiting) {
        if (!text.includes(marker)) continue
        waiting.delete(marker)
        reader.resolve(text)
      }
    },
    exit(code: number) {
      failure = `PTY ended ${code}`
      for (const [marker, reader] of waiting) {
        reader.reject(new Error(`${failure} waiting for ${marker}; saw ${JSON.stringify(output.join(""))}`))
      }
      waiting.clear()
    },
    close() {
      failure = "terminal closed"
      for (const reader of waiting.values()) reader.reject(new Error("terminal closed"))
      waiting.clear()
    },
    async waitFor(marker: string) {
      const text = output.join("")
      if (text.includes(marker)) return text
      if (failure) throw new Error(`${failure} waiting for ${marker}; saw ${JSON.stringify(text)}`)
      const reader = Promise.withResolvers<string>()
      waiting.set(marker, reader)
      return reader.promise
    },
  }
}
