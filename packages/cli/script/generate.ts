import { fileURLToPath } from "node:url"
import { readModelsSnapshot } from "./models-snapshot"

const bundled = fileURLToPath(new URL("./models-dev.snapshot.json", import.meta.url))
export const modelsSource = process.env.MODELS_DEV_API_JSON || bundled

export const modelsData = await readModelsSnapshot(modelsSource)

console.log(`Loaded models.dev snapshot: ${modelsSource}`)
