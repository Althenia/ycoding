import { homedir } from "node:os";
import path from "node:path";
import { trace } from "../debug.js";
import { ensureCursorProjectDir } from "./paths.js";
export function buildEnv(workspaceRoot) {
    const cwd = path.resolve(workspaceRoot);
    let timeZone = "UTC";
    try {
        timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    }
    catch {
        /* keep UTC */
    }
    const home = homedir();
    const osVersion = (() => {
        const p = process.platform;
        const r = process.release?.version;
        return r ? `${p} ${r}` : p;
    })();
    // Cursor's project_folder is a metadata root (agent-tools, terminals, …),
    // not the git workspace. Keep dumps under the Cursor cache.
    const projectFolder = ensureCursorProjectDir(cwd);
    // process_working_directory must match the workspace, not the host process
    // cwd. The Location-scoped workspace path is authoritative.
    const env = {
        os_version: osVersion,
        workspace_paths: [cwd],
        shell: process.env.SHELL || "/bin/bash",
        sandbox_enabled: false,
        sandbox_supported: false,
        time_zone: timeZone,
        project_folder: projectFolder,
        terminals_folder: path.join(projectFolder, "terminals"),
        agent_transcripts_folder: path.join(projectFolder, "agent-transcripts"),
        process_working_directory: cwd,
        is_working_dir_home_dir: cwd === path.resolve(home),
    };
    trace("buildEnv: workspace metadata set");
    return env;
}
/**
 * Real workspace root for path resolution (edits, reads, …).
 * Uses `env.workspace_paths[0]` — never `project_folder` /
 * `mcp_file_system_options.workspace_project_dir` (those are Cursor metadata roots).
 */
export function workspaceRootFromRequestContext(requestContext) {
    const env = requestContext?.env;
    if (env && typeof env === "object") {
        const paths = env.workspace_paths;
        if (Array.isArray(paths) && typeof paths[0] === "string" && paths[0].trim()) {
            const root = path.resolve(paths[0]);
            trace("workspaceRootFromRequestContext: using workspace path");
            return root;
        }
    }
    const fallback = process.cwd();
    trace("workspaceRootFromRequestContext: using process directory");
    return fallback;
}
