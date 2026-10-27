export * as DiscoveryPrompt from "./discovery-prompt.js"

export const EXECUTE_DESCRIPTION = [
  "Prefer execute for multiple calls, fanout, filtering, or aggregation, such as reading or grepping many files. A direct single full-output call remains supported.",
  "",
  'Discover tools at runtime with `return search({ query: "<intent + key nouns>" })`. Search results contain exact callable paths, descriptions, and TypeScript signatures. Copy a returned path exactly in a later execution; do not infer or normalize tool names.',
  "",
  "Call built-ins as `tools.<name>` and MCP tools as `tools.<server>.<tool>`, using the exact paths and signatures returned by search. The same approvals apply as direct calls. Run independent calls with `Promise.all`, await calls whose completion matters, and return only needed fields.",
  "",
  "The language supports common JavaScript data operations, functions, control flow, selected standard-library methods, and awaited tool calls. Modules, imports, classes, generators, timers, fetch, eval, prototype access, and unlisted methods are unavailable.",
  "",
  "Only tools returned by runtime search or already known from the same execution context are available. Catalog contents may change without changing this tool definition.",
].join("\n")
