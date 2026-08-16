export * as DiscoveryPrompt from "./discovery-prompt.js"

export const EXECUTE_DESCRIPTION = [
  "Execute a program in a restricted JavaScript language for calling the current Code Mode tool catalog.",
  "",
  'Discover tools at runtime with `return search({ query: "<intent + key nouns>" })`. Search results contain exact callable paths, descriptions, and TypeScript signatures. Copy a returned path exactly in a later execution; do not infer or normalize tool names.',
  "",
  "Call tools with `await tools.<namespace>.<tool>(input)` or the exact bracket notation returned by search. Run independent calls with `Promise.all`, await every call whose completion matters, and return only the fields needed from structured results.",
  "",
  "The language supports common JavaScript data operations, functions, control flow, selected standard-library methods, and awaited tool calls. Modules, imports, classes, generators, timers, fetch, eval, prototype access, and unlisted methods are unavailable.",
  "",
  "Only tools returned by runtime search or already known from the same execution context are available. Catalog contents may change without changing this tool definition.",
].join("\n")
