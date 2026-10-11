#!/usr/bin/env bun

import { InstallationVersion } from "@ycoding-ai/core/installation/version"
import { TuiCommand } from "./commands/tui"
import { Runtime } from "./framework/runtime"
import { main } from "./main"

const handlers = Runtime.handlers(TuiCommand, {
  $: () => import("./commands/handlers/tui"),
  run: () => import("./commands/handlers/run"),
  update: () => import("./commands/handlers/update"),
  meeting: () => import("./commands/handlers/meeting"),
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
