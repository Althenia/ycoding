export type CollectedRule = {
    fullPath: string;
    content: string;
};
export type OpencodeJson = {
    instructions?: string[];
    permission?: unknown;
    plugin?: string[];
    plugins?: string[];
    mcp?: Record<string, unknown>;
};
export declare function findGitWorktree(start: string): Promise<string>;
/** Same truthy rule as OpenCode's Flag.OPENCODE_DISABLE_PROJECT_CONFIG. */
export declare function isProjectConfigDisabled(): boolean;
/** Fetch a remote instruction with one deadline covering headers and body. */
export declare function fetchRemoteInstruction(url: string, timeoutMs?: number): Promise<string | undefined>;
export declare function loadMergedConfig(workspaceRoot: string): Promise<OpencodeJson>;
/**
 * Collect OpenCode instruction files.
 */
export declare function collectRules(workspaceRoot: string): Promise<{
    rules: CollectedRule[];
    config: OpencodeJson;
    worktree: string;
}>;
