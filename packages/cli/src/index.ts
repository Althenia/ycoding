#!/usr/bin/env bun

import { runRegexProcess } from "@ycoding-ai/core/tool/regex-process"

if (!runRegexProcess()) {
  const { InstallationVersion } = await import("@ycoding-ai/core/installation/version")
  const { Commands } = await import("./commands/commands")
  const { Runtime } = await import("./framework/runtime")
  const { main } = await import("./main")

  const handlers = Runtime.handlers(Commands, {
    decision: { list: () => import("./commands/handlers/decision/list") },
    coordination: () => import("./commands/handlers/coordination"),
    dots: {
      attach: () => import("./commands/handlers/dots/attach"),
    },
    $: () => import("./commands/handlers/default"),
    api: () => import("./commands/handlers/api"),
    auth: {
      connect: () => import("./commands/handlers/auth/connect"),
    },
    debug: {
      agents: () => import("./commands/handlers/debug/agents"),
    },
    console: {
      login: () => import("./commands/handlers/console/login"),
    },
    mcp: {
      serve: () => import("./commands/handlers/mcp/serve"),
      list: () => import("./commands/handlers/mcp/list"),
      add: () => import("./commands/handlers/mcp/add"),
      auth: () => import("./commands/handlers/mcp/auth"),
      logout: () => import("./commands/handlers/mcp/logout"),
    },
    plugin: {
      list: () => import("./commands/handlers/plugin/list"),
    },
    mini: () => import("./commands/handlers/mini"),
    run: () => import("./commands/handlers/run"),
    update: () => import("./commands/handlers/update"),
    meeting: () => import("./commands/handlers/meeting"),
    pair: () => import("./commands/handlers/pair"),
    remote: {
      enroll: () => import("./commands/handlers/remote/enroll"),
      connect: () => import("./commands/handlers/remote/connect"),
      disconnect: () => import("./commands/handlers/remote/disconnect"),
      status: () => import("./commands/handlers/remote/status"),
      sessions: () => import("./commands/handlers/remote/sessions"),
    },
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
    serve: () => import("./commands/handlers/serve"),
  })

  main(Runtime.run(Commands, handlers, { version: InstallationVersion }))
}
