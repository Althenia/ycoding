import { appendFileSync } from "node:fs"
import { Arborist } from "@npmcli/arborist"
import { PluginLoader } from "../src/plugin-host/loader"

const log = process.env.PLUGIN_INSTALL_LOG!
const reify = Arborist.prototype.reify
Arborist.prototype.reify = async function (this: Arborist, ...args: Parameters<typeof reify>) {
  appendFileSync(log, `start ${process.pid}\n`)
  await new Promise((resolve) => setTimeout(resolve, 600))
  try {
    return await reify.apply(this, args)
  } finally {
    appendFileSync(log, `end ${process.pid}\n`)
  }
}

console.log(await PluginLoader.install(process.env.PLUGIN_INSTALL_SPEC!, process.env.PLUGIN_INSTALL_CACHE!, false))
