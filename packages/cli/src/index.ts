#!/usr/bin/env bun

import { InstallationVersion } from "@ycoding-ai/core/installation/version"
import { Commands } from "./commands/commands"
import { Runtime } from "./framework/runtime"
import { main } from "./main"

const handlers = Runtime.handlers(Commands, {
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
  pair: () => import("./commands/handlers/pair"),
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
