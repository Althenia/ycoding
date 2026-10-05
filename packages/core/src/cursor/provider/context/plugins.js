import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { ycodingGlobalConfigDirs, ycodingProjectConfigDirs } from "./paths.js";
async function listLocalPlugins(dir) {
    try {
        await stat(dir);
    }
    catch {
        return [];
    }
    const out = [];
    let entries;
    try {
        entries = await readdir(dir);
    }
    catch {
        return [];
    }
    entries.sort();
    for (const name of entries) {
        if (!/\.(m?[jt]s)$/.test(name))
            continue;
        const full = path.join(dir, name);
        out.push({ id: name.replace(/\.(m?[jt]s)$/, ""), source: "local", path: full });
    }
    return out;
}
export async function collectPlugins(workspaceRoot, config) {
    const out = [];
    const seen = new Set();
    for (const entry of Array.isArray(config.plugins) ? config.plugins : []) {
        const id = typeof entry === "string" ? entry : entry?.package;
        if (typeof id !== "string" || id.startsWith("-"))
            continue;
        if (!id || seen.has(id))
            continue;
        seen.add(id);
        out.push({ id, source: "npm" });
    }
    for (const configDir of ycodingProjectConfigDirs(workspaceRoot)) {
        for (const dir of ["plugin", "plugins"]) {
            for (const p of await listLocalPlugins(path.join(configDir, dir))) {
                if (seen.has(p.id))
                    continue;
                seen.add(p.id);
                out.push(p);
            }
        }
    }
    for (const configDir of ycodingGlobalConfigDirs()) {
        for (const dir of ["plugin", "plugins"]) {
            for (const p of await listLocalPlugins(path.join(configDir, dir))) {
                if (seen.has(p.id))
                    continue;
                seen.add(p.id);
                out.push(p);
            }
        }
    }
    return out;
}
