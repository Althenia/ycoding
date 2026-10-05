import { createCursorLanguageModel } from "./language-model.js";
import { CURSOR_PROVIDER_ID } from "./shared.js";

export function createCursor(options) {
  return {
    languageModel(modelId) {
      return createCursorLanguageModel(modelId, options.name || CURSOR_PROVIDER_ID, options);
    },
  };
}
