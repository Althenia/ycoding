import type { LogSink } from "../context/log"

export function logProcessWarnings(log: LogSink) {
  const defaults = process.listeners("warning").filter((listener) => listener.name === "onWarning")
  for (const listener of defaults) process.off("warning", listener)
  const onWarning = (warning: Error) =>
    log("warn", "Node process warning", {
      name: warning.name,
      message: warning.message,
      stack: warning.stack,
    })
  process.on("warning", onWarning)
  return () => {
    process.off("warning", onWarning)
    for (const listener of defaults) process.on("warning", listener)
  }
}
