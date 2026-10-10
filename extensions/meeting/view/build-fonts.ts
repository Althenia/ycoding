import path from "node:path"
import { format } from "prettier"

const directory = import.meta.dir
const faces = [
  { file: "Geist.woff2", name: "Geist" },
  { file: "GeistMono.woff2", name: "Geist Mono" },
]
const license = await Bun.file(path.join(directory, "../../../assets/brand/fonts/OFL.txt")).text()
const styles = await Promise.all(
  faces.map(async (face) => {
    const bytes = await Bun.file(path.join(directory, "../../../assets/brand/fonts", face.file)).bytes()
    return `@font-face {\n  font-family: "${face.name}";\n  font-style: normal;\n  font-weight: 100 900;\n  font-display: swap;\n  src: url("data:font/woff2;base64,${Buffer.from(bytes).toString("base64")}") format("woff2");\n}`
  }),
)
await Bun.write(
  path.join(directory, "fonts.css"),
  await format(`/*\n${license}*/\n${styles.join("\n")}\n`, { parser: "css" }),
)
