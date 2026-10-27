#!/usr/bin/env bun

import { runRegexProcess } from "@ycoding-ai/core/tool/regex-process"

if (!runRegexProcess()) {
  const { InstallationVersion } = await import("@ycoding-ai/core/installation/version")
  const { TuiCommand } = await import("./commands/tui")
  const { Runtime } = await import("./framework/runtime")
  const { main } = await import("./main")

  const handlers = Runtime.handlers(TuiCommand, {
    coordination: () => import("./commands/handlers/coordination"),
    $: () => import("./commands/handlers/tui"),
    run: () => import("./commands/handlers/run"),
    update: () => import("./commands/handlers/update"),
    meeting: () => import("./commands/handlers/meeting"),
    "keep-awake": {
      setup: () => import("./commands/handlers/keep-awake/setup"),
    },
    service: {
      start: () => import("./commands/handlers/service/start"),
      restart: () => import("./commands/handlers/service/restart"),
      status: () => import("./commands/handlers/service/status"),
      stop: () => import("./commands/handlers/service/stop"),
      get: () => import("./commands/handlers/service/get"),
      set: () => import("./commands/handlers/service/set"),
      unset: () => import("./commands/handlers/service/unset"),
    },
    remote: {
      enroll: () => import("./commands/handlers/remote/enroll"),
      connect: () => import("./commands/handlers/remote/connect"),
      disconnect: () => import("./commands/handlers/remote/disconnect"),
      status: () => import("./commands/handlers/remote/status"),
      sessions: () => import("./commands/handlers/remote/sessions"),
    },
    serve: () => import("./commands/handlers/tui-serve"),
  })
  main(Runtime.run(TuiCommand, handlers, { version: InstallationVersion }))
}
