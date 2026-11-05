const state = globalThis as typeof globalThis & { __standalonePluginEvaluations?: number }
state.__standalonePluginEvaluations = (state.__standalonePluginEvaluations ?? 0) + 1
