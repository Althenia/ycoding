import type { ElectrobunConfig } from "electrobun/bun"
import { applicationName, preparedVersion } from "./script/app-bundle"

export default {
  app: { name: applicationName, identifier: "app.ycoding.desktop", get version() { return preparedVersion(new URL("./runtime/backend.json", import.meta.url)) } },
  build: {
    bun: { entrypoint: "src/bun/index.ts", format: "esm", minify: false, sourcemap: "external" },
    copy: { dist: "views/mainview", runtime: "runtime" },
    mac: { codesign: process.env.ELECTROBUN_DEVELOPER_ID !== undefined, createDmg: false, notarize: false, icons: "icon.iconset" },
  },
  scripts: { postBuild: "script/app-bundle.ts", postWrap: "script/app-bundle.ts" },
} satisfies ElectrobunConfig
