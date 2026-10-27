import { runRegexProcess } from "@ycoding-ai/core/tool/regex-process"

if (!runRegexProcess()) {
  await import("./plugin-runtime.promise")
  await import("./plugin-runtime.effect")

  process.stdout.on("error", (error) => {
    if ("code" in error && error.code === "EPIPE") return
    throw error
  })

  await import("../index")
}
