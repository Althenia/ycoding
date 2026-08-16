#!/usr/bin/env bun

import { fileURLToPath } from "node:url"
import { fetchModelsSnapshot, writeModelsSnapshot } from "./models-snapshot"

const baseUrl = (process.env.YCODING_MODELS_URL || "https://models.dev").replace(/\/$/, "")
const output = fileURLToPath(new URL("./models-dev.snapshot.json", import.meta.url))
const text = await fetchModelsSnapshot(`${baseUrl}/api.json`)
await writeModelsSnapshot(output, text)
console.log(`Updated models.dev snapshot: ${output}`)
