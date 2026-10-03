import path from "path"
import { ModelsDev } from "@ycoding-ai/core/models-dev"

export const fixtureModels = [
  ModelsDev.node,
  ModelsDev.configured({ file: path.join(import.meta.dir, "../plugin/fixtures/models-dev.json"), fetch: false }),
] as const
