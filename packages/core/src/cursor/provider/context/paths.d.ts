export type HostPathEnv = NodeJS.ProcessEnv;
/** Structural host-path capability installed before an unchanged provider loads. */
export declare const HOST_PATH_BRIDGE: unique symbol;
export type OpenCodePathBridge = {
    projectConfigDirs: (workspaceRoot: string) => string[];
    globalConfigDirs: () => string[];
    /** Optional host-owned durable data root; absent means native OpenCode defaults. */
    globalDataDir?: () => string;
    /** Optional host-owned cache root; absent means native OpenCode defaults. */
    globalCacheDir?: () => string;
    configFileNames?: string[];
};
export declare function opencodeProjectConfigDirs(workspaceRoot: string): string[];
export declare function opencodeGlobalConfigDirs(): string[];
export declare function opencodeConfigFileNames(): string[];
/**
 * Pin the process-wide cache root. Highest precedence for {@link opencodeGlobalCacheDir}.
 * Use for host-injected `Path.cache` or an explicit `createCursor({ cacheDir })`.
 */
export declare function setHostCacheDirOverride(dir: string | undefined): void;
export declare function getHostCacheDirOverride(): string | undefined;
/** Resolve the native OpenCode cache root when no host bridge is installed. */
export declare function resolveHostCacheDir(env?: HostPathEnv): string;
/** Native OpenCode global config dir. */
export declare function opencodeGlobalConfigDir(): string;
/**
 * Host global cache dir for Cursor project metadata + model/version caches.
 *
 * Precedence:
 * 1. {@link setHostCacheDirOverride} / `createCursor({ cacheDir })` (host `Path.cache`)
 * 2. An injected structural host path bridge
 * 3. Native OpenCode XDG defaults ({@link resolveHostCacheDir})
 */
export declare function opencodeGlobalCacheDir(): string;
/** Native OpenCode global data root. */
export declare function opencodeGlobalDataDir(env?: HostPathEnv): string;
/** Host-portable durable data root; falls back to native OpenCode. */
export declare function hostGlobalDataDir(env?: HostPathEnv): string;
/**
 * Directory for host plan files — always `<hostGlobalDataDir()>/plans`, and
 * never inside the user's repository.
 *
 * OpenCode's own `Session.plan` branches on VCS and puts plans in the worktree
 * (`<worktree>/.opencode/plans`) for a git project. The provider deliberately
 * does *not* mirror that branch. Writing there means a throwaway plan lands in
 * the user's tree untracked-but-unignored, and — because OpenCode installs
 * `@opencode-ai/plugin` into every `.opencode` directory it discovers walking up
 * from the cwd — creating that directory also bootstraps a project-local
 * `node_modules`. The provider must add nothing to a repository it did not
 * already contain.
 *
 * The global-data location is not a degraded fallback: it is the branch OpenCode
 * itself uses when there is no VCS, and its plan agent allow-lists that path for
 * `edit` / `external_directory` alongside the in-worktree one. {@link
 * hostGlobalDataDir} carries an optional injected host translation; without a
 * bridge it is the native OpenCode data root.
 */
export declare function hostPlansDir(_workspaceRoot?: string): string;
/**
 * Cursor-compatible path slug (`/Users/a/b` → `Users-a-b`).
 * Used for per-workspace metadata under the host cache.
 */
export declare function slugifyWorkspacePath(workspaceRoot: string): string;
/**
 * Cursor-style project metadata root for a workspace.
 * Lives at `<host-cache>/projects/<slug>/` under the resolved OpenCode/host cache root.
 *
 * This is what Cursor's RequestContextEnv.project_folder / MCP
 * workspace_project_dir point at — agent-tools, terminals, transcripts, etc.
 * Must NOT be the git workspace, or those dumps land in the repo.
 */
export declare function opencodeProjectDir(workspaceRoot: string): string;
/** Ensure {@link opencodeProjectDir} exists (mode 0o700) and return it. */
export declare function ensureOpencodeProjectDir(workspaceRoot: string): string;
export declare function resolveHomeRelative(p: string): string;
