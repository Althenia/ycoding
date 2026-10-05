/**
 * Session-scoped workspace directory, bounded for long-lived servers.
 */
export declare function markSessionDirectory(sessionID: string, directory: string | undefined): void;
export declare function getSessionDirectory(sessionID: string | undefined): string | undefined;
export declare function clearSessionDirectories(): void;
/**
 * Active session workspace directory from YCoding request headers.
 * Values may be URI-encoded.
 */
export declare function ycodingDirectoryHeader(headers: Record<string, string | undefined> | undefined): string | undefined;
/**
 * Resolve the workspace root for a model turn.
 * Prefer the per-request header, then the session mark, then static options/cwd.
 */
export declare function resolveSessionWorkspaceRoot(input: {
    sessionKey?: string;
    headers?: Record<string, string | undefined>;
    workspaceRoot?: string;
    cwd?: string;
}): string;
