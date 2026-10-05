/**
 * Session-scoped workspace directory, bounded for long-lived servers.
 */
import path from "node:path";
const MAX_TRACKED_SESSIONS = 256;
const sessionDirectories = new Map();
export function markSessionDirectory(sessionID, directory) {
    if (!sessionID || !directory)
        return;
    // Re-insert to keep insertion order meaningful for the eviction below.
    sessionDirectories.delete(sessionID);
    sessionDirectories.set(sessionID, directory);
    while (sessionDirectories.size > MAX_TRACKED_SESSIONS) {
        const oldest = sessionDirectories.keys().next().value;
        if (oldest === undefined)
            break;
        sessionDirectories.delete(oldest);
    }
}
export function getSessionDirectory(sessionID) {
    return typeof sessionID === "string" ? sessionDirectories.get(sessionID) : undefined;
}
export function clearSessionDirectories() {
    sessionDirectories.clear();
}
/**
 * Active session workspace directory from YCoding request headers.
 * Values may be URI-encoded.
 */
export function ycodingDirectoryHeader(headers) {
    if (!headers)
        return undefined;
    const raw = headers["x-ycoding-directory"] ?? headers["X-Ycoding-Directory"];
    if (typeof raw !== "string" || raw.trim().length === 0)
        return undefined;
    const trimmed = raw.trim();
    try {
        return decodeURIComponent(trimmed);
    }
    catch {
        return trimmed;
    }
}
/**
 * Resolve the workspace root for a model turn.
 * Prefer the per-request header, then the session mark, then static options/cwd.
 */
export function resolveSessionWorkspaceRoot(input) {
    return path.resolve(ycodingDirectoryHeader(input.headers) ??
        getSessionDirectory(input.sessionKey) ??
        (input.workspaceRoot || input.cwd || process.cwd()));
}
