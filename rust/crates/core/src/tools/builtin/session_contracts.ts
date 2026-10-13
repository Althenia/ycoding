import path from "node:path"

const root = process.argv[2]
if (!root) throw new Error("Supply the TypeScript source checkout")
const { Schema } = await import(Bun.resolveSync("effect", path.join(root, "packages/core")))
const schema = (value: unknown, definitions = false) => {
  const document = Schema.toJsonSchemaDocument(value)
  return {
    ...document.schema,
    ...(definitions || Object.keys(document.definitions).length ? { $defs: document.definitions } : {}),
  }
}
const analyzer = (await import(path.join(root, "packages/core/src/session/runner/image-analyzer.ts"))).ImageAnalyzer
await Bun.write(
  path.join(import.meta.dir, "image-analyzer.json"),
  JSON.stringify({
    prompt: analyzer.STANDARD_IMAGE_ANALYSIS_PROMPT,
    example: analyzer.IMAGE_ANALYSIS_TOON_EXAMPLE,
    defaultSessionSystem: await Bun.file(path.join(root, "packages/core/src/session/runner/prompt/base.txt")).text(),
  }) + "\n",
)
for (const [file, exported] of [
  ["subagent", "SubagentTool"],
  ["subagent-control", "SubagentControlTool"],
  ["subagent-report", "SubagentReportTool"],
  ["goal", "GoalTool"],
  ["question", "QuestionTool"],
  ["decision", "DecisionTool"],
  ["todowrite", "TodoWriteTool"],
  ["task-complete", "TaskCompleteTool"],
]) {
  const source = path.join(root, "packages/core/src/tool", `${file}.ts`)
  const module = (await import(source))[exported]
  const content = await Bun.file(source).text()
  const description =
    module.description ??
    JSON.parse(content.slice(content.indexOf("Tool.make({")).match(/description:\s*("(?:\\.|[^"\\])*")/)?.[1] ?? "null")
  if (typeof description !== "string") throw new Error(`Missing description: ${file}`)
  const input = module.Input ?? Schema.Struct({})
  const output = module.Output ?? Schema.Struct({ recorded: Schema.Literal(true) })
  await Bun.write(
    path.join(import.meta.dir, `${file}.tool.json`),
    JSON.stringify({
      name: module.name ?? "task_complete",
      description,
      inputSchema: schema(input, file === "decision"),
      outputSchema: schema(output, file === "decision"),
    }) + "\n",
  )
}
