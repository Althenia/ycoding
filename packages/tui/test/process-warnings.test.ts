import { expect, test } from "bun:test"

test("Node warnings reach the TUI log without raw stderr and restore native handling afterward", async () => {
  const child = Bun.spawn(
    [
      "node",
      "--input-type=module",
      "-e",
      `
    import { logProcessWarnings } from ${JSON.stringify(new URL("../src/util/process-warnings.ts", import.meta.url).href)};
    const original = process.listeners("warning");
    const observed = [];
    const observer = warning => observed.push(warning.message);
    process.on("warning", observer);
    const logs = [];
    const dispose = logProcessWarnings((level, message, tags) => logs.push({ level, message, tags }));
    process.emitWarning("Synthetic listener warning", { type: "MaxListenersExceededWarning" });
    process.emitWarning("Synthetic deprecation warning", { type: "DeprecationWarning" });
    await new Promise(resolve => setImmediate(resolve));
    dispose();
    process.off("warning", observer);
    const restored = original.every(listener => process.listeners("warning").includes(listener));
    process.emitWarning("Native warning after TUI exit");
    await new Promise(resolve => setImmediate(resolve));
    console.log(JSON.stringify({ logs, observed, restored }));
  `,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(exit, stderr).toBe(0)
  const result = JSON.parse(stdout)
  expect(result.restored).toBe(true)
  expect(result.observed).toEqual(["Synthetic listener warning", "Synthetic deprecation warning"])
  expect(result.logs).toMatchObject([
    {
      level: "warn",
      message: "Node process warning",
      tags: { name: "MaxListenersExceededWarning", message: "Synthetic listener warning" },
    },
    {
      level: "warn",
      message: "Node process warning",
      tags: { name: "DeprecationWarning", message: "Synthetic deprecation warning" },
    },
  ])
  expect(stderr).not.toContain("Synthetic listener warning")
  expect(stderr).not.toContain("Synthetic deprecation warning")
  expect(stderr).toContain("Native warning after TUI exit")
})
