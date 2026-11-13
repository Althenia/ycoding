#!/usr/bin/env bun

import { runRegexProcess } from "@ycoding-ai/core/tool/regex-process"

if (!runRegexProcess()) {
  const { InstallationVersion } = await import("@ycoding-ai/core/installation/version")
  const { TuiCommand } = await import("./commands/tui")
  const { Runtime } = await import("./framework/runtime")
  const { main } = await import("./main")

  const handlers = Runtime.handlers(TuiCommand, {
    api: () => import("./commands/handlers/api"),
    decision: {
      list: () => import("./commands/handlers/decision/list"),
      watch: () => import("./commands/handlers/decision/watch"),
    },
    coordination: () => import("./commands/handlers/coordination"),
    dots: {
      attach: () => import("./commands/handlers/dots/attach"),
      detach: () => import("./commands/handlers/dots/detach"),
      remove: () => import("./commands/handlers/dots/remove"),
      threads: () => import("./commands/handlers/dots/threads"),
      tasks: () => import("./commands/handlers/dots/tasks"),
      read: () => import("./commands/handlers/dots/read"),
      send: () => import("./commands/handlers/dots/send"),
      interrupt: () => import("./commands/handlers/dots/interrupt"),
      resume: () => import("./commands/handlers/dots/resume"),
      requests: () => import("./commands/handlers/dots/requests"),
      respond: () => import("./commands/handlers/dots/respond"),
    },
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
