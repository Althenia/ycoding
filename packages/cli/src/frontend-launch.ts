import path from "node:path"

export function frontendAssetArguments(executable = process.execPath) {
  const name = path.basename(executable, path.extname(executable)).toLowerCase()
  return ["bun", "node", "nodejs"].includes(name) ? [] : ["--frontend-executable", executable]
}
