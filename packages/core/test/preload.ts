import path from "path"

process.env.YCODING_DB = ":memory:"
process.env.YCODING_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "models-dev.json")
process.env.YCODING_DISABLE_MODELS_FETCH = "true"
