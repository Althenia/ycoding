import { expect, test } from "bun:test"

test("Node lid bridge constructs without node:ffi and reports unsupported when loading fails", () => {
  const result = Bun.spawnSync(["node", "--input-type=module", "-e", `
    import Module from "node:module";
    const load = Module._load;
    let loads = 0;
    Module._load = function(id, ...args) {
      if (id === "node:ffi") { loads++; throw new Error("Unavailable FFI"); }
      return load.call(this, id, ...args);
    };
    const bridge = await import(${JSON.stringify(new URL("../src/util/clamshell-sleep-ffi.node.ts", import.meta.url).href)});
    if (loads !== 0) throw new Error("FFI loaded during construction");
    const result = bridge.setClamshellSleepDisabled(false);
    console.log(JSON.stringify({ result, loads }));
  `])
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout.toString())).toEqual({ result: { ok: false, code: -1, unsupported: true }, loads: process.platform === "darwin" ? 1 : 0 })
})
