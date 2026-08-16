#!/usr/bin/env bun

import { InstallationVersion } from "@ycoding-ai/core/installation/version"
import { TuiCommand } from "./commands/tui"
import { Runtime } from "./framework/runtime"
import { main } from "./main"

const handlers = Runtime.handlers(TuiCommand, {
  $: () => import("./commands/handlers/tui"),
  serve: () => import("./commands/handlers/tui-serve"),
})
main(Runtime.run(TuiCommand, handlers, { version: InstallationVersion }))
