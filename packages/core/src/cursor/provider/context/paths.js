import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Global } from "../../../global.ts";
import { trace } from "../debug.js";
export function isProjectDiscoveryDisabled() {
    return [process.env.YCODING_CONFIG_PROJECT_DISABLE, process.env.YCODING_DISABLE_PROJECT_CONFIG]
        .some((value) => value === "true" || value === "1");
}
export function ycodingProjectConfigDirs(workspaceRoot) {
    if (isProjectDiscoveryDisabled())
        return [];
    const dirs = [];
    for (let dir = path.resolve(workspaceRoot);; dir = path.dirname(dir)) {
        dirs.unshift(path.join(dir, ".ycoding"));
        if (dir === path.dirname(dir))
            return dirs;
    }
}
export function ycodingGlobalConfigDirs() {
    return [ycodingGlobalConfigDir()];
}
export function ycodingConfigFileNames() {
    return ["ycoding.json", "ycoding.jsonc"];
}
let hostCacheDirOverride;
export function setHostCacheDirOverride(dir) {
    hostCacheDirOverride = dir && dir.length > 0 ? path.resolve(dir) : undefined;
}
export function ycodingGlobalConfigDir() {
    return process.env.YCODING_CONFIG_DIR ?? Global.Path.config;
}
export function cursorCacheDir() {
    return hostCacheDirOverride ?? path.join(Global.Path.cache, "cursor");
}
export function hostPlansDir(_workspaceRoot) {
    return path.join(Global.Path.data, "plans");
}
/**
 * Cursor-compatible path slug (`/Users/a/b` → `Users-a-b`).
 * Used for per-workspace metadata under the host cache.
 */
export function slugifyWorkspacePath(workspaceRoot) {
    const resolved = path.resolve(workspaceRoot);
    return resolved
        .replace(/[^a-zA-Z0-9]/g, "-")
        .split("-")
        .filter(Boolean)
        .join("-");
}
/**
 * Cursor-style project metadata root for a workspace.
 * Lives at `<host-cache>/projects/<slug>/` under the YCoding cache root.
 *
 * This is what Cursor's RequestContextEnv.project_folder / MCP
 * workspace_project_dir point at — agent-tools, terminals, transcripts, etc.
 * Must NOT be the git workspace, or those dumps land in the repo.
 */
export function cursorProjectDir(workspaceRoot) {
    const projectsRoot = path.join(cursorCacheDir(), "projects");
    const slug = slugifyWorkspacePath(workspaceRoot);
    let dir = path.join(projectsRoot, slug);
    // Mirror Cursor's long-path guard so nested agent-tools paths stay usable.
    if (dir.length > 92) {
        const hash = createHash("sha256").update(dir).digest("hex").slice(0, 7);
        dir = `${dir.slice(0, Math.min(84, dir.length))}-${hash}`;
    }
    return dir;
}
export function ensureCursorProjectDir(workspaceRoot) {
    const resolved = path.resolve(workspaceRoot);
    const dir = cursorProjectDir(resolved);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    trace("project-dir: ensured");
    return dir;
}
export function resolveHomeRelative(p) {
    if (p.startsWith("~/"))
        return path.join(homedir(), p.slice(2));
    return p;
}
