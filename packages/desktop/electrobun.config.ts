import type { ElectrobunConfig } from "electrobun/bun"

export default {
  app: { name: "YCoding Desktop", identifier: "app.ycoding.desktop", version: "1.18.4" },
  build: {
    bun: { entrypoint: "src/bun/index.ts", format: "esm", minify: false, sourcemap: "external" },
    copy: { dist: "views/mainview", runtime: "runtime" },
    mac: { codesign: false, createDmg: false, notarize: false, icons: "icon.iconset" },
  },
} satisfies ElectrobunConfig
